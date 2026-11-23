import { TestBed } from '@angular/core/testing';
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import { ProjectConfig, type Module } from '@openfolia/content-model';
import { labelsIn } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from '../block-editor.component';
import { SAMPLE_MODULE } from '../sample-module';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import type { DocBlockSettings } from './doc-blocks-context';
import { advance } from '../../testing/fake-time';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const CONFIG = labelsIn(
  ProjectConfig.parse({
    languages: { source: 'en', targets: ['de'] },
    moduleTypes: [{ id: 'task', label: 'Task' }],
    audiences: [{ id: 'all', label: 'Everyone' }],
    outputLabels: { en: { tip: 'Good to know' } },
  }),
  'en',
);

const t = (text: string) => ({ type: 'text' as const, text });

const MODULE: Module = {
  ...SAMPLE_MODULE,
  blocks: [
    {
      type: 'admonition',
      id: 'tip',
      kind: 'tip',
      blocks: [{ type: 'paragraph', id: 'tip-text', content: [t('Save.')] }],
    },
    {
      type: 'procedure',
      id: 'steps',
      title: [t('Install')],
      steps: [
        {
          id: 'one',
          content: [t('Open the box.')],
          blocks: [
            {
              type: 'paragraph',
              id: 'one-result',
              content: [t('It is open.')],
            },
          ],
        },
        {
          id: 'two',
          content: [t('Take it out.')],
          blocks: [
            {
              type: 'procedure',
              id: 'two-sub',
              steps: [{ id: 'two-a', content: [t('Lift.')], blocks: [] }],
            },
          ],
        },
      ],
    },
    {
      type: 'procedure',
      id: 'untitled',
      steps: [{ id: 'u1', content: [t('Go.')], blocks: [] }],
    },
    {
      type: 'literal',
      id: 'config',
      language: 'yaml',
      text: 'a: 1\n  b:  2',
    },
    {
      type: 'passthrough',
      id: 'raw',
      format: 'html',
      raw: '<script>alert(1)</script>\n<b>kept</b>',
    },
  ],
};

async function mount(settings: DocBlockSettings, module: Module = MODULE) {
  // Fake time: the menus and popovers open and close on timers that change detection, itself on
  // a timer, starts; the fake clock runs every timer due in the step, in order (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', toEditor(module));
  fixture.componentRef.setInput('blocks', settings);
  let last: JSONContent | null = null;
  fixture.componentInstance.changed.subscribe((d) => (last = d));
  await advance();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    editor,
    el,
    model: () =>
      fromEditor(
        normalizeEditorDoc(last ?? withoutCaretGaps(editor.getJSON())),
      ),
    stable: async () => {
      fixture.detectChanges();
      await advance();
    },
  };
}

/** The `index`th node of that type in the document, wherever it is. */
function nodeOf(editor: Editor, type: string, index = 0) {
  const found: ProseMirrorNode[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === type) found.push(node);
    return true;
  });
  return found[index]!;
}

async function openMenu(
  trigger: HTMLButtonElement,
  stable: () => Promise<void>,
) {
  trigger.focus();
  trigger.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  await stable();
}

describe('the admonition, procedure, code and passthrough blocks in the editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('round-trip unchanged through their node views', async () => {
    const { editor } = await mount({ config: CONFIG, lang: 'en' });
    expect(
      fromEditor(normalizeEditorDoc(withoutCaretGaps(editor.getJSON()))),
    ).toEqual(MODULE);
  });

  it("keep the caret out of their frames: only the content is editable, in the editor's one editing host", async () => {
    const { el } = await mount({});
    for (const type of ['admonition', 'procedure', 'literal']) {
      const dom = el.querySelector<HTMLElement>(`[data-node="${type}"]`)!;
      const content = dom.querySelector<HTMLElement>('.doc-block-content')!;
      expect(dom.hasAttribute('contenteditable'), type).toBe(false);
      expect(content.hasAttribute('contenteditable'), type).toBe(false);
      const fenced = Array.from(dom.querySelectorAll('*')).filter(
        (e) => !e.contains(content) && !content.contains(e) && e !== content,
      );
      expect(fenced.length, type).toBeGreaterThan(0);
      for (const e of fenced)
        expect(e.closest('[contenteditable="false"]'), type).not.toBeNull();
    }
    const raw = el.querySelector('[data-node="passthrough"]')!;
    expect(raw.getAttribute('contenteditable')).toBe('false');
  });

  it('show the admonition with its configured word, and switch its kind in place, fading', async () => {
    const { el, editor, stable, model } = await mount({
      config: CONFIG,
      lang: 'en',
    });
    const dom = el.querySelector('[data-node="admonition"]')!;
    const note = dom.querySelector<HTMLElement>('[role="note"]')!;
    expect(note.getAttribute('aria-label')).toBe('Good to know');
    expect(note.getAttribute('data-kind')).toBe('tip');
    expect(note.classList).toContain('transition-colors');
    expect(note.classList).toContain('motion-reduce:transition-none');
    await openMenu(
      dom.querySelector<HTMLButtonElement>('button[z-dropdown]')!,
      stable,
    );
    const items = [
      ...document.querySelectorAll<HTMLElement>('z-dropdown-menu-radio-item'),
    ];
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      'Note',
      'Good to know',
      'Important',
    ]);
    items[2]!.click();
    await stable();
    expect(nodeOf(editor, 'admonition').attrs['kind']).toBe('important');
    expect(note.getAttribute('aria-label')).toBe('Important');
    expect(note.className).toContain('border-warning');
    // Only the kind changed.
    expect(model().blocks[0]).toEqual({
      ...MODULE.blocks[0],
      kind: 'important',
    });
    expect(model().blocks.slice(1)).toEqual(MODULE.blocks.slice(1));
    editor.commands.undo();
    expect(nodeOf(editor, 'admonition').attrs['kind']).toBe('tip');
  });

  it('show the admonition word in the document language', async () => {
    const { el } = await mount({ config: CONFIG, lang: 'de' });
    expect(
      el
        .querySelector('[data-node="admonition"] [role="note"]')
        ?.getAttribute('aria-label'),
    ).toBe('Tipp');
  });

  it('number the steps, mark a result, and add a title to an untitled procedure', async () => {
    const { el, editor, stable, model } = await mount({});
    // The procedures at the top (a sub-step's procedure is inside the first).
    const [titled, untitled] = [
      ...el.querySelectorAll<HTMLElement>('of-procedure-node'),
    ].filter((n) => !n.parentElement?.closest('of-procedure-node'));
    expect(
      titled?.querySelector(
        ':scope > of-procedure-block > div:first-child button',
      ),
    ).toBeNull();
    expect(titled?.style.getPropertyValue('--procedure-result-label')).toBe(
      '"Result"',
    );
    const add = [...(untitled?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Add title'),
    )!;
    add.click();
    await stable();
    expect(editor.state.selection.$from.parent.type.name).toBe('title');
    editor.commands.insertContent('Start');
    await stable();
    expect(model().blocks[2]).toEqual({
      ...MODULE.blocks[2],
      title: [t('Start')],
    });
    editor.commands.undo();
    editor.commands.undo();
    expect(nodeOf(editor, 'procedure', 2).firstChild?.type.name).toBe(
      'listItem',
    );
  });

  it('pick a code block’s language from a searchable list, or a word typed in, refusing one the model would not take', async () => {
    const { el, editor, stable, model } = await mount({
      config: {
        ...CONFIG,
        codeLanguages: [{ id: 'fortran', label: 'Fortran' }],
      },
    });
    const trigger = el.querySelector<HTMLButtonElement>(
      '[data-node="literal"] [data-testid="code-language"]',
    )!;
    const labelled = () =>
      trigger
        .getAttribute('aria-labelledby')!
        .split(' ')
        .map((id) =>
          el.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim(),
        )
        .join(' ');
    expect(labelled()).toBe('Language YAML');
    const open = async () => {
      // Let the last panel finish closing first.
      await vi.advanceTimersByTimeAsync(300);
      trigger.click();
      await vi.advanceTimersByTimeAsync(30);
      await stable();
      // The newest panel: one closed a moment ago may still be fading out.
      const panel = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-slot="popover-content"]',
        ),
      ].at(-1)!;
      const input = panel.querySelector<HTMLInputElement>('input')!;
      const type = async (text: string) => {
        input.value = text;
        input.dispatchEvent(new Event('input'));
        await stable();
      };
      const options = () =>
        [
          ...panel.querySelectorAll<HTMLElement>(
            'z-command-option:not(.hidden) [role="option"]',
          ),
        ].map((o) => o.textContent?.trim());
      const pick = async (label: string) => {
        [
          ...panel.querySelectorAll<HTMLElement>(
            'z-command-option:not(.hidden) [role="option"]',
          ),
        ]
          .find((o) => o.textContent?.trim() === label)!
          .click();
        await stable();
      };
      return { panel, input, type, options, pick };
    };

    let picker = await open();
    expect(document.activeElement).toBe(picker.input);
    expect(picker.options().slice(0, 2)).toEqual([
      'Plain text',
      'Bash / Shell',
    ]);
    expect(picker.options()).toContain('PHP');
    // The project's own language joins the list.
    expect(picker.options()).toContain('Fortran');
    await picker.type('scr');
    expect(picker.options()).toEqual(['Use “scr”', 'JavaScript', 'TypeScript']);
    await picker.pick('TypeScript');
    expect(nodeOf(editor, 'literal').attrs['language']).toBe('typescript');
    expect(labelled()).toBe('Language TypeScript');

    picker = await open();
    await picker.type('not a word');
    expect(picker.panel.querySelector('[role="alert"]')?.textContent).toContain(
      'One word',
    );
    expect(picker.options().some((o) => o?.startsWith('Use'))).toBe(false);
    await picker.type(' json5 ');
    await picker.pick('Use “json5”');
    expect(model().blocks[3]).toEqual({
      ...MODULE.blocks[3],
      language: 'json5',
    });
    expect(labelled()).toBe('Language json5');

    picker = await open();
    await picker.pick('Plain text');
    expect(model().blocks[3]).not.toHaveProperty('language');
    expect(labelled()).toBe('Language Plain text');
    // The text kept every space and line break.
    expect(nodeOf(editor, 'literal').textContent).toBe('a: 1\n  b:  2');
  });

  it('show a passthrough read-only, its source as text behind "Show source"', async () => {
    const { el, stable } = await mount({});
    const dom = el.querySelector('[data-node="passthrough"]')!;
    expect(dom.querySelector('[data-format]')?.textContent).toBe('html');
    expect(dom.querySelector('script, b')).toBeNull();
    const toggle = dom.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await stable();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(dom.querySelector('[data-source]')?.textContent).toBe(
      '<script>alert(1)</script>\n<b>kept</b>',
    );
    expect(dom.querySelector('script, b')).toBeNull();
  });

  it('hide their controls when the document is read-only', async () => {
    const { fixture, el, stable } = await mount({});
    fixture.componentRef.setInput('editable', false);
    await stable();
    expect(el.querySelector('[data-node="admonition"] button')).toBeNull();
    expect(
      el.querySelector('[data-node="literal"] [data-testid="code-language"]'),
    ).toBeNull();
    expect(
      el.querySelector('[data-node="literal"] [data-language]')?.textContent,
    ).toBe('YAML');
    expect(el.querySelector('of-procedure-node button')).toBeNull();
  });
});
