import type { Schema } from '../api';

type Block = Schema<'Block'>;
type Inline = Schema<'Inline'>;

/** What a unit of a module is, for how it shows. */
export type UnitKind =
  | 'heading'
  | 'paragraph'
  | 'item'
  | 'step'
  | 'procedure'
  | 'safety'
  | 'admonition'
  | 'faq'
  | 'variant'
  | 'table'
  | 'image'
  | 'attachment'
  | 'moduleRef'
  | 'literal'
  | 'passthrough'
  | 'pageBreak';

/**
 * One piece of a module as the review shows it: a block, list item or procedure step, by the ID
 * the content model gives it, with its own text (never that of the blocks inside it, which are
 * units of their own). Containers (a section, a safety notice, a variant…) are a unit for their
 * own text (the heading, the hazard, the question, the condition) followed by their children, one
 * level deeper.
 */
export interface Unit {
  readonly id: string;
  readonly kind: UnitKind;
  /** Nesting: 0 for the module's own blocks. */
  readonly depth: number;
  /** The unit's own text, plain (marks are not compared). */
  readonly text: string;
  /** Kind-specific detail: the safety severity, the admonition kind, an image's asset… */
  readonly detail?: string;
  /** A list item or step: its position, from 1. */
  readonly ordinal?: number;
  /** An item of an ordered list. */
  readonly ordered?: boolean;
  /** A heading: its level, 1 for a section at the top of the module. */
  readonly level?: number;
}

/** Plain text of inline content: marks dropped, attributes as `{name}`, keys joined by `+`. */
export function inlineText(content: readonly Inline[] | undefined): string {
  if (!content) return '';
  return content
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'attribute':
          return `{${node.name}}`;
        case 'xref':
          return node.text?.map((t) => t.text).join('') || node.module;
        case 'kbd':
          return node.keys.join('+');
        case 'calloutRef':
          // Its number depends on the variant: the callout's ID says which one.
          return `(${node.callout})`;
        case 'hardBreak':
          return '\n';
        case 'placeholder':
          return `[${node.key}]`;
      }
    })
    .join('');
}

/** A variant's condition as short text: `model in (a, b)`, `version >= 2`. */
export function conditionText(when: Schema<'Condition'>): string {
  switch (when.op) {
    case 'in':
      return `${when.attr}: ${when.values.join(', ')}`;
    case 'cmp':
      return `${when.attr} ${when.cmp} ${when.value}`;
    case 'not':
      return `not (${conditionText(when.of)})`;
    case 'all':
      return when.of.map(conditionText).join(' and ');
    case 'any':
      return when.of.map(conditionText).join(' or ');
  }
}

/** The module's blocks as units, in reading order. */
export function unitsOf(blocks: readonly Block[]): Unit[] {
  const out: Unit[] = [];
  const walk = (list: readonly Block[], depth: number) => {
    for (const block of list) visit(block, depth);
  };
  const visit = (block: Block, depth: number) => {
    switch (block.type) {
      case 'paragraph':
        out.push({
          id: block.id,
          kind: 'paragraph',
          depth,
          text: inlineText(block.content),
        });
        return;
      case 'section':
        out.push({
          id: block.id,
          kind: 'heading',
          depth,
          // Sections nest only in sections: the depth is the level less one.
          level: depth + 1,
          text: inlineText(block.title),
        });
        walk(block.blocks, depth + 1);
        return;
      case 'list':
        block.items.forEach((item, index) => {
          out.push({
            id: item.id,
            kind: 'item',
            depth,
            text: inlineText(item.content),
            ordinal: index + 1,
            ordered: block.ordered,
          });
          walk(item.blocks, depth + 1);
        });
        return;
      case 'procedure':
        out.push({
          id: block.id,
          kind: 'procedure',
          depth,
          text: inlineText(block.title),
        });
        block.steps.forEach((step, index) => {
          out.push({
            id: step.id,
            kind: 'step',
            depth: depth + 1,
            text: inlineText(step.content),
            ordinal: index + 1,
            ordered: true,
          });
          walk(step.blocks, depth + 2);
        });
        return;
      case 'table':
        out.push({
          id: block.id,
          kind: 'table',
          depth,
          text: inlineText(block.title),
          // Its shape and settings, so a merge, a split or an alignment shows as a change.
          detail: [
            `${block.rows.length}×${block.columns.length}`,
            block.header ? 'header' : '',
            block.columns.map((c) => c.align ?? '').join(','),
            block.rows
              .map((r) =>
                r.cells
                  .map((c) => `${c.colspan ?? 1}.${c.rowspan ?? 1}`)
                  .join(','),
              )
              .join(';'),
          ].join('|'),
        });
        for (const row of block.rows) {
          for (const cell of row.cells) walk(cell.blocks, depth + 1);
        }
        return;
      case 'image':
        out.push({
          id: block.id,
          kind: 'image',
          depth,
          text: block.alt,
          detail: block.asset,
        });
        return;
      case 'attachment':
        // Its facts as text, so a new name, file, type or size shows as a text change;
        // a file replaced under the same facts by its asset.
        out.push({
          id: block.id,
          kind: 'attachment',
          depth,
          text: [
            block.name,
            block.fileName,
            block.mediaType,
            `${block.size} B`,
            ...(block.description ? [block.description] : []),
          ].join(' · '),
          detail: block.asset,
        });
        return;
      case 'safety':
        out.push({
          id: block.id,
          kind: 'safety',
          depth,
          text: inlineText(block.hazard),
          detail: block.severity,
        });
        walk(block.blocks, depth + 1);
        return;
      case 'admonition':
        out.push({
          id: block.id,
          kind: 'admonition',
          depth,
          text: '',
          detail: block.kind,
        });
        walk(block.blocks, depth + 1);
        return;
      case 'faq':
        out.push({
          id: block.id,
          kind: 'faq',
          depth,
          text: inlineText(block.question),
        });
        walk(block.blocks, depth + 1);
        return;
      case 'variant':
        out.push({
          id: block.id,
          kind: 'variant',
          depth,
          text: conditionText(block.when),
        });
        walk(block.blocks, depth + 1);
        return;
      case 'moduleRef':
        out.push({
          id: block.id,
          kind: 'moduleRef',
          depth,
          text: block.module,
        });
        return;
      case 'literal':
        out.push({
          id: block.id,
          kind: 'literal',
          depth,
          text: block.text,
          detail: block.language ?? '',
        });
        return;
      case 'passthrough':
        out.push({
          id: block.id,
          kind: 'passthrough',
          depth,
          text: block.raw,
          detail: block.format,
        });
        return;
      case 'pageBreak':
        // No text: added or removed, never changed.
        out.push({ id: block.id, kind: 'pageBreak', depth, text: '' });
        return;
      default:
        block satisfies never;
    }
  };
  walk(blocks, 0);
  return out;
}

/** A run of text, kept, inserted or deleted. */
export interface Segment {
  readonly op: 'same' | 'ins' | 'del';
  readonly text: string;
}

/** Past this many token pairs a text is shown as replaced whole: the comparison stays quick. */
const MAX_CELLS = 250_000;

/** Words, the spaces between them and punctuation, each a token; joined they give the text back. */
export function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/**
 * The word-level difference of two texts (a longest common subsequence of tokens), with
 * neighbouring runs of the same kind joined. Deletions come before insertions where both replace
 * the same place.
 */
export function diffText(before: string, after: string): Segment[] {
  if (before === after) return before ? [{ op: 'same', text: before }] : [];
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    return join([
      { op: 'del', text: before },
      { op: 'ins', text: after },
    ]);
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the common length of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: Segment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (
      ((lcs[i + 1] as Uint32Array)[j] as number) >=
      ((lcs[i] as Uint32Array)[j + 1] as number)
    ) {
      out.push({ op: 'del', text: a[i] as string });
      i++;
    } else {
      out.push({ op: 'ins', text: b[j] as string });
      j++;
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++] as string });
  while (j < m) out.push({ op: 'ins', text: b[j++] as string });
  return join(absorbSpaces(out));
}

/** A lone space kept between two changes reads better as part of them. */
function absorbSpaces(segments: Segment[]): Segment[] {
  const out = segments.slice();
  for (let k = 1; k < out.length - 1; k++) {
    const s = out[k] as Segment;
    const prev = out[k - 1] as Segment;
    const next = out[k + 1] as Segment;
    if (
      s.op === 'same' &&
      /^\s+$/.test(s.text) &&
      prev.op !== 'same' &&
      next.op !== 'same'
    ) {
      out.splice(
        k,
        1,
        { op: 'del', text: s.text },
        { op: 'ins', text: s.text },
      );
      k++;
    }
  }
  // Deletions first within each changed run, so the old words read before the new ones.
  const sorted: Segment[] = [];
  let run: Segment[] = [];
  const flush = () => {
    sorted.push(
      ...run.filter((s) => s.op === 'del'),
      ...run.filter((s) => s.op === 'ins'),
    );
    run = [];
  };
  for (const s of out) {
    if (s.op === 'same') {
      flush();
      sorted.push(s);
    } else run.push(s);
  }
  flush();
  return sorted;
}

function join(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    if (!s.text) continue;
    const last = out.at(-1);
    if (last && last.op === s.op)
      out[out.length - 1] = { op: s.op, text: last.text + s.text };
    else out.push(s);
  }
  return out;
}

/** Past this many ID pairs, moves are not looked for (the comparison stays quick). */
const MAX_ORDER_CELLS = 1_000_000;

/**
 * The IDs kept on both sides whose order changed: those outside the longest run both sides keep
 * in the same order.
 */
export function movedIds(
  before: readonly string[],
  after: readonly string[],
): Set<string> {
  const inAfter = new Set(after);
  const inBefore = new Set(before);
  const a = before.filter((id) => inAfter.has(id));
  const b = after.filter((id) => inBefore.has(id));
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_ORDER_CELLS) return new Set();
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      kept.add(a[i] as string);
      i++;
      j++;
    } else if (
      ((lcs[i + 1] as Uint32Array)[j] as number) >=
      ((lcs[i] as Uint32Array)[j + 1] as number)
    ) {
      i++;
    } else {
      j++;
    }
  }
  return new Set(b.filter((id) => !kept.has(id)));
}

/**
 * What inline content holds beside its words, one entry each: a run of text with a mark (and a
 * link's address), a cross-reference and its target, a text attribute, a key combination. Plain
 * text compares the words; these say what else changed (bold added, a link pointing elsewhere).
 */
export interface InlineDetail {
  /** A mark type (`strong`, `link`…) or an inline type (`xref`, `attribute`, `kbd`). */
  readonly kind: string;
  /** The words it covers (a cross-reference's own text), or the attribute or the keys. */
  readonly text: string;
  /** A link's address, a cross-reference's target (`module#block`). */
  readonly target?: string;
}

const detailKey = (d: InlineDetail) =>
  `${d.kind}\u0000${d.text}\u0000${d.target ?? ''}`;

export function inlineDetails(
  content: readonly Inline[] | undefined,
): InlineDetail[] {
  const out: InlineDetail[] = [];
  // A mark open over adjacent text runs: one entry for the whole run.
  let open = new Map<string, { text: string; target?: string }>();
  const flush = (keep: Map<string, { text: string; target?: string }>) => {
    for (const [key, run] of open)
      if (!keep.has(key))
        out.push({
          kind: key.split('\u0000')[0]!,
          text: run.text,
          target: run.target,
        });
  };
  for (const node of content ?? []) {
    if (node.type !== 'text') {
      flush(new Map());
      open = new Map();
      if (node.type === 'xref') {
        // Its target, and the words it shows when it has its own (else the target is its text).
        const target = node.block
          ? `${node.module}#${node.block}`
          : node.module;
        const own = node.text?.map((t) => t.text).join('') ?? '';
        out.push(
          own
            ? { kind: 'xref', text: own, target }
            : { kind: 'xref', text: target },
        );
      } else if (node.type === 'attribute')
        out.push({ kind: 'attribute', text: node.name });
      else if (node.type === 'kbd')
        out.push({ kind: 'kbd', text: node.keys.join('+') });
      continue;
    }
    const next = new Map<string, { text: string; target?: string }>();
    for (const mark of node.marks ?? []) {
      const target = mark.type === 'link' ? mark.href : undefined;
      const key = `${mark.type}\u0000${target ?? ''}`;
      const run = open.get(key);
      next.set(key, { text: (run?.text ?? '') + node.text, target });
    }
    flush(next);
    open = next;
  }
  flush(new Map());
  return out;
}

/** The inline details one side has and the other has not (each counted, as a multiset). */
export function inlineDetailChanges(
  before: readonly InlineDetail[],
  after: readonly InlineDetail[],
): { added: InlineDetail[]; removed: InlineDetail[] } {
  const left = new Map<string, number>();
  for (const d of before)
    left.set(detailKey(d), (left.get(detailKey(d)) ?? 0) + 1);
  const added: InlineDetail[] = [];
  for (const d of after) {
    const n = left.get(detailKey(d)) ?? 0;
    if (n > 0) left.set(detailKey(d), n - 1);
    else added.push(d);
  }
  const removed: InlineDetail[] = [];
  const right = new Map<string, number>();
  for (const d of after)
    right.set(detailKey(d), (right.get(detailKey(d)) ?? 0) + 1);
  for (const d of before) {
    const n = right.get(detailKey(d)) ?? 0;
    if (n > 0) right.set(detailKey(d), n - 1);
    else removed.push(d);
  }
  // A run whose words changed (bold kept over an edited phrase, a link's new text) is the same
  // detail: pair a removed and an added one of the same kind and target, and say nothing.
  const pairs = (d: InlineDetail) => `${d.kind}\u0000${d.target ?? ''}`;
  const keptAdded: InlineDetail[] = [];
  const left2 = [...removed];
  for (const d of added) {
    // Only marks and a cross-reference with words of its own: an attribute's or keys' text is
    // what they are, and a bare cross-reference's text is its target.
    const words =
      d.kind !== 'attribute' &&
      d.kind !== 'kbd' &&
      !(d.kind === 'xref' && !d.target);
    const i = words ? left2.findIndex((r) => pairs(r) === pairs(d)) : -1;
    if (i >= 0) left2.splice(i, 1);
    else keptAdded.push(d);
  }
  return { added: keptAdded, removed: left2 };
}
