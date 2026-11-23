// @vitest-environment jsdom
/// <reference lib="dom" />
import { normalizeModule } from '@openfolia/content-model';
import { generateHTML, generateJSON } from '@tiptap/core';
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import fc from 'fast-check';
import { moduleArb } from '../testing/arbitraries.js';
import { createEditorExtensions, getEditorSchema } from './extensions.js';
import { toEditor } from './to-editor.js';

// Copy and paste inside the editor goes through HTML: every node and
// attribute must survive being rendered and parsed back.

/** Renders and parses as ProseMirror's clipboard does (TipTap's generateJSON drops some whitespace). */
function throughHtml(doc: unknown): unknown {
  const schema = getEditorSchema();
  const container = document.createElement('div');
  container.append(
    DOMSerializer.fromSchema(schema).serializeFragment(
      schema.nodeFromJSON(doc).content,
    ),
  );
  const parsed = new window.DOMParser().parseFromString(
    container.innerHTML,
    'text/html',
  );
  return DOMParser.fromSchema(schema).parse(parsed.body).toJSON();
}

describe('the HTML the extensions render', () => {
  const extensions = createEditorExtensions();

  it('parses back into the same document', () => {
    fc.assert(
      fc.property(moduleArb.map(normalizeModule), (module) => {
        const doc = toEditor(module);
        const back = throughHtml(doc) as { content?: unknown };
        // The document's own attributes aren't rendered: the module ID and metadata never travel by clipboard.
        expect(JSON.parse(JSON.stringify(back.content ?? []))).toStrictEqual(
          doc.content ?? [],
        );
      }),
      { numRuns: 300 },
    );
  });

  it('gives only http, https and mailto links an href', () => {
    const html = (href: string) =>
      generateHTML(
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'p' },
              content: [
                {
                  type: 'text',
                  text: 'x',
                  marks: [{ type: 'link', attrs: { href } }],
                },
              ],
            },
          ],
        },
        extensions,
      );
    expect(html('https://example.com/')).toContain(
      'href="https://example.com/"',
    );
    expect(html('javascript:alert(1)')).not.toContain(' href=');
    expect(html('data:text/html,x')).not.toContain(' href=');
  });

  it('reads plain formatting pasted from elsewhere', () => {
    const json = generateJSON(
      '<p><b>bold</b> <i>it</i> <a href="https://example.com/">link</a></p>',
      extensions,
    );
    expect(json.content[0].content).toEqual([
      { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'it', marks: [{ type: 'emphasis' }] },
      { type: 'text', text: ' ' },
      {
        type: 'text',
        text: 'link',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }],
      },
    ]);
  });

  it('pastes a link to any other address as plain text, our own markup too', () => {
    for (const html of [
      '<p><a href="javascript:alert(1)">x</a></p>',
      '<p><a href=" javascript:alert(1)">x</a></p>',
      '<p><a href="/relative">x</a></p>',
      '<p><a data-mark="link" data-href="&quot;javascript:alert(1)&quot;">x</a></p>',
    ]) {
      const json = generateJSON(html, extensions);
      expect(json.content[0].content, html).toEqual([
        { type: 'text', text: 'x' },
      ]);
    }
    const ours = generateJSON(
      '<p><a data-mark="link" data-href="&quot;mailto:a@example.com&quot;">x</a></p>',
      extensions,
    );
    expect(ours.content[0].content[0].marks).toEqual([
      { type: 'link', attrs: { href: 'mailto:a@example.com' } },
    ]);
  });
});
