import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import {
  checkWritingText,
  MAX_WRITING_CHARS,
  plainTextOf,
  type TextFinding,
  type WritingRules,
} from '@openfolia/content-model/core';

import {
  checkedFields,
  type CheckedFieldName,
  fieldContent,
  rangeIn,
} from './writing-fields';

// The writing checks while typing (#247), on the engine the API's checks use (#55,
// `checkWritingText`): forbidden and deprecated terms and the configured style rules, per text
// field, shown as a dotted underline with an icon at the field's end of the line (never colour
// alone). Off the typing path: a check runs once typing pauses (`DEBOUNCE_MS`, at the latest
// `MAX_WAIT_MS` after the first change), and only on the fields that changed since the last
// one (a field's findings are kept by its node, which an edit elsewhere leaves as it is). Each
// field is held to the engine's bounds, and a pass reads at most `MAX_WRITING_CHARS` of changed
// text. Between checks the underlines follow the text as it moves.
//
// The page's own suggestions on the text (the model-based style review's, #573) are marked too
// (`setSuggestionMarks`), where their field still reads as when they were made.

/** A check waits for this long a pause in typing. */
export const DEBOUNCE_MS = 300;
/** A check runs at the latest this long after the first change it has not seen. */
export const MAX_WAIT_MS = 1_200;

/** A finding at its place in the document. */
export interface PlacedFinding extends TextFinding {
  /** Stable while the field's text before it stays: field, rule and offset. */
  readonly id: string;
  readonly blockId: string;
  readonly field: CheckedFieldName;
  /** Its range in the document now. */
  readonly from: number;
  readonly to: number;
  /** The field's plain text when it was found. */
  readonly fieldText: string;
  /** What "Ignore here" keeps: the field, the rule and the text found. */
  readonly ignoreKey: string;
}

/** A suggestion of the page's on a field's text (a style review's), to mark in the text. */
export interface SuggestionMark {
  readonly id: string;
  readonly blockId: string;
  readonly field: string;
  readonly start: number;
  readonly end: number;
  /** The field's whole plain text it was made for: not marked once the field reads otherwise. */
  readonly expected: string;
}

/** A suggestion mark at its place in the document. */
export interface PlacedMark extends SuggestionMark {
  readonly from: number;
  readonly to: number;
}

interface WritingState {
  readonly rules: WritingRules | null;
  readonly findings: readonly PlacedFinding[];
  readonly marks: readonly SuggestionMark[];
  readonly placed: readonly PlacedMark[];
  /** "Ignore here": per field, rule and text found (for this editing session). */
  readonly ignored: ReadonlySet<string>;
  /** The document changed since the last check (or the rules did). */
  readonly stale: boolean;
  readonly decorations: DecorationSet;
}

type Meta =
  | { readonly rules: WritingRules | null }
  | { readonly marks: readonly SuggestionMark[] }
  | {
      readonly result: {
        readonly findings: readonly PlacedFinding[];
        readonly placed: readonly PlacedMark[];
      };
    }
  | { readonly ignore: string };

export const writingChecksKey = new PluginKey<WritingState>(
  'docEditorWritingChecks',
);

const ruleKey = (f: TextFinding): string =>
  f.rule.kind === 'term'
    ? `term:${f.rule.termId}`
    : f.rule.kind === 'style'
      ? `style:${f.rule.ruleId}`
      : 'sentence';

const ignoreKeyOf = (blockId: string, field: string, f: TextFinding) =>
  JSON.stringify([blockId, field, ruleKey(f), f.text.toLowerCase()]);

function decorate(
  doc: ProseMirrorNode,
  findings: readonly PlacedFinding[],
  placed: readonly PlacedMark[],
): DecorationSet {
  if (findings.length === 0 && placed.length === 0) return DecorationSet.empty;
  const out: Decoration[] = [];
  const fields = new Map<number, ProseMirrorNode>();
  for (const f of findings) {
    out.push(
      Decoration.inline(
        f.from,
        f.to,
        {
          class: 'doc-editor-finding',
          'data-finding': f.id,
          'data-severity': f.severity,
        },
        { finding: f.id },
      ),
    );
    const $from = doc.resolve(f.from);
    fields.set($from.before(), $from.parent);
  }
  for (const [pos, node] of fields) {
    out.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'doc-editor-has-finding',
      }),
      // The icon is an element of its own, not the field's ::after: a safety notice's fields
      // draw their labels (Hazard, Consequence, Measure) with that.
      // After the field's start (side 1): Enter there takes it along with the text.
      Decoration.widget(pos + 1, findingIcon, {
        side: 1,
        key: 'finding-icon',
        ignoreSelection: true,
      }),
    );
  }
  for (const m of placed) {
    out.push(
      Decoration.inline(
        m.from,
        m.to,
        { class: 'doc-editor-suggestion-mark', 'data-suggestion': m.id },
        { suggestion: m.id },
      ),
    );
  }
  return DecorationSet.create(doc, out);
}

/** The icon beside a field with a finding: placed outside the text, read by no one. */
function findingIcon(view: EditorView): HTMLElement {
  const icon = view.dom.ownerDocument.createElement('span');
  icon.className = 'doc-editor-finding-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.contentEditable = 'false';
  return icon;
}

function mapFindings(
  tr: Transaction,
  findings: readonly PlacedFinding[],
): PlacedFinding[] {
  const out: PlacedFinding[] = [];
  for (const f of findings) {
    const from = tr.mapping.mapResult(f.from, 1);
    const to = tr.mapping.mapResult(f.to, -1);
    if (from.deleted && to.deleted) continue;
    if (to.pos <= from.pos) continue;
    out.push({ ...f, from: from.pos, to: to.pos });
  }
  return out;
}

function mapMarks(
  tr: Transaction,
  placed: readonly PlacedMark[],
): PlacedMark[] {
  const out: PlacedMark[] = [];
  for (const m of placed) {
    const from = tr.mapping.map(m.from, 1);
    const to = tr.mapping.map(m.to, -1);
    if (to > from) out.push({ ...m, from, to });
  }
  return out;
}

function apply(
  tr: Transaction,
  value: WritingState,
  newState: EditorState,
): WritingState {
  const meta = tr.getMeta(writingChecksKey) as Meta | undefined;
  if (meta && 'rules' in meta) {
    return {
      ...value,
      rules: meta.rules,
      findings: meta.rules ? value.findings : [],
      stale: true,
      decorations: meta.rules
        ? value.decorations.map(tr.mapping, tr.doc)
        : decorate(newState.doc, [], value.placed),
    };
  }
  if (meta && 'marks' in meta) {
    return { ...value, marks: meta.marks, stale: true };
  }
  if (meta && 'result' in meta) {
    const { findings, placed } = meta.result;
    return {
      ...value,
      findings,
      placed,
      stale: false,
      decorations: decorate(newState.doc, findings, placed),
    };
  }
  if (meta && 'ignore' in meta) {
    const ignored = new Set(value.ignored).add(meta.ignore);
    const findings = value.findings.filter((f) => f.ignoreKey !== meta.ignore);
    return {
      ...value,
      ignored,
      findings,
      decorations: decorate(newState.doc, findings, value.placed),
    };
  }
  if (!tr.docChanged) return value;
  return {
    ...value,
    findings: mapFindings(tr, value.findings),
    placed: mapMarks(tr, value.placed),
    stale: true,
    decorations: value.decorations.map(tr.mapping, tr.doc),
  };
}

/** The findings shown now, in document order. */
export function writingFindings(state: EditorState): readonly PlacedFinding[] {
  return writingChecksKey.getState(state)?.findings ?? [];
}

/** The page's suggestions marked now. */
export function suggestionMarks(state: EditorState): readonly PlacedMark[] {
  return writingChecksKey.getState(state)?.placed ?? [];
}

/** The finding at position `pos` (the caret inside it or at its edge), if any. */
export function findingAt(
  state: EditorState,
  pos: number,
): PlacedFinding | null {
  return (
    writingFindings(state).find((f) => f.from <= pos && pos <= f.to) ?? null
  );
}

/** The page's suggestion marked at `pos`, if any. */
export function suggestionAt(
  state: EditorState,
  pos: number,
): PlacedMark | null {
  return (
    suggestionMarks(state).find((m) => m.from <= pos && pos <= m.to) ?? null
  );
}

const dispatchMeta = (view: EditorView, meta: Meta) =>
  view.dispatch(
    view.state.tr
      .setMeta(writingChecksKey, meta)
      .setMeta('addToHistory', false),
  );

/** Checks with `rules` from now on (null: no checks). Not an edit: no undo step. */
export function setWritingRules(
  view: EditorView,
  rules: WritingRules | null,
): void {
  if (writingChecksKey.getState(view.state)?.rules === rules) return;
  dispatchMeta(view, { rules });
}

/** Marks the page's suggestions in place of those marked so far. */
export function setSuggestionMarks(
  view: EditorView,
  marks: readonly SuggestionMark[],
): void {
  dispatchMeta(view, { marks });
}

/** "Ignore here": the finding's rule is not reported for its text in its field again. */
export function ignoreFinding(view: EditorView, id: string): boolean {
  const found = writingFindings(view.state).find((f) => f.id === id);
  if (!found) return false;
  dispatchMeta(view, { ignore: found.ignoreKey });
  return true;
}

/**
 * Puts the finding's replacement in place of its text, in one undo step of its own; false when
 * it has none, or its text is no longer what was found.
 */
export function replaceFinding(view: EditorView, id: string): boolean {
  const { state } = view;
  const found = writingFindings(state).find((f) => f.id === id);
  if (!found || found.replacement === undefined || !view.editable) return false;
  if (state.doc.textBetween(found.from, found.to, '￼') !== found.text)
    return false;
  const tr = state.tr.setStoredMarks(null);
  if (found.replacement === '') tr.delete(found.from, found.to);
  else tr.insertText(found.replacement, found.from, found.to);
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/** A pass's findings and marks, reading only the fields `cache` does not hold. */
export function runChecks(
  doc: ProseMirrorNode,
  rules: WritingRules | null,
  cache: WeakMap<ProseMirrorNode, readonly TextFinding[]>,
  ignored: ReadonlySet<string>,
  marks: readonly SuggestionMark[],
): { findings: PlacedFinding[]; placed: PlacedMark[]; checked: number } {
  const findings: PlacedFinding[] = [];
  const placed: PlacedMark[] = [];
  const byField = new Map<string, SuggestionMark[]>();
  for (const m of marks) {
    const k = JSON.stringify([m.blockId, m.field]);
    byField.set(k, [...(byField.get(k) ?? []), m]);
  }
  let chars = 0;
  let checked = 0;
  for (const field of checkedFields(doc)) {
    const own = byField.get(JSON.stringify([field.blockId, field.field]));
    let text: string | null = null;
    const textOf = () => (text ??= plainTextOf(fieldContent(field.node)).text);
    if (own) {
      for (const m of own) {
        if (textOf() !== m.expected) continue;
        const range = rangeIn(field.node, field.pos, m.start, m.end);
        if (range) placed.push({ ...m, ...range });
      }
    }
    if (!rules || rules.empty) continue;
    let found = cache.get(field.node);
    if (!found) {
      const content = fieldContent(field.node);
      const length = textOf().length;
      // A pass reads at most the engine's bound of changed text; the rest waits for the next.
      if (chars + length > MAX_WRITING_CHARS) continue;
      chars += length;
      checked++;
      found = checkWritingText(content, rules).findings;
      cache.set(field.node, found);
    }
    for (const f of found) {
      const ignoreKey = ignoreKeyOf(field.blockId, field.field, f);
      if (ignored.has(ignoreKey)) continue;
      const range = rangeIn(field.node, field.pos, f.start, f.end);
      if (!range) continue;
      findings.push({
        ...f,
        id: JSON.stringify([field.blockId, field.field, ruleKey(f), f.start]),
        blockId: field.blockId,
        field: field.field,
        ...range,
        fieldText: textOf(),
        ignoreKey,
      });
    }
  }
  return { findings, placed, checked };
}

export interface WritingChecksOptions {
  /** The findings changed (after a check, an ignore, or a move). */
  onFindings: (findings: readonly PlacedFinding[]) => void;
  /** The caret came to a finding (or a suggestion mark): says what it is for screen readers. */
  onCaret: (
    at:
      | { readonly kind: 'finding'; readonly finding: PlacedFinding }
      | { readonly kind: 'suggestion'; readonly mark: PlacedMark }
      | null,
  ) => void;
  /** Alt+Enter at a finding, a suggestion mark or a linked term: the popover opens on it. */
  openAt: (pos: number) => boolean;
}

/** The checks' timer and what they keep between passes, per editor. */
class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstStale = 0;
  private cache = new WeakMap<ProseMirrorNode, readonly TextFinding[]>();
  private cacheRules: WritingRules | null = null;

  constructor(private readonly view: EditorView) {}

  update(): void {
    const state = writingChecksKey.getState(this.view.state);
    if (!state?.stale) return;
    const now = performance.now();
    if (this.timer === null) this.firstStale = now;
    else clearTimeout(this.timer);
    const wait = Math.max(
      0,
      Math.min(DEBOUNCE_MS, this.firstStale + MAX_WAIT_MS - now),
    );
    this.timer = setTimeout(() => this.run(), wait);
  }

  private run(): void {
    this.timer = null;
    const { view } = this;
    if (view.isDestroyed) return;
    const state = writingChecksKey.getState(view.state);
    if (!state?.stale) return;
    if (state.rules !== this.cacheRules) {
      this.cache = new WeakMap();
      this.cacheRules = state.rules;
    }
    const started = performance.now();
    const { findings, placed, checked } = runChecks(
      view.state.doc,
      view.editable ? state.rules : null,
      this.cache,
      state.ignored,
      state.marks,
    );
    // For the typing-latency test: how long each pass took and how many fields it read.
    performance.measure?.('openfolia:writing-check', {
      start: started,
      detail: { checked },
    });
    dispatchMeta(view, { result: { findings, placed } });
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Alt+Enter: opens the popover at the caret (the shortcut reference lists it). */
export const isPopoverKey = (
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >,
): boolean =>
  event.key === 'Enter' &&
  event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

export const WritingChecks = Extension.create<WritingChecksOptions>({
  name: 'writingChecks',
  addOptions() {
    return {
      onFindings: () => undefined,
      onCaret: () => undefined,
      openAt: () => false,
    };
  },
  addProseMirrorPlugins() {
    const { onFindings, onCaret, openAt } = this.options;
    return [
      new Plugin<WritingState>({
        key: writingChecksKey,
        state: {
          init: () => ({
            rules: null,
            findings: [],
            marks: [],
            placed: [],
            ignored: new Set(),
            stale: false,
            decorations: DecorationSet.empty,
          }),
          apply,
        },
        view: (view) => {
          const scheduler = new Scheduler(view);
          let shownFindings: readonly PlacedFinding[] = [];
          let caretAt = '';
          return {
            update: (v) => {
              scheduler.update();
              const findings = writingFindings(v.state);
              if (findings !== shownFindings) {
                shownFindings = findings;
                onFindings(findings);
              }
              const { from, empty } = v.state.selection;
              const finding = empty ? findingAt(v.state, from) : null;
              const mark =
                !finding && empty ? suggestionAt(v.state, from) : null;
              const at = finding
                ? `f:${finding.id}`
                : mark
                  ? `s:${mark.id}`
                  : '';
              if (at === caretAt) return;
              caretAt = at;
              onCaret(
                finding
                  ? { kind: 'finding', finding }
                  : mark
                    ? { kind: 'suggestion', mark }
                    : null,
              );
            },
            destroy: () => scheduler.destroy(),
          };
        },
        props: {
          decorations: (state) =>
            writingChecksKey.getState(state)?.decorations ?? null,
          handleKeyDown: (view, event) => {
            if (!isPopoverKey(event) || view.composing) return false;
            return openAt(view.state.selection.from);
          },
        },
      }),
    ];
  },
});
