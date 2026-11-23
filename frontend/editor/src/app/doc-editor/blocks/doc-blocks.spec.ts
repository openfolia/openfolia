import { TestBed } from '@angular/core/testing';
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import {
  ProjectConfig,
  type Condition,
  type Module,
} from '@openfolia/content-model';
import { labelsIn } from '@openfolia/content-model/core';

import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from '../block-editor.component';
import { SAMPLE_MODULE } from '../sample-module';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import {
  blocks,
  doc,
  insideText,
  p,
  sec,
  testEditor,
} from '../testing/test-editor';
import {
  conditionChips,
  signalWords,
  type DocBlockSettings,
  type ModulePick,
} from './doc-blocks-context';
import { insertModuleRef, insertSafety, insertVariant } from './doc-blocks';
import { pickAndInsertSnippet } from '../snippets/snippet-blocks';
import { blockDragKey } from '../plugins/block-drag';

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
    variantAttributes: [
      {
        id: 'edition',
        label: 'Edition',
        kind: 'enum',
        values: [
          { id: 'small', label: 'Small edition' },
          { id: 'large', label: 'Large edition' },
        ],
      },
      { id: 'release', label: 'Release', kind: 'version' },
    ],
    safetySymbols: [
      { id: 'w001', label: 'General warning' },
      { id: 'w012', label: 'Electricity' },
    ],
    outputLabels: { en: { warning: 'HEADS UP' } },
  }),
  'en',
);

describe('condition chips', () => {
  it('show one chip per attribute, with the configured labels', () => {
    const when: Condition = {
      op: 'all',
      of: [
        { op: 'in', attr: 'edition', values: ['small', 'large'] },
        { op: 'cmp', attr: 'release', cmp: '>=', value: '2.3' },
        { op: 'cmp', attr: 'release', cmp: '<', value: '3' },
      ],
    };
    expect(conditionChips(when, CONFIG, 'Rule')).toEqual([
      { attribute: 'Edition', values: ['Small edition', 'Large edition'] },
      { attribute: 'Release', values: ['≥ 2.3', '< 3'] },
    ]);
  });

  it('show the IDs where nothing is configured', () => {
    expect(
      conditionChips(
        { op: 'in', attr: 'edition', values: ['large'] },
        null,
        'Rule',
      ),
    ).toEqual([{ attribute: 'edition', values: ['large'] }]);
  });

  it('show any other shape as its expression in one chip', () => {
    const chips = conditionChips(
      { op: 'not', of: { op: 'in', attr: 'edition', values: ['large'] } },
      CONFIG,
      'Rule',
    );
    expect(chips).toHaveLength(1);
    expect(chips?.[0]?.attribute).toBe('Rule');
    expect(chips?.[0]?.values[0]).toContain('edition');
  });

  it('are null for a block with no condition yet', () => {
    expect(conditionChips(null, CONFIG, 'Rule')).toBeNull();
    expect(conditionChips({ op: 'in' }, CONFIG, 'Rule')).toBeNull();
  });
});

describe('signal words', () => {
  it('follow the document language, configured over shipped', () => {
    expect(signalWords({ config: CONFIG, lang: 'en' }).warning).toBe(
      'HEADS UP',
    );
    expect(signalWords({ config: CONFIG, lang: 'de' }).danger).toBe('GEFAHR');
    expect(signalWords({}).notice).toBe('NOTICE');
  });
});

describe('inserting documentation blocks', () => {
  it('puts a safety notice in place of a blank line, the caret in its hazard', () => {
    const editor = testEditor(doc(p('a'), p()));
    editor.commands.setTextSelection(4);
    expect(insertSafety(editor.state, editor.view.dispatch)).toBe(true);
    expect(blocks(editor)).toEqual(['p:a', 'safety:']);
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe('hazard');
    const safety = editor.state.doc.child(1);
    expect(safety.attrs['severity']).toBe('warning');
    expect(safety.childCount).toBe(3);
  });

  it('puts a block after the one at the caret, and first in a section from its heading', () => {
    const editor = testEditor(doc(p('a'), sec('S', p('b'))));
    editor.commands.setTextSelection(2);
    insertModuleRef(editor.state, editor.view.dispatch);
    expect(blocks(editor)).toEqual(['p:a', 'ref', 's:S[p:b]']);
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    const title = editor.state.doc.child(2).firstChild!;
    const inTitle = editor.state.doc.content.size - 4 - title.nodeSize + 2;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, inTitle),
      ),
    );
    expect(editor.state.selection.$from.parent.type.name).toBe('title');
    insertSafety(editor.state, editor.view.dispatch);
    expect(blocks(editor)[2]).toBe('s:S[safety:, p:b]');
  });

  it('puts the block at the caret into a variant block, the caret where it was', () => {
    const editor = testEditor(doc(p('first'), p('second')));
    editor.commands.setTextSelection(10);
    insertVariant(editor.state, editor.view.dispatch);
    expect(blocks(editor)).toEqual(['p:first', 'variant:second']);
    expect(editor.state.selection.$from.parent.textContent).toBe('second');
    expect(editor.state.selection.$from.parentOffset).toBe(2);
    expect(editor.state.doc.child(1).attrs['when']).toBeNull();
  });

  it('insert in the variant block or safety notice the caret is in, not after it', () => {
    const variant = (...content: ReturnType<typeof p>[]) => ({
      type: 'variant',
      attrs: { id: 'v', when: null },
      content,
    });
    const editor = testEditor(doc(p('a'), variant(p('in'), p()), p('z')));
    editor.commands.setTextSelection(insideText(editor, 'in') + 1);
    expect(insertSafety(editor.state, editor.view.dispatch)).toBe(true);
    const inVariant = () =>
      editor.state.doc.child(1).content.content.map((n) => n.type.name);
    expect(inVariant()).toEqual(['paragraph', 'safety', 'paragraph']);
    expect(editor.state.selection.$from.parent.type.name).toBe('hazard');
    // A blank line in the variant block gives its place.
    const blank = editor.state.doc.child(1);
    const end = editor.state.doc.child(0).nodeSize + blank.nodeSize - 2;
    editor.commands.setTextSelection(end);
    expect(editor.state.selection.$from.parent.textContent).toBe('');
    insertModuleRef(editor.state, editor.view.dispatch);
    expect(inVariant()).toEqual(['paragraph', 'safety', 'moduleRef']);
    expect(blocks(editor).map((b) => b.split(':')[0])).toEqual([
      'p',
      'variant',
      'p',
    ]);
  });

  it('give blocks that convert to the model once filled in', () => {
    const editor = testEditor(
      toEditor({
        ...SAMPLE_MODULE,
        blocks: [
          {
            type: 'paragraph',
            id: 'a',
            content: [{ type: 'text', text: 'a' }],
          },
        ],
      }),
    );
    editor.commands.setTextSelection(2);
    insertSafety(editor.state, editor.view.dispatch);
    const fill = (index: number, text: string) => {
      const safety = editor.state.doc.child(1);
      let pos = editor.state.doc.child(0).nodeSize + 1;
      for (let i = 0; i < index; i += 1) pos += safety.child(i).nodeSize;
      editor.commands.insertContentAt(pos + 1, text);
    };
    fill(0, 'Hot surface');
    // An empty consequence and measure: not a module yet, named at the block.
    expect(() => fromEditor(normalizeEditorDoc(editor.getJSON()))).toThrow();
    fill(1, 'Burns.');
    fill(2, 'Let it cool.');
    const module = fromEditor(normalizeEditorDoc(editor.getJSON()));
    expect(module.blocks[1]).toMatchObject({
      type: 'safety',
      severity: 'warning',
      hazard: [{ type: 'text', text: 'Hot surface' }],
      symbols: [],
      blocks: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Burns.' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Let it cool.' }],
        },
      ],
    });
  });
});

const MODULE: Module = {
  ...SAMPLE_MODULE,
  blocks: [
    {
      type: 'safety',
      id: 'hot',
      severity: 'danger',
      hazard: [{ type: 'text', text: 'Hot surface' }],
      symbols: ['w001'],
      blocks: [
        {
          type: 'paragraph',
          id: 'hot-burns',
          content: [{ type: 'text', text: 'Burns.' }],
        },
      ],
    },
    {
      type: 'variant',
      id: 'large-only',
      when: { op: 'in', attr: 'edition', values: ['large'] },
      blocks: [
        {
          type: 'paragraph',
          id: 'large-text',
          content: [{ type: 'text', text: 'Large.' }],
        },
      ],
    },
    { type: 'moduleRef', id: 'footer', module: 'shared-footer' },
    { type: 'moduleRef', id: 'gone', module: 'gone-module' },
  ],
};

async function mount(settings: DocBlockSettings, module: Module = MODULE) {
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', toEditor(module));
  fixture.componentRef.setInput('blocks', settings);
  let last: JSONContent | null = null;
  fixture.componentInstance.changed.subscribe((d) => (last = d));
  await fixture.whenStable();
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
      await fixture.whenStable();
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
  const node = found[index];
  if (!node) throw new Error(`no ${type} #${index}`);
  return node;
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('the documentation blocks in the editor', () => {
  // The library's event plugins (`click.prevent-with-stop`, the menus' triggers), as the app has.
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('round-trip unchanged through the node views', async () => {
    const { editor } = await mount({ config: CONFIG, lang: 'en' });
    expect(
      fromEditor(normalizeEditorDoc(withoutCaretGaps(editor.getJSON()))),
    ).toEqual(MODULE);
  });

  it('show the configured signal word and symbols, and change the level and symbols', async () => {
    const { el, editor, stable } = await mount({ config: CONFIG, lang: 'de' });
    const safety = el.querySelector('[data-node="safety"]')!;
    expect(
      safety.querySelector('[role="note"]')?.getAttribute('aria-label'),
    ).toBe('GEFAHR');
    // Without a way to read artwork (the playground), the label, marked as without artwork.
    const chip = safety.querySelector('[data-symbol]');
    expect(chip?.getAttribute('data-state')).toBe('missing');
    expect(chip?.textContent).toContain('General warning');
    const trigger =
      safety.querySelector<HTMLButtonElement>('button[z-dropdown]')!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await stable();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        'z-dropdown-menu-radio-item, z-dropdown-menu-checkbox-item',
      ),
    ];
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      'GEFAHR',
      'WARNUNG',
      'VORSICHT',
      'HINWEIS',
      'General warning',
      'Electricity',
    ]);
    // The symbols' entries: a marked tile beside each label.
    expect(
      items[4]!.querySelector('of-safety-symbol')?.getAttribute('data-state'),
    ).toBe('missing');
    items[2]!.click();
    await stable();
    expect(nodeOf(editor, 'safety').attrs['severity']).toBe('caution');
    expect(
      safety.querySelector('[role="note"]')?.getAttribute('aria-label'),
    ).toBe('VORSICHT');
    editor.commands.undo();
    expect(nodeOf(editor, 'safety').attrs['severity']).toBe('danger');
  });

  it('show each symbol’s artwork beside the signal word, and in the menu once it is near', async () => {
    const read: string[] = [];
    const symbolSource = (id: string) => {
      read.push(id);
      return id === 'w001'
        ? Promise.resolve('blob:w001')
        : Promise.resolve(null);
    };
    const { el, stable } = await mount({
      config: CONFIG,
      lang: 'en',
      symbolSource,
    });
    await flush();
    await stable();
    const safety = el.querySelector('[data-node="safety"]')!;
    const symbol = safety.querySelector('[data-symbol]')!;
    expect(symbol.getAttribute('data-state')).toBe('shown');
    const img = symbol.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:w001');
    expect(img.getAttribute('alt')).toBe('General warning');
    // Only the notice's own symbols until the menu is near.
    expect(read).toEqual(['w001']);
    const trigger =
      safety.querySelector<HTMLButtonElement>('button[z-dropdown]')!;
    trigger.focus();
    await flush();
    await stable();
    expect(read).toEqual(['w001', 'w012']);
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await stable();
    const states = [
      ...document.querySelectorAll('z-dropdown-menu-checkbox-item'),
    ].map((i) =>
      i.querySelector('of-safety-symbol')?.getAttribute('data-state'),
    );
    // Electricity has no artwork: its tile is marked.
    expect(states).toEqual(['shown', 'missing']);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await stable();
  });

  it("keep the caret out of the frames: only the content is editable, in the editor's one editing host", async () => {
    const { el } = await mount({});
    for (const type of ['safety', 'variant']) {
      const dom = el.querySelector<HTMLElement>(`[data-node="${type}"]`)!;
      const content = dom.querySelector<HTMLElement>('.doc-block-content')!;
      // No nested editing host: the editor keeps the focus, and with it the selection.
      expect(dom.hasAttribute('contenteditable')).toBe(false);
      expect(content.hasAttribute('contenteditable')).toBe(false);
      const fenced = Array.from(dom.querySelectorAll('*')).filter(
        (e) => !e.contains(content) && !content.contains(e) && e !== content,
      );
      expect(fenced.length).toBeGreaterThan(0);
      for (const e of fenced)
        expect(e.closest('[contenteditable="false"]')).not.toBeNull();
    }
    const ref = el.querySelector('[data-node="moduleRef"]')!;
    expect(ref.getAttribute('contenteditable')).toBe('false');
  });

  it('label the hazard, consequence and measure in the UI language, outside the document', async () => {
    const { el, model } = await mount({ config: CONFIG, lang: 'en' });
    const host = el.querySelector<HTMLElement>('of-safety-node')!;
    expect(host.style.getPropertyValue('--safety-hazard-label')).toBe(
      '"Hazard"',
    );
    expect(model()).toEqual(MODULE);
  });

  it('open the variant picker and take its condition; without one the button says why', async () => {
    const picked: (Condition | null)[] = [];
    const next: Condition = {
      op: 'in',
      attr: 'edition',
      values: ['small'],
    };
    const { el, editor, stable } = await mount({
      config: CONFIG,
      pickVariant: async (current) => {
        picked.push(current);
        return next;
      },
    });
    const variant = el.querySelector('[data-node="variant"]')!;
    expect(variant.querySelector('[data-chip]')?.textContent).toContain(
      'Large edition',
    );
    variant.querySelector<HTMLButtonElement>('button')!.click();
    await flush();
    await stable();
    expect(picked).toEqual([{ op: 'in', attr: 'edition', values: ['large'] }]);
    expect(nodeOf(editor, 'variant').attrs['when']).toEqual(next);
    expect(variant.querySelector('[data-chip]')?.textContent).toContain(
      'Small edition',
    );

    const without = await mount({ config: CONFIG });
    const button = without.el
      .querySelector('[data-node="variant"]')!
      .querySelector('button')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('give the focus back to the variant block after the picker applies, the caret where it was (#793)', async () => {
    // Meanwhile the selection goes elsewhere (to the document's start): it comes back.
    let moveAway = () => undefined as unknown;
    const { el, editor, stable } = await mount({
      config: CONFIG,
      pickVariant: async () => {
        moveAway();
        return { op: 'in', attr: 'edition', values: ['small'] };
      },
    });
    moveAway = () => editor.commands.setTextSelection(1);
    // The caret in "Large." after "Lar", then the button takes the focus, as a click does.
    const at = insideText(editor, 'Large.') + 3;
    editor.commands.setTextSelection(at);
    const button = el
      .querySelector('[data-node="variant"]')!
      .querySelector<HTMLButtonElement>('button')!;
    button.focus();
    expect(editor.view.hasFocus()).toBe(false);
    button.click();
    await flush();
    await stable();
    expect(nodeOf(editor, 'variant').attrs['when']).toEqual({
      op: 'in',
      attr: 'edition',
      values: ['small'],
    });
    expect(editor.view.hasFocus()).toBe(true);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(at);
  });

  it('take the variant frame away and keep its blocks when the picker removes the condition', async () => {
    const { el, editor, model, stable } = await mount({
      config: CONFIG,
      pickVariant: async () => 'remove',
    });
    el.querySelector('[data-node="variant"]')!.querySelector('button')!.click();
    await flush();
    await stable();
    expect(el.querySelector('[data-node="variant"]')).toBeNull();
    const blocks = model().blocks;
    expect(blocks.map((b) => b.id)).toEqual([
      'hot',
      'large-text',
      'footer',
      'gone',
    ]);
    // One Undo step brings the frame back.
    editor.commands.undo();
    expect(nodeOf(editor, 'variant').attrs['when']).toEqual({
      op: 'in',
      attr: 'edition',
      values: ['large'],
    });
  });

  it('show a referenced module by its title, say when it is missing, and retry a failed lookup', async () => {
    let fail = true;
    const opened: string[] = [];
    const { el, stable } = await mount({
      moduleTitle: async (id) => {
        if (id === 'gone-module') return null;
        if (fail) throw new Error('offline');
        return 'Shared footer';
      },
      openModule: (id) => opened.push(id),
    });
    await flush();
    await stable();
    const [footer, gone] = [
      ...el.querySelectorAll<HTMLElement>('[data-node="moduleRef"]'),
    ];
    expect(gone?.textContent).toContain('not visible to you');
    expect(footer?.textContent).toContain('could not be loaded');
    fail = false;
    footer!.querySelector('button')!.click();
    await flush();
    await stable();
    expect(footer?.textContent).toContain('Shared footer');
    footer!.querySelector('button')!.click();
    expect(opened).toEqual(['shared-footer']);
  });

  it('label a reference to a snippet "Snippet"', async () => {
    const config = labelsIn(
      ProjectConfig.parse({
        ...CONFIG,
        moduleTypes: [
          { id: 'task', label: 'Task' },
          { id: 'phrase', label: 'Phrase', snippet: true },
        ],
      }),
      'en',
    );
    const { el, stable } = await mount({
      config,
      moduleContent: async (id) =>
        id === 'shared-footer'
          ? { title: 'Shared footer', type: 'phrase', blocks: [] }
          : null,
    });
    await flush();
    await stable();
    const [footer, gone] = [
      ...el.querySelectorAll<HTMLElement>('[data-node="moduleRef"]'),
    ];
    expect(footer?.textContent).toContain('Shared footer');
    expect(footer?.textContent).toContain('Snippet');
    expect(gone?.textContent).not.toContain('Snippet');
  });

  it('insert a snippet from the picker as a reference, or as a copy with new IDs', async () => {
    const snippetBlocks = [
      {
        type: 'paragraph' as const,
        id: 'own',
        content: [{ type: 'text' as const, text: 'Wear gloves.' }],
      },
    ];
    let mode: 'whole' | 'copy' = 'copy';
    const asked: unknown[] = [];
    const { editor, model } = await mount({
      config: CONFIG,
      pickModule: async (_current, options) => {
        asked.push(options);
        return { module: 'gloves', mode };
      },
      moduleContent: async () => ({
        title: 'Gloves',
        type: 'phrase',
        blocks: snippetBlocks,
      }),
    });
    editor.commands.setTextSelection(1);
    expect(await pickAndInsertSnippet(editor)).toBe(true);
    expect(asked).toEqual([{ snippet: true }]);
    await flush();
    const copied = model().blocks.find(
      (b) =>
        b.type === 'paragraph' && JSON.stringify(b).includes('Wear gloves.'),
    );
    expect(copied).toBeDefined();
    expect(copied?.id).not.toBe('own');
    mode = 'whole';
    expect(await pickAndInsertSnippet(editor)).toBe(true);
    await flush();
    expect(
      model().blocks.some(
        (b) => b.type === 'moduleRef' && b.module === 'gloves',
      ),
    ).toBe(true);
  });

  it('show which block a reference to one block names, say when it is gone, and open the module at it (#223)', async () => {
    const opened: [string, string | undefined][] = [];
    const one = {
      ...MODULE,
      blocks: [
        { type: 'moduleRef', id: 'one', module: 'shared', block: 'acid' },
        { type: 'moduleRef', id: 'gone', module: 'shared', block: 'nope' },
      ],
    } as unknown as Module;
    const { el, stable } = await mount(
      {
        config: CONFIG,
        openModule: (id, block) => opened.push([id, block]),
        moduleContent: async () => ({
          title: 'Battery safety',
          type: 'task',
          blocks: [
            {
              type: 'safety',
              id: 'acid',
              severity: 'warning',
              symbols: [],
              hazard: [{ type: 'text', text: 'Battery acid' }],
              blocks: [],
            },
          ],
        }),
      },
      one,
    );
    await flush();
    await stable();
    const [found, gone] = [
      ...el.querySelectorAll<HTMLElement>('[data-node="moduleRef"]'),
    ];
    expect(found?.textContent).toContain('Battery safety');
    expect(found?.textContent).toContain('Battery acid');
    expect(
      found
        ?.querySelector('of-module-reference-card')
        ?.getAttribute('data-mode'),
    ).toBe('block');
    expect(gone?.textContent).toContain(
      'The block “nope” is not in this module',
    );
    found!.querySelector('button')!.click();
    gone!.querySelector('button')!.click();
    expect(opened).toEqual([
      ['shared', 'acid'],
      ['shared', undefined],
    ]);
  });

  it('take one block of a module from the picker, and the whole module again (#223)', async () => {
    const empty = {
      ...MODULE,
      blocks: [{ type: 'moduleRef', id: 'new-ref', module: '' }],
    } as unknown as Module;
    let pick: ModulePick = { module: 'shared', mode: 'block', block: 'acid' };
    const { el, stable, model } = await mount(
      { pickModule: async () => pick },
      empty,
    );
    el.querySelector('[data-node="moduleRef"]')!
      .querySelector('button')!
      .click();
    await flush();
    await stable();
    expect(model().blocks).toEqual([
      { type: 'moduleRef', id: 'new-ref', module: 'shared', block: 'acid' },
    ]);
    // The whole module on a reference that named a block: the block goes.
    const named = {
      ...MODULE,
      blocks: [{ type: 'moduleRef', id: 'new-ref', module: '', block: 'acid' }],
    } as unknown as Module;
    pick = { module: 'shared', mode: 'whole' };
    const again = await mount({ pickModule: async () => pick }, named);
    again.el
      .querySelector('[data-node="moduleRef"]')!
      .querySelector('button')!
      .click();
    await flush();
    await again.stable();
    expect(nodeOf(again.editor, 'moduleRef').attrs['module']).toBe('shared');
    expect(nodeOf(again.editor, 'moduleRef').attrs['block']).toBeNull();
  });

  it('offer the module picker on an empty reference, and take its module', async () => {
    const empty = {
      ...MODULE,
      blocks: [{ type: 'moduleRef', id: 'new-ref', module: '' }],
    } as unknown as Module;
    const { el, editor, stable } = await mount(
      { pickModule: async () => ({ module: 'shared-footer', mode: 'whole' }) },
      empty,
    );
    const card = el.querySelector('[data-node="moduleRef"]')!;
    expect(card.textContent).toContain('No module chosen');
    card.querySelector('button')!.click();
    await flush();
    await stable();
    expect(nodeOf(editor, 'moduleRef').attrs['module']).toBe('shared-footer');
  });

  it('put a cross-reference in a line of text in place of the reference when the picker links', async () => {
    const empty = {
      ...MODULE,
      blocks: [{ type: 'moduleRef', id: 'new-ref', module: '' }],
    } as unknown as Module;
    const { el, editor, stable } = await mount(
      { pickModule: async () => ({ module: 'shared-footer', mode: 'link' }) },
      empty,
    );
    el.querySelector('[data-node="moduleRef"]')!
      .querySelector('button')!
      .click();
    await flush();
    await stable();
    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'moduleRef') throw new Error('still a reference');
      if (node.type.name === 'xref') {
        found = true;
        expect(node.attrs['module']).toBe('shared-footer');
        expect(node.attrs['text']).toBeNull();
      }
    });
    expect(found).toBe(true);
    editor.commands.undo();
    expect(nodeOf(editor, 'moduleRef').attrs['module']).toBe('');
  });

  it('leave an empty reference as it is when the picker is cancelled', async () => {
    const empty = {
      ...MODULE,
      blocks: [{ type: 'moduleRef', id: 'new-ref', module: '' }],
    } as unknown as Module;
    const { el, editor, stable } = await mount(
      { pickModule: async () => null },
      empty,
    );
    el.querySelector('[data-node="moduleRef"]')!
      .querySelector('button')!
      .click();
    await flush();
    await stable();
    expect(nodeOf(editor, 'moduleRef').attrs['module']).toBe('');
  });

  it('give the blocks in a safety notice and a variant block a grip of their own, inside the frame, that lifts them', async () => {
    const { el, editor } = await mount({ config: CONFIG, lang: 'en' });
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { focused: true }),
    );
    const anchor = () =>
      el.querySelector<HTMLElement>('.doc-editor-grip-anchor');
    for (const [type, text] of [
      ['safety', 'Burns.'],
      ['variant', 'Large.'],
    ] as const) {
      editor.commands.setTextSelection(insideText(editor, text));
      const content = el.querySelector(
        `[data-node="${type}"] .doc-block-content`,
      );
      expect(anchor()?.parentElement).toBe(content);
      expect(anchor()?.nextElementSibling?.textContent).toBe(text);
    }
    // In the hazard: the notice's own grip, outside its frame.
    editor.commands.setTextSelection(insideText(editor, 'Hot surface'));
    expect(
      (anchor()?.nextElementSibling as HTMLElement | null)?.dataset['node'],
    ).toBe('safety');

    // Pressed and moved, the grip lifts the measure (jsdom lays nothing out: where the slot then
    // goes is the plugin's test).
    editor.commands.setTextSelection(insideText(editor, 'Burns.'));
    const grip = el.querySelector('[data-testid="block-grip"]')!;
    grip.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    window.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10 }),
    );
    const measure = insideText(editor, 'Burns.') - 1;
    expect(blockDragKey.getState(editor.state)?.drag?.source).toBe(measure);
    expect(
      el.querySelector('[data-node="safety"] .doc-editor-drag-source')
        ?.textContent,
    ).toBe('Burns.');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(blockDragKey.getState(editor.state)?.drag).toBeNull();
  });

  it('animate a block in when it is inserted, and not when it is loaded', async () => {
    const { el, editor } = await mount({});
    expect(el.querySelector('.doc-block-enter')).toBeNull();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    insertSafety(editor.state, editor.view.dispatch);
    expect(el.querySelectorAll('.doc-block-enter')).toHaveLength(1);
  });

  it('animate only the new variant block when a block is put into one, and nothing on Undo', async () => {
    const original = window.matchMedia;
    const rect = Element.prototype.getBoundingClientRect;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
    })) as typeof window.matchMedia;
    // Blocks with a height: a block read as removed would leave a blank.
    Element.prototype.getBoundingClientRect = function () {
      return new DOMRect(0, 0, 100, 40);
    };
    try {
      const { el, editor } = await mount({});
      let pos = -1;
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === 'safety') pos = offset;
      });
      editor.view.dispatch(
        editor.state.tr.setSelection(
          NodeSelection.create(editor.state.doc, pos),
        ),
      );
      expect(insertVariant(editor.state, editor.view.dispatch)).toBe(true);
      await Promise.resolve();
      expect(nodeOf(editor, 'variant').firstChild?.type.name).toBe('safety');
      expect(el.querySelector('.doc-block-leave')).toBeNull();
      const entering = () =>
        Array.from(el.querySelectorAll<HTMLElement>('.doc-block-enter')).map(
          (e) => e.dataset['node'],
        );
      // The new variant block comes in; the safety notice in it is the one that was there.
      expect(entering()).toEqual(['variant']);
      editor.commands.undo();
      await Promise.resolve();
      expect(
        editor.state.doc.content.content.map((n) => n.type.name),
      ).toContain('safety');
      expect(el.querySelector('.doc-block-leave')).toBeNull();
      expect(
        el.querySelector('[data-node="safety"].doc-block-enter'),
      ).toBeNull();
    } finally {
      window.matchMedia = original;
      Element.prototype.getBoundingClientRect = rect;
    }
  });

  it('leave a closing blank where a block was removed, unless less motion is asked for', async () => {
    const original = window.matchMedia;
    const rect = Element.prototype.getBoundingClientRect;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
    })) as typeof window.matchMedia;
    Element.prototype.getBoundingClientRect = function () {
      return new DOMRect(0, 0, 100, 40);
    };
    try {
      const { el, editor } = await mount({});
      let pos = -1;
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === 'variant') pos = offset;
      });
      const variant = nodeOf(editor, 'variant');
      editor.view.dispatch(editor.state.tr.delete(pos, pos + variant.nodeSize));
      await Promise.resolve();
      const blank = el.querySelector<HTMLElement>('.doc-block-leave');
      expect(blank?.style.getPropertyValue('--leave-height')).toBe('40px');
      blank!.dispatchEvent(new Event('animationend'));
      expect(el.querySelector('.doc-block-leave')).toBeNull();
      // The blank is the editor's drawing: Undo brings the block back, nothing else.
      editor.commands.undo();
      expect(nodeOf(editor, 'variant').attrs['id']).toBe('large-only');
    } finally {
      window.matchMedia = original;
      Element.prototype.getBoundingClientRect = rect;
    }
  });
});
