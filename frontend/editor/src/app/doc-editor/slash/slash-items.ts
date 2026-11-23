import type { Editor, Range } from '@tiptap/core';
import type { Command, EditorState } from '@tiptap/pm/state';

import { MAX_SECTION_DEPTH } from '@openfolia/content-model/core';

import {
  headingCap,
  headingRefusal,
  refusalText,
  setHeadingLevel,
} from '../plugins/heading-levels';
import { toggleList } from '../plugins/structure';
import { insertTable, tableAt } from '../plugins/table-editing';
import { insertStepResult } from '../plugins/procedure-steps';
import {
  canPickAttachment,
  canPickImage,
  insertAdmonition,
  insertAttachment,
  insertFaq,
  insertImage,
  insertLiteral,
  insertPageBreak,
  insertProcedure,
  insertModuleRef,
  insertSafety,
  insertVariant,
  pickAndInsertAttachment,
  pickAndInsertImage,
} from '../blocks/doc-blocks';
import {
  canInsertSnippet,
  canPickSnippet,
  pickAndInsertSnippet,
} from '../snippets/snippet-blocks';
import {
  canInsertInline,
  hasInlineEditor,
  linkRequest,
  newAtomRequest,
  openInlineEdit,
  type InlineAtom,
} from '../inline/inline-edit';
import {
  canInsertTerm,
  canPickTerm,
  pickAndInsertTerm,
} from '../writing/term-insert';

/** A text as a translation key and its parameters. */
export interface SlashText {
  key: string;
  params?: Readonly<Record<string, unknown>>;
}

/** One entry of the slash menu: what it shows, what finds it and what it does. */
export interface SlashItem {
  id: string;
  /** A translation key. */
  label: string;
  /** The label's parameters, if it has any. */
  labelParams?: Readonly<Record<string, unknown>>;
  /** A short hint shown at the end of the row (a translation key). */
  hint: string;
  /** The hint's parameters, if it has any. */
  hintParams?: Readonly<Record<string, unknown>>;
  /** A lucide icon name registered by the menu. */
  icon: string;
  /** Extra words that find it besides its label: search aliases, never shown. */
  terms: readonly string[];
  /**
   * Whether it is offered at all (a heading level within the cap; a section only directly in a
   * flow; an image only where the page offers the image picker); always, if absent.
   */
  available?: (state: EditorState, editor?: Editor) => boolean;
  /**
   * Why it can't run at the caret, shown in place of the hint on a disabled row (a heading level
   * that would skip one, a heading inside a variant block); null or absent when it can.
   */
  reason?: (state: EditorState) => SlashText | null;
  /**
   * Offered in a procedure step's own text, where the menu offers only these (everything else is
   * offered in a paragraph only).
   */
  inStep?: true;
  /** Runs it in place of the typed `/query`. */
  run: (editor: Editor, range: Range) => void;
  /**
   * The toolbar's Insert menu group it is in; absent: offered by "/" only. One list builds both
   * menus, so a new block type joins them with one entry here.
   */
  group?: InsertGroup;
  /** Whether it can run at the selection; the Insert menu shows it disabled otherwise. */
  can?: (state: EditorState, editor?: Editor) => boolean;
  /** Why it is not offered here (`available` false), as the Insert menu says it. */
  unavailable?: (state: EditorState, editor?: Editor) => SlashText | null;
}

/** The Insert menu's groups, in its order. */
export const INSERT_GROUPS = ['content', 'notices', 'structure'] as const;
export type InsertGroup = (typeof INSERT_GROUPS)[number];

/** Deletes the typed `/query`, then runs the command on the paragraph that is left. */
const replacing =
  (command: Command | null) => (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).run();
    if (command) command(editor.state, editor.view.dispatch, editor.view);
  };

/** Words that find each heading level besides "heading". */
const HEADING_TERMS: Readonly<Record<number, readonly string[]>> = {
  1: ['title', 'chapter', 'section'],
  2: ['subheading', 'subsection', 'section'],
  3: ['subheading', 'subsection'],
};

/** Heading 1 to the model's deepest level, each offered up to the configured cap. */
const HEADING_ITEMS: readonly SlashItem[] = Array.from(
  { length: MAX_SECTION_DEPTH },
  (_, i): SlashItem => {
    const level = i + 1;
    return {
      id: `heading${level}`,
      label: 'editor.docEditor.slash.heading',
      labelParams: { level },
      hint: 'editor.docEditor.slash.headingHint',
      hintParams: { level, parent: level - 1 },
      icon: 'lucideHeading',
      terms: ['heading', `h${level}`, ...(HEADING_TERMS[level] ?? [])],
      available: (state) => level <= headingCap(state),
      reason: (state) => {
        const refusal = headingRefusal(state, level);
        return refusal ? refusalText(state, refusal, level) : null;
      },
      run: replacing(setHeadingLevel(level)),
    };
  },
);

/** Deletes the typed `/query`, then opens the popover for a new inline atom at the caret. */
const inlineAtom =
  (kind: InlineAtom) =>
  (editor: Editor, range: Range): void => {
    editor.chain().focus().deleteRange(range).run();
    openInlineEdit(editor, newAtomRequest(editor.state, kind));
  };

/** Where an inline atom may be offered: the editor has its popover, and it may go at the caret. */
const inlineAvailable =
  (kind: string) =>
  (state: EditorState, editor?: Editor): boolean =>
    !!editor && hasInlineEditor(editor) && canInsertInline(state, kind);

/** The inline types the "/" menu inserts at the caret, each through its popover. */
export const INLINE_SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'link',
    label: 'editor.docEditor.slash.link',
    hint: 'editor.docEditor.slash.linkHint',
    icon: 'lucideLink',
    terms: ['link', 'url', 'address', 'web', 'href', 'mail'],
    inStep: true,
    available: (state, editor) =>
      !!editor && hasInlineEditor(editor) && linkRequest(state) !== null,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      openInlineEdit(editor, linkRequest(editor.state));
    },
  },
  {
    id: 'xref',
    label: 'editor.docEditor.slash.xref',
    hint: 'editor.docEditor.slash.xrefHint',
    icon: 'lucideFileSymlink',
    terms: ['cross', 'reference', 'xref', 'see', 'refer', 'anchor'],
    inStep: true,
    available: inlineAvailable('xref'),
    run: inlineAtom('xref'),
  },
  {
    id: 'attribute',
    label: 'editor.docEditor.slash.attribute',
    hint: 'editor.docEditor.slash.attributeHint',
    icon: 'lucideBraces',
    terms: ['attribute', 'variable', 'version', 'product', 'name', 'value'],
    inStep: true,
    available: inlineAvailable('attribute'),
    run: inlineAtom('attribute'),
  },
  {
    id: 'kbd',
    label: 'editor.docEditor.slash.kbd',
    hint: 'editor.docEditor.slash.kbdHint',
    icon: 'lucideKeyboard',
    terms: ['key', 'keyboard', 'shortcut', 'kbd', 'press', 'hotkey'],
    inStep: true,
    available: inlineAvailable('kbd'),
    run: inlineAtom('kbd'),
  },
  {
    id: 'term',
    label: 'editor.docEditor.slash.term',
    hint: 'editor.docEditor.slash.termHint',
    icon: 'lucideBookOpen',
    terms: ['term', 'glossary', 'word', 'concept', 'vocabulary'],
    inStep: true,
    // Only where the page offers the term picker: the term is chosen before it goes in.
    available: (state, editor) =>
      !!editor && canPickTerm(editor) && canInsertTerm(state),
    group: 'content',
    unavailable: (_state, editor) =>
      editor && canPickTerm(editor)
        ? null
        : { key: 'editor.docEditor.insert.termUnavailable' },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      void pickAndInsertTerm(editor);
    },
  },
  {
    id: 'calloutRef',
    label: 'editor.docEditor.slash.calloutRef',
    hint: 'editor.docEditor.slash.calloutRefHint',
    icon: 'lucideMapPin',
    terms: ['callout', 'number', 'position', 'marker', 'legend', 'figure'],
    inStep: true,
    available: inlineAvailable('calloutRef'),
    run: inlineAtom('calloutRef'),
  },
];

/**
 * The blocks the editor can edit: text, headings (Heading 1 to the cap), lists, tables and the
 * documentation blocks (safety notice, variant block, module reference, image, attachment, note,
 * FAQ entry, procedure, code block), and in a procedure's step, its result.
 */
export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'paragraph',
    label: 'editor.docEditor.slash.paragraph',
    hint: 'editor.docEditor.slash.paragraphHint',
    icon: 'lucidePilcrow',
    terms: ['paragraph', 'plain'],
    run: replacing(null),
  },
  ...HEADING_ITEMS,
  {
    id: 'bulletList',
    label: 'editor.docEditor.slash.bulletList',
    hint: 'editor.docEditor.slash.bulletListHint',
    icon: 'lucideList',
    terms: ['bullet', 'unordered', 'ul'],
    run: replacing(toggleList(false)),
  },
  {
    id: 'orderedList',
    label: 'editor.docEditor.slash.orderedList',
    hint: 'editor.docEditor.slash.orderedListHint',
    icon: 'lucideListOrdered',
    terms: ['ordered', 'number', 'steps', 'ol'],
    run: replacing(toggleList(true)),
  },
  {
    id: 'table',
    label: 'editor.docEditor.slash.table',
    hint: 'editor.docEditor.slash.tableHint',
    icon: 'lucideTable',
    terms: ['table', 'grid', 'rows', 'cells'],
    // Not in a table's cell: a table holds no table.
    available: (state) => !tableAt(state),
    group: 'content',
    unavailable: (state) =>
      tableAt(state) ? { key: 'editor.docEditor.insert.tableInTable' } : null,
    can: (state) => insertTable(state),
    run: replacing(insertTable),
  },
  {
    id: 'safety',
    label: 'editor.docEditor.slash.safety',
    hint: 'editor.docEditor.slash.safetyHint',
    icon: 'lucideTriangleAlert',
    terms: ['safety', 'warning', 'danger', 'caution', 'notice', 'hazard'],
    group: 'notices',
    can: (state) => insertSafety(state),
    run: replacing(insertSafety),
  },
  {
    id: 'variant',
    label: 'editor.docEditor.slash.variant',
    hint: 'editor.docEditor.slash.variantHint',
    icon: 'lucideSplit',
    terms: ['variant', 'condition', 'conditional', 'only'],
    group: 'structure',
    can: (state) => insertVariant(state),
    run: replacing(insertVariant),
  },
  {
    id: 'moduleRef',
    label: 'editor.docEditor.slash.moduleRef',
    hint: 'editor.docEditor.slash.moduleRefHint',
    icon: 'lucideLink',
    terms: ['module', 'reference', 'reuse', 'include', 'shared'],
    group: 'structure',
    can: (state) => insertModuleRef(state),
    run: replacing(insertModuleRef),
  },
  {
    id: 'snippet',
    label: 'editor.docEditor.slash.snippet',
    hint: 'editor.docEditor.slash.snippetHint',
    icon: 'lucideTextQuote',
    terms: ['snippet', 'phrase', 'boilerplate', 'standard', 'reuse', 'text'],
    // Only where the page offers the module picker: the snippet is chosen before it goes in.
    available: (state, editor) =>
      !!editor && canPickSnippet(editor) && canInsertSnippet(state),
    group: 'content',
    unavailable: (_state, editor) =>
      editor && canPickSnippet(editor)
        ? null
        : { key: 'editor.docEditor.insert.snippetUnavailable' },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      void pickAndInsertSnippet(editor);
    },
  },
  {
    id: 'image',
    label: 'editor.docEditor.slash.image',
    hint: 'editor.docEditor.slash.imageHint',
    icon: 'lucideImage',
    terms: ['image', 'picture', 'figure', 'photo', 'illustration', 'upload'],
    // Only where the page offers the image picker: it is chosen before it is inserted.
    available: (state, editor) =>
      !!editor && canPickImage(editor) && insertImage(null)(state),
    group: 'content',
    unavailable: (_state, editor) =>
      editor && canPickImage(editor)
        ? null
        : { key: 'editor.docEditor.insert.imageUnavailable' },
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      void pickAndInsertImage(editor);
    },
  },
  {
    id: 'attachment',
    label: 'editor.docEditor.slash.attachment',
    hint: 'editor.docEditor.slash.attachmentHint',
    icon: 'lucidePaperclip',
    terms: ['attachment', 'file', 'attach', 'download', 'zip', 'upload'],
    group: 'content',
    unavailable: (_state, editor) =>
      editor && canPickAttachment(editor)
        ? null
        : { key: 'editor.docEditor.insert.attachmentUnavailable' },
    // Only where the page offers the attach-file dialog: it is chosen before it is inserted.
    available: (state, editor) =>
      !!editor && canPickAttachment(editor) && insertAttachment(null)(state),
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      void pickAndInsertAttachment(editor);
    },
  },
  {
    id: 'admonition',
    label: 'editor.docEditor.slash.admonition',
    hint: 'editor.docEditor.slash.admonitionHint',
    icon: 'lucideInfo',
    terms: ['note', 'tip', 'important', 'admonition', 'callout', 'hint'],
    group: 'notices',
    can: (state) => insertAdmonition(state),
    run: replacing(insertAdmonition),
  },
  {
    id: 'faq',
    label: 'editor.docEditor.slash.faq',
    hint: 'editor.docEditor.slash.faqHint',
    icon: 'lucideMessageCircleQuestionMark',
    terms: ['faq', 'question', 'answer', 'q&a', 'qanda', 'frequently'],
    group: 'content',
    can: (state) => insertFaq(state),
    run: replacing(insertFaq),
  },
  {
    id: 'procedure',
    label: 'editor.docEditor.slash.procedure',
    hint: 'editor.docEditor.slash.procedureHint',
    icon: 'lucideListChecks',
    terms: ['procedure', 'steps', 'task', 'instructions', 'how'],
    group: 'structure',
    can: (state) => insertProcedure(state),
    run: replacing(insertProcedure),
  },
  {
    id: 'stepResult',
    label: 'editor.docEditor.slash.stepResult',
    hint: 'editor.docEditor.slash.stepResultHint',
    icon: 'lucideCornerDownRight',
    terms: ['result', 'outcome', 'step'],
    inStep: true,
    // Only in a procedure's step that has no result yet.
    available: (state) => insertStepResult(state),
    run: replacing(insertStepResult),
  },
  {
    id: 'literal',
    label: 'editor.docEditor.slash.literal',
    hint: 'editor.docEditor.slash.literalHint',
    icon: 'lucideCodeXml',
    terms: ['code', 'literal', 'preformatted', 'terminal', 'snippet', 'pre'],
    group: 'content',
    can: (state) => insertLiteral(state),
    run: replacing(insertLiteral),
  },
  {
    id: 'pageBreak',
    label: 'editor.docEditor.slash.pageBreak',
    hint: 'editor.docEditor.slash.pageBreakHint',
    icon: 'lucideSeparatorHorizontal',
    terms: ['page', 'break', 'pagebreak', 'new page', 'pdf'],
    group: 'structure',
    can: (state) => insertPageBreak(state),
    run: replacing(insertPageBreak),
  },
  ...INLINE_SLASH_ITEMS,
];

/**
 * What the focused editor offers (a contributor's suggestion, #137): text, the two lists, links,
 * images and attachments; no headings, tables, notices, procedures, variant blocks, module
 * references or other structure.
 */
const FOCUSED_IDS: ReadonlySet<string> = new Set([
  'paragraph',
  'bulletList',
  'orderedList',
  'image',
  'attachment',
  'link',
]);

/** The "/" and Insert menu items of the focused editor, in `SLASH_ITEMS` order. */
export const FOCUSED_SLASH_ITEMS: readonly SlashItem[] = SLASH_ITEMS.filter(
  (item) => FOCUSED_IDS.has(item.id),
);

/**
 * A placeholder (#393): a page design's data field at the caret, chosen from the `{` menu this
 * item opens (it types the `{`), so only a known key ever goes in.
 */
export const PLACEHOLDER_SLASH_ITEM: SlashItem = {
  id: 'placeholder',
  label: 'editor.docEditor.slash.placeholder',
  hint: 'editor.docEditor.slash.placeholderHint',
  icon: 'lucideBraces',
  terms: ['placeholder', 'field', 'data', 'value', 'version', 'date', '{'],
  inStep: true,
  group: 'content',
  available: (state) => canInsertInline(state, 'placeholder'),
  can: (state) => canInsertInline(state, 'placeholder'),
  run: (editor, range) => {
    editor.chain().focus().deleteRange(range).insertContent('{').run();
  },
};

/**
 * What a page design region's editor offers (#393): text, Heading 1 (a region's headings are
 * one level deep), the two lists, images, notes, links and placeholders; no tables, notices,
 * procedures, variant blocks, module references, cross-references or page breaks.
 */
const REGION_IDS: ReadonlySet<string> = new Set([
  'paragraph',
  'heading1',
  'bulletList',
  'orderedList',
  'image',
  'admonition',
  'link',
  'placeholder',
]);

/** The "/" and Insert menu items of a region's editor, in `SLASH_ITEMS` order, then the placeholder. */
export const REGION_SLASH_ITEMS: readonly SlashItem[] = [
  ...SLASH_ITEMS,
  PLACEHOLDER_SLASH_ITEM,
].filter((item) => REGION_IDS.has(item.id));

/**
 * The items matching `query` in the label as shown, best first: a label starting with it, then a word of the label
 * starting with it, then a search term, then anything containing it. An empty query keeps all,
 * in their order.
 */
export function filterSlashItems(
  items: readonly SlashItem[],
  query: string,
  /** The label as the person reads it (labels are translation keys, some with parameters). */
  text: (key: string, params?: Readonly<Record<string, unknown>>) => string = (
    key,
  ) => key,
): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const rank = (item: SlashItem): number => {
    const label = text(item.label, item.labelParams).toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.split(/\s+/).some((word) => word.startsWith(q))) return 1;
    if (item.terms.some((term) => term.startsWith(q))) return 2;
    if (label.includes(q) || item.terms.some((term) => term.includes(q)))
      return 3;
    return -1;
  };
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

/** One entry of the Insert menu at the selection: whether it can run, and why not. */
export interface InsertEntry {
  readonly item: SlashItem;
  /** Null when it can run here. */
  readonly reason: SlashText | null;
}

/** A reason for an entry that can't go at the caret and says no more. */
const NOT_HERE: SlashText = { key: 'editor.docEditor.insert.notHere' };

/** The Insert menu at the selection, by group: every block of the "/" menu that has a group. */
export function insertEntries(
  state: EditorState,
  editor?: Editor,
  items: readonly SlashItem[] = SLASH_ITEMS,
): { group: InsertGroup; entries: InsertEntry[] }[] {
  return INSERT_GROUPS.map((group) => ({
    group,
    entries: items
      .filter((item) => item.group === group)
      .map((item): InsertEntry => {
        if (item.available && !item.available(state, editor))
          return {
            item,
            reason: item.unavailable?.(state, editor) ?? NOT_HERE,
          };
        const reason = item.reason?.(state) ?? null;
        if (reason) return { item, reason };
        if (item.can && !item.can(state, editor))
          return {
            item,
            reason: item.unavailable?.(state, editor) ?? NOT_HERE,
          };
        return { item, reason: null };
      }),
  }));
}

/** Runs an Insert menu entry at the selection (no typed query to replace). */
export function runInsertEntry(editor: Editor, item: SlashItem): void {
  const { from } = editor.state.selection;
  item.run(editor, { from, to: from });
}
