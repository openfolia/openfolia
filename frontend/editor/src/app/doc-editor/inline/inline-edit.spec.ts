import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { toEditor } from '@openfolia/content-editor-model';
import type { Module } from '@openfolia/content-model/core';
import type { ShownConfig as ProjectConfig } from '../../i18n';

import { createEditorExtensions } from '../extensions';
import {
  applyLink,
  blockIds,
  completeHref,
  docTargets,
  linkRequest,
  parseKeys,
} from './inline-edit';
import { chipInfos, openLink } from './inline-views';

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;

const MODULE: Module = {
  schemaVersion: 1,
  id: 'own',
  title: 'Own',
  type: 'task',
  blocks: [
    {
      type: 'section',
      id: 'setup',
      title: [{ type: 'text', text: 'Setup' }],
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'xref', module: 'own', block: 'setup' },
            { type: 'xref', module: 'own', block: 'gone' },
            { type: 'xref', module: 'other', block: 'b' },
            { type: 'attribute', name: 'product' },
            { type: 'attribute', name: 'unknown' },
            { type: 'xref', module: 'own', block: 'p' },
            { type: 'xref', module: 'other', block: 'any-paragraph' },
            { type: 'xref', module: 'nowhere' },
          ],
        },
      ],
    },
  ],
} as unknown as Module;

function editorOf(module: Module = MODULE) {
  return new Editor({
    extensions: createEditorExtensions({ slashMenu: null, bubble: null }),
    content: toEditor(module),
  });
}

describe('link addresses', () => {
  it('are completed as typed: https:// when no scheme, mailto: for an e-mail address', () => {
    expect(completeHref(' example.com/a ')).toBe('https://example.com/a');
    expect(completeHref('team@example.com')).toBe('mailto:team@example.com');
    expect(completeHref('http://example.com')).toBe('http://example.com');
    // A scheme given stays, so a refused one is still refused.
    expect(completeHref('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(completeHref('')).toBe('');
    expect(completeHref('localhost:8080/x')).toBe('https://localhost:8080/x');
    expect(completeHref('example.com:8443')).toBe('https://example.com:8443');
    // A scheme with digits after it is still a scheme, refused as it was.
    expect(completeHref('javascript:1')).toBe('javascript:1');
    expect(completeHref('tel:123')).toBe('tel:123');
  });

  it('only one the model takes reaches the document, and only that one opens', () => {
    const editor = editorOf();
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 9, 12),
      ),
    );
    const request = linkRequest(editor.state);
    expect(request?.kind).toBe('link');
    if (request?.kind !== 'link') return;
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://example.com',
      'https://exa mple.com',
    ])
      expect(applyLink(editor, request, href, ''), href).toBe(false);
    let links = 0;
    editor.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'link')) links++;
    });
    expect(links).toBe(0);
    expect(applyLink(editor, request, 'https://example.com', '')).toBe(true);

    const open = vi.fn();
    const view = { dom: { ownerDocument: { defaultView: { open } } } };
    expect(openLink(view as never, 'javascript:alert(1)')).toBe(false);
    expect(openLink(view as never, 'https://example.com')).toBe(true);
    expect(open).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
    editor.destroy();
  });
});

describe('key combinations', () => {
  it('are read from what is typed, a doubled plus being the plus key', () => {
    expect(parseKeys('Ctrl + Shift + S')).toEqual(['Ctrl', 'Shift', 'S']);
    expect(parseKeys('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(parseKeys('Ctrl + + S')).toBeNull();
    expect(parseKeys('')).toBeNull();
    expect(parseKeys('Ctrl+]')).toBeNull();
  });
});

describe('cross-reference chips', () => {
  it('name their target, and flag one that is gone and an attribute not configured', () => {
    const editor = editorOf();
    expect(docTargets(editor.state.doc).map((x) => [x.block, x.kind])).toEqual([
      ['setup', 'section'],
    ]);
    const infos = [
      ...chipInfos(editor.state.doc, {
        config: {
          textAttributes: [{ id: 'product', label: 'Product name' }],
        } as ProjectConfig,
        lookup: (m) =>
          m === 'other'
            ? {
                status: 'found',
                title: 'Other',
                targets: new Map(),
                ids: new Set(['any-paragraph']),
              }
            : { status: 'missing' },
        t,
      }).values(),
    ];
    expect(infos.map((i) => [i.label, i.issue.split(' ')[0]])).toEqual([
      ['Setup', ''],
      ['gone', 'editor.docEditor.xref.missingTarget'],
      ['b', 'editor.docEditor.xref.missingTarget'],
      ['Product name', ''],
      ['unknown', 'editor.docEditor.attribute.unknown'],
      // Any block is a target the model anchors, a paragraph too.
      ['p', ''],
      ['any-paragraph', ''],
      ['nowhere', 'editor.docEditor.xref.missingModule'],
    ]);
    editor.destroy();
  });
});

describe('the IDs a cross-reference may name', () => {
  it('are every block, list item and step, however deep', () => {
    expect(
      [
        ...blockIds([
          {
            type: 'procedure',
            id: 'proc',
            steps: [
              {
                id: 'step',
                content: [],
                blocks: [
                  {
                    type: 'list',
                    id: 'list',
                    ordered: false,
                    items: [{ id: 'item', content: [], blocks: [] }],
                  },
                ],
              },
            ],
          },
        ] as never),
      ].sort(),
    ).toEqual(['item', 'list', 'proc', 'step']);
  });
});
