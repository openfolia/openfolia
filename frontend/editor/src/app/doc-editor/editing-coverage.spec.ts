import { TestBed } from '@angular/core/testing';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { toEditor } from '@openfolia/content-editor-model';
import { Block, Inline, Mark, walk } from '@openfolia/content-model';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from './block-editor.component';
import { DOC_BLOCK_TYPES } from './blocks/doc-blocks';
import { createEditorExtensions } from './extensions';
import { INLINE_ATOMS } from './inline/inline-edit';
import { SAMPLE_MODULE } from './sample-module';
import { BUBBLE_MARK_IDS } from './selection-bubble.component';
import { SLASH_ITEMS } from './slash/slash-items';

// Every block type, inline type and mark of the content model has a way to be edited here. A
// type added to the model without one fails this test (and the playground's sample shows each).

beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

/** Just enough of a Zod schema's internals to read a (lazy) discriminated union's members. */
function members(schema: unknown): string[] {
  type ZodLike = { _zod: { def: Record<string, unknown> } };
  const def = (schema as ZodLike)._zod.def;
  const union = (
    def['type'] === 'lazy' ? (def['getter'] as () => unknown)() : schema
  ) as { options: { shape: { type: { value: string } } }[] };
  return union.options.map((o) => o.shape.type.value).sort();
}

/** How a type is edited: the "/" item that inserts it, its node view, the bubble, a key. */
interface EditingUi {
  readonly slash?: string;
  /** Drawn by a node view of its own (a documentation block or an inline chip). */
  readonly view?: true;
  readonly bubble?: true;
  /** A keyboard shortcut that makes it. */
  readonly key?: string;
  /** Text as it is typed: the editor itself. */
  readonly typed?: true;
  /**
   * Its editing UI is being built under this issue (listed here by name, so the gap stays in
   * view and its PR replaces this with the real entry).
   */
  readonly pending?: string;
}

const BLOCKS: Readonly<Record<string, EditingUi>> = {
  paragraph: { slash: 'paragraph', typed: true },
  section: { slash: 'heading1' },
  list: { slash: 'bulletList' },
  procedure: { slash: 'procedure', view: true },
  table: { slash: 'table' },
  image: { slash: 'image', view: true },
  safety: { slash: 'safety', view: true },
  admonition: { slash: 'admonition', view: true },
  faq: { slash: 'faq', view: true },
  attachment: { slash: 'attachment', view: true },
  variant: { slash: 'variant', view: true },
  moduleRef: { slash: 'moduleRef', view: true },
  literal: { slash: 'literal', view: true },
  pageBreak: { slash: 'pageBreak', view: true },
  // Read-only by design (an importer's unconverted source): shown, moved and deleted whole.
  passthrough: { view: true },
};

const INLINES: Readonly<Record<string, EditingUi>> = {
  text: { typed: true },
  hardBreak: { key: 'Shift-Enter' },
  attribute: { slash: 'attribute', view: true },
  xref: { slash: 'xref', view: true },
  kbd: { slash: 'kbd', view: true, bubble: true },
  // A page design's value, never in a module (a validation error there): inserted in a design's
  // region text, whose editor is #393.
  placeholder: { pending: '#393' },
  // Shown as its callout's number in the chosen variant (#547).
  calloutRef: { slash: 'calloutRef', view: true },
};

/** Inline types a module never holds, so the playground's sample module has none. */
const NOT_IN_MODULES = new Set(['placeholder']);

const MARKS: Readonly<Record<string, EditingUi>> = {
  strong: { bubble: true, key: 'Mod-b' },
  emphasis: { bubble: true, key: 'Mod-i' },
  code: { bubble: true, key: 'Mod-e' },
  ui: { bubble: true, key: 'Mod-Shift-u' },
  sub: { bubble: true, key: 'Mod-,' },
  sup: { bubble: true, key: 'Mod-.' },
  link: { slash: 'link', bubble: true, key: 'Mod-k' },
  // Shown (a dotted underline) but not yet inserted from the editor.
  term: { pending: '#247' },
};

const slashIds = new Set(SLASH_ITEMS.map((i) => i.id));

function checkUi(
  kind: 'block' | 'inline' | 'mark',
  type: string,
  ui: EditingUi,
) {
  const where = `${kind} ${type}`;
  expect(Object.keys(ui).length, `${where} has no editing UI`).toBeGreaterThan(
    0,
  );
  if (ui.slash)
    expect(slashIds.has(ui.slash), `${where}: "/" ${ui.slash}`).toBe(true);
  if (ui.view)
    expect(
      kind === 'block'
        ? (DOC_BLOCK_TYPES as readonly string[]).includes(type)
        : (INLINE_ATOMS as readonly string[]).includes(type),
      `${where}: its node view`,
    ).toBe(true);
  if (ui.bubble && kind === 'mark')
    expect(
      (BUBBLE_MARK_IDS as readonly string[]).includes(type) || type === 'link',
      `${where}: the selection bubble`,
    ).toBe(true);
}

describe('every type of the content model', () => {
  it('has an editing UI: blocks, inline types and marks', () => {
    expect(Object.keys(BLOCKS).sort(), 'block types').toEqual(members(Block));
    expect(Object.keys(INLINES).sort(), 'inline types').toEqual(
      members(Inline),
    );
    expect(Object.keys(MARKS).sort(), 'marks').toEqual(members(Mark));
    for (const [type, ui] of Object.entries(BLOCKS)) checkUi('block', type, ui);
    for (const [type, ui] of Object.entries(INLINES))
      checkUi('inline', type, ui);
    for (const [type, ui] of Object.entries(MARKS)) checkUi('mark', type, ui);
  });

  it('whose shortcut makes it, does', () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ slashMenu: null, bubble: null }),
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'p' },
            content: [{ type: 'text', text: 'abcdef' }],
          },
        ],
      },
    });
    const run = (key: string, from: number, to: number) => {
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, from, to),
        ),
      );
      editor.commands.keyboardShortcut(key);
    };
    run('Shift-Enter', 4, 4);
    let breaks = 0;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'hardBreak') breaks += 1;
    });
    expect(breaks, 'hardBreak').toBe(1);
    for (const [type, ui] of Object.entries(MARKS)) {
      if (!ui.key || type === 'link') continue;
      run(ui.key, 1, 3);
      expect(
        editor.state.doc.rangeHasMark(1, 3, editor.schema.marks[type]!),
        `${type} by ${ui.key}`,
      ).toBe(true);
    }
    editor.destroy();
  });

  it('is in the playground’s sample module, inline types and marks too', () => {
    const inlines = new Set<string>();
    const marks = new Set<string>();
    const blocks = new Set<string>();
    const visit = (content: readonly Inline[] | undefined) => {
      for (const n of content ?? []) {
        inlines.add(n.type);
        if (n.type === 'text') for (const m of n.marks ?? []) marks.add(m.type);
      }
    };
    for (const { node } of walk(SAMPLE_MODULE.blocks)) {
      if ('type' in node) blocks.add(node.type);
      const n = node as {
        content?: Inline[];
        title?: Inline[];
        hazard?: Inline[];
      };
      visit(n.content);
      visit(n.title);
      visit(n.hazard);
    }
    expect([...blocks].sort()).toEqual(members(Block));
    expect([...inlines].sort()).toEqual(
      members(Inline).filter((t) => !NOT_IN_MODULES.has(t)),
    );
    expect([...marks].sort()).toEqual(members(Mark));
  });
});

describe('the inline types in the block editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('are drawn by their views and offered by the "/" menu at a caret in text', async () => {
    const fixture = TestBed.createComponent(BlockEditorComponent);
    fixture.componentRef.setInput('value', toEditor(SAMPLE_MODULE));
    await fixture.whenStable();
    const editor = fixture.componentInstance.editor!;
    const el = fixture.nativeElement as HTMLElement;
    for (const type of INLINE_ATOMS)
      expect(
        el.querySelector(`[data-node="${type}"][contenteditable="false"]`),
        type,
      ).not.toBeNull();
    // The caret in the first paragraph's text.
    editor.commands.setTextSelection(3);
    for (const id of ['link', 'xref', 'attribute', 'kbd']) {
      const item = SLASH_ITEMS.find((i) => i.id === id)!;
      expect(item.available?.(editor.state, editor), id).toBe(true);
    }
  });
});
