import { getMarkRange, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
// The full entry, with zod: this file checks links and keys with their schemas at run time.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  isLinkHref,
  Kbd,
  walk,
  type Block,
  type Inline,
} from '@openfolia/content-model';

// The inline types the editor edits in a popover (a link, a cross-reference, a text attribute, a
// key combination, a callout reference): what the popover is asked to edit, and the commands that put its answer in
// the document. Framework-free; the block editor's popover (`inline-edit-popover.component.ts`)
// is the UI.

/** The inline atoms with a popover of their own. */
export const INLINE_ATOMS = ['xref', 'attribute', 'kbd', 'calloutRef'] as const;
export type InlineAtom = (typeof INLINE_ATOMS)[number];

export const isInlineAtom = (name: string): name is InlineAtom =>
  (INLINE_ATOMS as readonly string[]).includes(name);

/** A cross-reference's target as the document holds it. */
export interface XrefValue {
  readonly module: string;
  readonly block: string | null;
}

/**
 * What the popover edits, and where its answer goes: `from`..`to` is the range it replaces (an
 * atom's own position, a link's text, the selection, or the caret for something new).
 */
export type InlineEditRequest =
  | {
      readonly kind: 'link';
      readonly from: number;
      readonly to: number;
      /** The address it has (empty for a new link). */
      readonly href: string;
      /** The text it links (empty at a caret: the address is the text then). */
      readonly text: string;
      /** Whether the range is a link already (Remove is offered). */
      readonly linked: boolean;
    }
  | {
      readonly kind: 'xref';
      readonly from: number;
      readonly to: number;
      /** The cross-reference there now; null for a new one. */
      readonly current: XrefValue | null;
    }
  | {
      readonly kind: 'attribute';
      readonly from: number;
      readonly to: number;
      readonly current: string | null;
    }
  | {
      readonly kind: 'kbd';
      readonly from: number;
      readonly to: number;
      readonly current: readonly string[];
    }
  | {
      readonly kind: 'calloutRef';
      readonly from: number;
      readonly to: number;
      /** The callout it refers to now (an image of this module and one of its callouts); null for a new one. */
      readonly current: CalloutRefValue | null;
    };

/** A callout reference's target as the document holds it (#547). */
export interface CalloutRefValue {
  /** The image block. */
  readonly block: string;
  readonly callout: string;
}

/** The block editor's popover, as commands run on the editor reach it. */
export interface InlineEditor {
  open(request: InlineEditRequest): void;
}

const editors = new WeakMap<Editor, InlineEditor>();

/** Names the popover of `editor` (the block editor does, once made). */
export function setInlineEditor(editor: Editor, opener: InlineEditor): void {
  editors.set(editor, opener);
}

/** Whether `editor` has the popover (the block editor's do; a bare test editor does not). */
export function hasInlineEditor(editor: Editor): boolean {
  return editors.has(editor) && editor.isEditable;
}

/** Opens the popover for `request`; false when the editor has none, or can't be changed. */
export function openInlineEdit(
  editor: Editor,
  request: InlineEditRequest | null,
): boolean {
  const opener = editors.get(editor);
  if (!opener || !request || !editor.isEditable) return false;
  opener.open(request);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Where inline content may go

/** Whether a mark of this type may stand at the selection (text that is not code). */
export function canMark(state: EditorState, mark: string): boolean {
  const type = state.schema.marks[mark];
  const { $from } = state.selection;
  return (
    !!type &&
    $from.parent.isTextblock &&
    !$from.parent.type.spec.code &&
    $from.parent.type.allowsMarkType(type)
  );
}

/** Whether an inline node of this type may go at the selection. */
export function canInsertInline(state: EditorState, name: string): boolean {
  const type = state.schema.nodes[name];
  const { $from, $to } = state.selection;
  if (!type || !$from.parent.isTextblock || $from.parent.type.spec.code)
    return false;
  if ($from.parent !== $to.parent) return false;
  return $from.parent.canReplaceWith($from.index(), $to.index(), type);
}

// ---------------------------------------------------------------------------------------------
// Links

/** The link at the selection (the caret in one, or a selection inside one), with its range. */
function linkAround(
  state: EditorState,
): { from: number; to: number; href: string } | null {
  const type = state.schema.marks['link'];
  if (!type) return null;
  const { $from, from, to } = state.selection;
  const mark =
    type.isInSet($from.marks()) ??
    type.isInSet(state.doc.resolve(Math.min(from + 1, to)).marks());
  if (!mark) return null;
  const range =
    getMarkRange($from, type, mark.attrs) ??
    getMarkRange(state.doc.resolve(from + 1), type, mark.attrs);
  if (!range || range.from > from || range.to < to) return null;
  return { ...range, href: String(mark.attrs['href'] ?? '') };
}

/**
 * What the link popover opens on: the link at the selection (its whole text), else the selected
 * text, else the caret (a new link whose text is typed in the popover). Null where no link can
 * go (code, a code block, across blocks).
 */
export function linkRequest(state: EditorState): InlineEditRequest | null {
  if (!canMark(state, 'link')) return null;
  const { from, to, $from, $to } = state.selection;
  if ($from.parent !== $to.parent) return null;
  const around = linkAround(state);
  if (around)
    return {
      kind: 'link',
      from: around.from,
      to: around.to,
      href: around.href,
      text: state.doc.textBetween(around.from, around.to, ''),
      linked: true,
    };
  return {
    kind: 'link',
    from,
    to,
    href: '',
    text: state.doc.textBetween(from, to, ''),
    linked: false,
  };
}

/**
 * The address as the person typed it, made whole: trimmed, and with no scheme given, `mailto:`
 * for an e-mail address and `https://` for anything else. The result still has to pass
 * `isLinkHref`: a `javascript:` address keeps its scheme and is refused.
 */
export function completeHref(typed: string): string {
  const value = typed.trim();
  // A word and a colon is a scheme, kept (so a refused one stays refused), unless it is a host
  // with a port: "localhost:8080", "example.com:8443/x".
  const hostPort = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+([/?#]|$)/i.test(
    value,
  );
  if (!value || (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(value))) return value;
  if (/^[^@\s/:]+@[^@\s/:]+\.[^@\s/:]+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}

/** Whether `from`..`to` still lies within the document's one text block. */
function sameTextblock(state: EditorState, from: number, to: number): boolean {
  const size = state.doc.content.size;
  if (from < 0 || to > size || from > to) return false;
  const $from = state.doc.resolve(from);
  return $from.parent.isTextblock && $from.sameParent(state.doc.resolve(to));
}

/**
 * Links `request`'s range to `href` with `text` (the address itself when there is no text): the
 * text is replaced only when it changed, so its other formatting stays. Refuses an address
 * `isLinkHref` does not take, so no other address ever reaches the document. One undo step; the
 * caret after the link.
 */
export function applyLink(
  editor: Editor,
  request: Extract<InlineEditRequest, { kind: 'link' }>,
  href: string,
  text: string,
): boolean {
  if (!isLinkHref(href)) return false;
  const { state } = editor;
  const type = state.schema.marks['link'];
  if (!type || !sameTextblock(state, request.from, request.to)) return false;
  const words = text.replace(/[\r\n]+/g, ' ') || href;
  const tr = state.tr;
  let end = request.to;
  if (words !== state.doc.textBetween(request.from, request.to, '')) {
    const marks =
      state.doc
        .resolve(request.from)
        .marksAcross(state.doc.resolve(request.to)) ??
      state.doc.resolve(request.from).marks();
    tr.replaceWith(
      request.from,
      request.to,
      state.schema.text(words, type.removeFromSet(marks)),
    );
    end = request.from + words.length;
  }
  tr.removeMark(request.from, end, type);
  tr.addMark(request.from, end, type.create({ href }));
  tr.setSelection(TextSelection.create(tr.doc, end));
  tr.removeStoredMark(type);
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** Takes the link off `request`'s range; its text stays. */
export function removeLink(
  editor: Editor,
  request: Extract<InlineEditRequest, { kind: 'link' }>,
): boolean {
  const { state } = editor;
  const type = state.schema.marks['link'];
  if (!type || !sameTextblock(state, request.from, request.to)) return false;
  const tr = state.tr.removeMark(request.from, request.to, type);
  tr.setSelection(TextSelection.create(tr.doc, request.to));
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Inline atoms

/**
 * The popover's request for the atom at `pos` (a cross-reference, a text attribute or a key
 * combination), or null when there is none there.
 */
export function atomRequest(
  doc: ProseMirrorNode,
  pos: number,
): InlineEditRequest | null {
  const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null;
  if (!node || !isInlineAtom(node.type.name)) return null;
  const range = { from: pos, to: pos + node.nodeSize };
  const attrs = node.attrs;
  switch (node.type.name) {
    case 'xref':
      return {
        kind: 'xref',
        ...range,
        current: {
          module: String(attrs['module'] ?? ''),
          block: typeof attrs['block'] === 'string' ? attrs['block'] : null,
        },
      };
    case 'attribute':
      return {
        kind: 'attribute',
        ...range,
        current: typeof attrs['name'] === 'string' ? attrs['name'] : null,
      };
    case 'calloutRef':
      return {
        kind: 'calloutRef',
        ...range,
        current: {
          block: String(attrs['block'] ?? ''),
          callout: String(attrs['callout'] ?? ''),
        },
      };
    default:
      return {
        kind: 'kbd',
        ...range,
        current: Array.isArray(attrs['keys'])
          ? (attrs['keys'] as unknown[]).map(String)
          : [],
      };
  }
}

/** A request to insert a new atom of `kind` over the selection. */
export function newAtomRequest(
  state: EditorState,
  kind: InlineAtom,
): InlineEditRequest | null {
  if (!canInsertInline(state, kind)) return null;
  const { from, to } = state.selection;
  switch (kind) {
    case 'xref':
      return { kind, from, to, current: null };
    case 'attribute':
      return { kind, from, to, current: null };
    case 'calloutRef':
      return { kind, from, to, current: null };
    default: {
      // Selected text such as "Ctrl+S" becomes the keys.
      const keys = parseKeys(state.doc.textBetween(from, to, ''));
      return { kind, from, to, current: keys ?? [] };
    }
  }
}

/**
 * What the popover opens on at the selection: a selected atom, else the link at the caret.
 * Enter on a selected atom and Mod+K use it.
 */
export function requestAtSelection(
  state: EditorState,
): InlineEditRequest | null {
  const { selection } = state;
  if (
    selection instanceof NodeSelection &&
    isInlineAtom(selection.node.type.name)
  )
    return atomRequest(state.doc, selection.from);
  return linkRequest(state);
}

/**
 * Puts `attrs`' atom of `kind` over `from`..`to` (an existing one keeps its other attributes,
 * such as a cross-reference's text), selected, in one undo step.
 */
export function putAtom(
  editor: Editor,
  request: Extract<InlineEditRequest, { kind: InlineAtom }>,
  attrs: Record<string, unknown>,
): boolean {
  const { state } = editor;
  const type = state.schema.nodes[request.kind];
  if (!type || !sameTextblock(state, request.from, request.to)) return false;
  const existing = state.doc.nodeAt(request.from);
  const keep =
    existing?.type === type && request.to - request.from === existing.nodeSize
      ? existing.attrs
      : {};
  const $from = state.doc.resolve(request.from);
  const node = type.create({ ...keep, ...attrs }, null, $from.marks());
  if (!$from.parent.canReplaceWith($from.index(), $from.indexAfter(), type))
    return false;
  const tr = state.tr.replaceWith(request.from, request.to, node);
  tr.setSelection(TextSelection.create(tr.doc, request.from + node.nodeSize));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/**
 * The keys of a combination as typed: "Ctrl + Shift + S" is `Ctrl`, `Shift`, `S`; a doubled plus
 * ("Ctrl++") is the plus key. Null when a key is empty or holds what the model refuses (a line
 * break or "]").
 */
export function parseKeys(typed: string): string[] | null {
  const text = typed.trim();
  if (!text) return null;
  const keys: string[] = [];
  const parts = text.split('+');
  for (let i = 0; i < parts.length; i++) {
    const part = (parts[i] as string).trim();
    if (part) {
      keys.push(part);
      continue;
    }
    // Two pluses in a row, or a plus at the end after a key: the plus key itself.
    if (i + 1 < parts.length && !(parts[i + 1] as string).trim()) {
      keys.push('+');
      i++;
      continue;
    }
    return null;
  }
  return Kbd.safeParse({ type: 'kbd', keys }).success ? keys : null;
}

/** The keys as the field shows them: `Ctrl+Shift+S`. */
export const formatKeys = (keys: readonly string[]): string => keys.join('+');

// ---------------------------------------------------------------------------------------------
// Cross-reference targets

/** What a cross-reference can point at in a module. */
export type XrefTargetKind =
  'section' | 'figure' | 'table' | 'procedure' | 'step';

export interface XrefTarget {
  readonly block: string;
  readonly kind: XrefTargetKind;
  /** Its title or first words; empty when it has none (the kind names it then). */
  readonly label: string;
  /** Nesting, for indenting the list: 0 for the module's own blocks. */
  readonly depth: number;
}

/** Past this many characters a target's words are cut. */
const LABEL_MAX = 80;

const short = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1)}…` : one;
};

const inlineWords = (content: readonly Inline[] | undefined): string =>
  (content ?? [])
    .map((n) =>
      n.type === 'text'
        ? n.text
        : n.type === 'attribute'
          ? `{${n.name}}`
          : n.type === 'kbd'
            ? n.keys.join('+')
            : n.type === 'hardBreak'
              ? ' '
              : n.type === 'placeholder'
                ? `[${n.key}]`
                : n.type === 'calloutRef'
                  ? ''
                  : (n.text?.map((r) => r.text).join('') ?? ''),
    )
    .join('');

/** The targets in an editor document, in reading order. */
export function docTargets(doc: ProseMirrorNode): XrefTarget[] {
  const out: XrefTarget[] = [];
  const titleOf = (node: ProseMirrorNode) =>
    node.firstChild?.type.name === 'title' ? node.firstChild.textContent : '';
  const walk = (parent: ProseMirrorNode, depth: number) =>
    parent.forEach((node) => {
      const id = node.attrs['id'];
      const name = node.type.name;
      const has = typeof id === 'string' && id.length > 0;
      if (has && name === 'section')
        out.push({
          block: id,
          kind: 'section',
          label: short(titleOf(node)),
          depth,
        });
      else if (has && name === 'table')
        out.push({
          block: id,
          kind: 'table',
          label: short(titleOf(node)),
          depth,
        });
      else if (has && name === 'image')
        out.push({
          block: id,
          kind: 'figure',
          label: short(titleOf(node) || String(node.attrs['alt'] ?? '')),
          depth,
        });
      else if (has && name === 'procedure')
        out.push({
          block: id,
          kind: 'procedure',
          label: short(titleOf(node)),
          depth,
        });
      else if (has && name === 'listItem' && parent.type.name === 'procedure')
        out.push({
          block: id,
          kind: 'step',
          label: short(node.firstChild?.textContent ?? ''),
          depth,
        });
      if (!node.isTextblock && !node.isAtom)
        walk(
          node,
          name === 'section' || name === 'procedure' ? depth + 1 : depth,
        );
    });
  walk(doc, 0);
  return out;
}

/** The targets in a module's blocks (another module's, as the API reads it), in reading order. */
export function blockTargets(blocks: readonly Block[]): XrefTarget[] {
  const out: XrefTarget[] = [];
  const walk = (list: readonly Block[], depth: number) => {
    for (const block of list) {
      switch (block.type) {
        case 'section':
          out.push({
            block: block.id,
            kind: 'section',
            label: short(inlineWords(block.title)),
            depth,
          });
          walk(block.blocks, depth + 1);
          break;
        case 'table':
          out.push({
            block: block.id,
            kind: 'table',
            label: short(inlineWords(block.title)),
            depth,
          });
          for (const row of block.rows)
            for (const cell of row.cells) walk(cell.blocks, depth);
          break;
        case 'image':
          out.push({
            block: block.id,
            kind: 'figure',
            label: short(inlineWords(block.title) || block.alt),
            depth,
          });
          break;
        case 'procedure':
          out.push({
            block: block.id,
            kind: 'procedure',
            label: short(inlineWords(block.title)),
            depth,
          });
          for (const step of block.steps) {
            out.push({
              block: step.id,
              kind: 'step',
              label: short(inlineWords(step.content)),
              depth: depth + 1,
            });
            walk(step.blocks, depth + 2);
          }
          break;
        case 'list':
          for (const item of block.items) walk(item.blocks, depth);
          break;
        case 'safety':
        case 'admonition':
        case 'faq':
        case 'variant':
          walk(block.blocks, depth);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks, 0);
  return out;
}

/**
 * Every block and item ID in an editor document: what a cross-reference may point at (the model
 * anchors each one), beside the targets the picker offers.
 */
export function docBlockIds(doc: ProseMirrorNode): Set<string> {
  const out = new Set<string>();
  doc.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string' && id) out.add(id);
    return !node.isTextblock;
  });
  return out;
}

/** Every block and item ID in a module's blocks (another module's, as the API reads it). */
export function blockIds(blocks: readonly Block[]): Set<string> {
  const out = new Set<string>();
  for (const { node } of walk(blocks))
    if (typeof node.id === 'string' && node.id) out.add(node.id);
  return out;
}

/** The modules a document refers to with module references, each once, in reading order. */
export function referencedModules(doc: ProseMirrorNode): string[] {
  const out = new Set<string>();
  doc.descendants((node) => {
    const module = node.attrs['module'];
    if (node.type.name === 'moduleRef' && typeof module === 'string' && module)
      out.add(module);
    return !node.isTextblock;
  });
  return [...out];
}
