import {
  Fragment,
  type Node as ProseMirrorNode,
  type Schema,
} from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
// The full entry, with zod: a callout's condition is evaluated for the chosen variant.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  evaluateCondition,
  isCondition,
  MAX_CALLOUTS,
  numberCallouts,
  roundCoordinate,
  type Callout,
  type CalloutPoint,
  type Condition,
} from '@openfolia/content-model';

// Image callouts in the editor (#498, #547): an image block's callouts as the callout editor
// reads them (with the numbers they read as in the chosen variant), and the changes it makes,
// each written into a transaction on the image at `imagePos`. Framework-free; the image's node
// view (`image-node.component.ts`) is the UI. Numbers are never stored: they are derived, as the
// content model derives them (`numberCallouts`).

/** The variant the editor numbers callouts in: the attribute values, and its name for people. */
export interface EditorVariant {
  readonly values: Readonly<Record<string, string>>;
  readonly label: string;
}

/** One callout of an image block, as the callout editor shows it. */
export interface EditorCallout {
  readonly id: string;
  readonly anchor: CalloutPoint;
  readonly label: CalloutPoint | null;
  readonly when: Condition | null;
  /** Its legend node (the callout node itself: its content is the legend). */
  readonly node: ProseMirrorNode;
  /** The legend's words, plain. */
  readonly text: string;
  /** Its number in the chosen variant; null when the variant hides it. */
  readonly number: number | null;
}

/** How far an arrow key moves a callout's point, and with Shift. */
export const NUDGE_STEP = 0.01;
export const NUDGE_STEP_LARGE = 0.05;

/** Where "Add leader line" puts a new label, from the anchor. */
const LABEL_OFFSET = { x: 0.1, y: -0.1 };

const clamp = (v: number): number => Math.min(1, Math.max(0, v));

/** A point clamped to the image and rounded as the model keeps it. */
export function toPoint(x: number, y: number): CalloutPoint {
  return {
    x: roundCoordinate(clamp(Number.isFinite(x) ? x : 0)),
    y: roundCoordinate(clamp(Number.isFinite(y) ? y : 0)),
  };
}

const isPoint = (value: unknown): value is CalloutPoint =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as CalloutPoint).x === 'number' &&
  typeof (value as CalloutPoint).y === 'number';

const pointOf = (value: unknown): CalloutPoint | null =>
  isPoint(value) ? toPoint(value.x, value.y) : null;

/** Whether a callout's condition holds in the variant (none chosen: every callout shows). */
export function shownIn(
  when: Condition | null,
  variant: EditorVariant | null,
): boolean {
  if (!when || !variant) return true;
  try {
    return evaluateCondition(when, variant.values);
  } catch {
    return true;
  }
}

/** The model's view of a callout node, as far as numbering needs it. */
function modelCallout(node: ProseMirrorNode): Callout {
  const anchor = pointOf(node.attrs['anchor']) ?? { x: 0, y: 0 };
  const label = pointOf(node.attrs['label']);
  const when = node.attrs['when'];
  return {
    id: String(node.attrs['id'] ?? ''),
    anchor,
    ...(label ? { label } : {}),
    legend: [],
    ...(isCondition(when) ? { when } : {}),
  };
}

/** Whether the image numbers its callouts in the stored (the author's) order. */
export const isManualOrder = (image: ProseMirrorNode): boolean =>
  image.attrs['calloutOrder'] === 'manual';

/** The callout nodes of an image, in the stored order, with their offsets in the image. */
function calloutNodes(
  image: ProseMirrorNode,
): { node: ProseMirrorNode; offset: number }[] {
  const out: { node: ProseMirrorNode; offset: number }[] = [];
  image.forEach((node, offset) => {
    if (node.type.name === 'callout') out.push({ node, offset });
  });
  return out;
}

/**
 * The image's callouts in number order over every variant (the order the panel lists them in):
 * reading order, or the stored order for `manual`. Each carries its number in `variant` (null
 * when that variant hides it).
 */
export function editorCallouts(
  image: ProseMirrorNode,
  variant: EditorVariant | null,
): EditorCallout[] {
  const nodes = calloutNodes(image).map((c) => c.node);
  const byId = new Map(nodes.map((n) => [String(n.attrs['id'] ?? ''), n]));
  const models = nodes.map(modelCallout);
  const calloutOrder = isManualOrder(image) ? 'manual' : 'reading';
  const all = numberCallouts({ callouts: models, calloutOrder });
  const numbers = new Map(
    numberCallouts({ callouts: models, calloutOrder }, (c) =>
      shownIn(c.when ?? null, variant),
    ).map(({ callout, number }) => [callout.id, number]),
  );
  return all.map(({ callout }) => {
    const node = byId.get(callout.id) as ProseMirrorNode;
    return {
      id: callout.id,
      anchor: callout.anchor,
      label: callout.label ?? null,
      when: callout.when ?? null,
      node,
      text: node.textContent,
      number: numbers.get(callout.id) ?? null,
    };
  });
}

/**
 * The number a callout reference reads as: its callout's number in `variant`, `hidden` when the
 * variant hides it, or `missing` when the module has no such image or callout.
 */
export type CalloutRefState =
  | { readonly status: 'numbered'; readonly number: number }
  | { readonly status: 'hidden' }
  | { readonly status: 'missing' };

/** Each image of the document by ID, with its callouts (for the references in its text). */
export function documentCallouts(
  doc: ProseMirrorNode,
  variant: EditorVariant | null,
): Map<string, { image: ProseMirrorNode; callouts: EditorCallout[] }> {
  const out = new Map<
    string,
    { image: ProseMirrorNode; callouts: EditorCallout[] }
  >();
  doc.descendants((node) => {
    if (node.type.name !== 'image') return !node.isTextblock;
    const id = node.attrs['id'];
    if (typeof id === 'string' && id && !out.has(id))
      out.set(id, { image: node, callouts: editorCallouts(node, variant) });
    return false;
  });
  return out;
}

/** What a reference to `callout` on `image` reads as. */
export function refState(
  images: ReturnType<typeof documentCallouts>,
  image: string,
  callout: string,
): CalloutRefState {
  const found = images.get(image)?.callouts.find((c) => c.id === callout);
  if (!found) return { status: 'missing' };
  return found.number === null
    ? { status: 'hidden' }
    : { status: 'numbered', number: found.number };
}

// ---------------------------------------------------------------------------------------------
// IDs

const ID_MAX = 64;

/** Every ID in the document: blocks, list items and callouts. */
export function idsIn(doc: ProseMirrorNode): Set<string> {
  const out = new Set<string>();
  doc.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string' && id) out.add(id);
    return !node.isTextblock;
  });
  return out;
}

/**
 * A new callout ID for the image `imageId`: `<image>-<n>` with the first `n` no ID in `taken`
 * holds (cut so it stays within the model's 64 characters).
 */
export function newCalloutId(
  imageId: string,
  taken: ReadonlySet<string>,
): string {
  const base = /^[a-z_][a-z0-9_-]*$/.test(imageId) ? imageId : 'callout';
  for (let n = 1; ; n += 1) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, ID_MAX - suffix.length)}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

// ---------------------------------------------------------------------------------------------
// Changes: each one writes into `tr` on the image at `imagePos` and says whether it did.

const imageAt = (tr: Transaction, imagePos: number): ProseMirrorNode | null => {
  const node = tr.doc.nodeAt(imagePos);
  return node?.type.name === 'image' ? node : null;
};

/** The callout `id` of the image at `imagePos`: its node and its position in the document. */
function calloutAt(
  tr: Transaction,
  imagePos: number,
  id: string,
): { node: ProseMirrorNode; pos: number } | null {
  const image = imageAt(tr, imagePos);
  if (!image) return null;
  const found = calloutNodes(image).find((c) => c.node.attrs['id'] === id);
  return found ? { node: found.node, pos: imagePos + 1 + found.offset } : null;
}

/**
 * Adds a callout with its anchor at `point` and an empty legend, after the image's other
 * callouts. Resolves to its ID, or null when the image holds as many as the model allows.
 */
export function addCallout(
  tr: Transaction,
  imagePos: number,
  point: CalloutPoint,
): string | null {
  const image = imageAt(tr, imagePos);
  const type = tr.doc.type.schema.nodes['callout'];
  if (!image || !type) return null;
  if (calloutNodes(image).length >= MAX_CALLOUTS) return null;
  const id = newCalloutId(String(image.attrs['id'] ?? ''), idsIn(tr.doc));
  const node = type.create({
    id,
    anchor: toPoint(point.x, point.y),
    label: null,
    when: null,
    style: null,
  });
  tr.insert(imagePos + image.nodeSize - 1, node);
  return id;
}

/** Moves a callout's anchor or label to `point` (clamped and rounded). */
export function moveCalloutPoint(
  tr: Transaction,
  imagePos: number,
  id: string,
  which: 'anchor' | 'label',
  point: CalloutPoint,
): boolean {
  const found = calloutAt(tr, imagePos, id);
  if (!found) return false;
  if (which === 'label' && !isPoint(found.node.attrs['label'])) return false;
  const next = toPoint(point.x, point.y);
  const now = pointOf(found.node.attrs[which]);
  if (now && now.x === next.x && now.y === next.y) return false;
  tr.setNodeAttribute(found.pos, which, next);
  return true;
}

/** A point moved by `dx`, `dy` (clamped and rounded). */
export const nudged = (point: CalloutPoint, dx: number, dy: number) =>
  toPoint(point.x + dx, point.y + dy);

/** Gives a callout a label (with a leader line to its anchor), or takes it away (`null`). */
export function setCalloutLabel(
  tr: Transaction,
  imagePos: number,
  id: string,
  on: boolean,
): boolean {
  const found = calloutAt(tr, imagePos, id);
  if (!found) return false;
  const has = isPoint(found.node.attrs['label']);
  if (has === on) return false;
  const anchor = pointOf(found.node.attrs['anchor']) ?? { x: 0, y: 0 };
  const x =
    anchor.x + LABEL_OFFSET.x > 1
      ? anchor.x - LABEL_OFFSET.x
      : anchor.x + LABEL_OFFSET.x;
  const y =
    anchor.y + LABEL_OFFSET.y < 0
      ? anchor.y - LABEL_OFFSET.y
      : anchor.y + LABEL_OFFSET.y;
  tr.setNodeAttribute(found.pos, 'label', on ? toPoint(x, y) : null);
  return true;
}

/** Sets a callout's variant condition; null shows it in every variant. */
export function setCalloutWhen(
  tr: Transaction,
  imagePos: number,
  id: string,
  when: Condition | null,
): boolean {
  const found = calloutAt(tr, imagePos, id);
  if (!found) return false;
  tr.setNodeAttribute(found.pos, 'when', when);
  return true;
}

/**
 * The inline content a legend may hold (one line, no breaks: a break becomes a space), from
 * the content of any text block of the same schema.
 */
export function legendContent(schema: Schema, content: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  content.forEach((node) => {
    if (node.type.name === 'hardBreak') nodes.push(schema.text(' '));
    else nodes.push(node);
  });
  return Fragment.from(nodes);
}

/** Puts `content` (inline) in as a callout's legend; nothing when it is the same. */
export function setCalloutLegend(
  tr: Transaction,
  imagePos: number,
  id: string,
  content: Fragment,
): boolean {
  const found = calloutAt(tr, imagePos, id);
  if (!found) return false;
  const next = legendContent(tr.doc.type.schema, content);
  if (found.node.content.eq(next)) return false;
  tr.replaceWith(found.pos + 1, found.pos + found.node.nodeSize - 1, next);
  return true;
}

/** Takes a callout away. */
export function removeCallout(
  tr: Transaction,
  imagePos: number,
  id: string,
): boolean {
  const found = calloutAt(tr, imagePos, id);
  if (!found) return false;
  tr.delete(found.pos, found.pos + found.node.nodeSize);
  return true;
}

/**
 * Puts the callouts in the order of `ids` (every callout's ID, each once) and numbers them in
 * that order from now on (`calloutOrder: manual`).
 */
export function reorderCallouts(
  tr: Transaction,
  imagePos: number,
  ids: readonly string[],
): boolean {
  const image = imageAt(tr, imagePos);
  if (!image) return false;
  const nodes = calloutNodes(image);
  const byId = new Map(nodes.map((c) => [String(c.node.attrs['id']), c.node]));
  if (ids.length !== nodes.length || new Set(ids).size !== ids.length)
    return false;
  const ordered = ids.map((id) => byId.get(id));
  if (ordered.some((n) => !n)) return false;
  const first = nodes[0];
  if (!first) return false;
  const from = imagePos + 1 + first.offset;
  const to = imagePos + image.nodeSize - 1;
  tr.replaceWith(from, to, Fragment.from(ordered as ProseMirrorNode[]));
  if (!isManualOrder(image))
    tr.setNodeAttribute(imagePos, 'calloutOrder', 'manual');
  return true;
}

/** Numbers the callouts in reading order again (the default: the attribute is left out). */
export function useReadingOrder(tr: Transaction, imagePos: number): boolean {
  const image = imageAt(tr, imagePos);
  if (!image || !isManualOrder(image)) return false;
  tr.setNodeAttribute(imagePos, 'calloutOrder', null);
  return true;
}
