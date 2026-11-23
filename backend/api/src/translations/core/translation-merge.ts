import {
  MAX_CALLOUTS,
  plainTextOf,
  type Block,
  type Callout,
  type Image,
  type Inline,
  type Item,
  type Module,
  type TranslatablePart,
} from '@openfolia/content-model';

/** A block, or a list item or procedure step: what a unit's block ID names. */
type Node = Block | Item;

/** A place blocks or items are held: a module's or a block's blocks, a list's items, a table cell. */
interface Slot {
  /** `''` for the module itself, else the owner's ID with which of its slots (`blocks`, `items`, `cell:<row>:<col>`). */
  readonly key: string;
  readonly nodes: Node[];
}

/** The slots of `node` (the module's top is the slot `''`), each with its key. */
function slotsOf(node: Node | Module): Slot[] {
  if ('meta' in node) return [{ key: '', nodes: node.blocks }];
  if (!('type' in node))
    return [{ key: `${node.id}/blocks`, nodes: node.blocks }];
  switch (node.type) {
    case 'section':
    case 'safety':
    case 'admonition':
    case 'faq':
    case 'variant':
      return [{ key: `${node.id}/blocks`, nodes: node.blocks }];
    case 'list':
      return [{ key: `${node.id}/items`, nodes: node.items }];
    case 'procedure':
      return [{ key: `${node.id}/items`, nodes: node.steps }];
    case 'table':
      return node.rows.flatMap((row, r) =>
        row.cells.map((cell, c) => ({
          key: `${node.id}/cell:${r}:${c}`,
          nodes: cell.blocks,
        })),
      );
    default:
      return [];
  }
}

/** Every node of `module` by ID, with the slot holding it. */
function index(module: Module): Map<string, { node: Node; slot: Slot }> {
  const found = new Map<string, { node: Node; slot: Slot }>();
  const pending: Slot[] = slotsOf(module);
  while (pending.length > 0) {
    const slot = pending.shift() as Slot;
    for (const node of slot.nodes) {
      if (!found.has(node.id)) found.set(node.id, { node, slot });
      pending.push(...slotsOf(node));
    }
  }
  return found;
}

/** The slots by key. */
function slotIndex(module: Module): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const pending: Slot[] = slotsOf(module);
  while (pending.length > 0) {
    const slot = pending.shift() as Slot;
    slots.set(slot.key, slot);
    for (const node of slot.nodes) pending.push(...slotsOf(node));
  }
  return slots;
}

/** Every image callout of `module` by ID, with the image holding it, in document order. */
function calloutIndex(
  module: Module,
): Map<string, { callout: Callout; image: Image }> {
  const found = new Map<string, { callout: Callout; image: Image }>();
  for (const { node } of index(module).values()) {
    if (!('type' in node) || node.type !== 'image') continue;
    for (const callout of node.callouts ?? []) {
      if (!found.has(callout.id))
        found.set(callout.id, { callout, image: node });
    }
  }
  return found;
}

/** Blocks with no text of their own, which are never empty: left out once nothing is left in them. */
const HOLDERS_ONLY = new Set(['variant', 'list', 'admonition']);

/**
 * A node with every nested node (and image callout) whose ID `taken` holds
 * left out (they live elsewhere in the target), and a variant block, list
 * or notice left empty by that left out too.
 */
function without(node: Node, taken: ReadonlySet<string>): Node {
  const copy = structuredClone(node);
  const order: Node[] = [];
  const pending: Node[] = [copy];
  while (pending.length > 0) {
    const current = pending.pop() as Node;
    order.push(current);
    // An image's callouts the target has elsewhere are left out too (#548).
    if ('type' in current && current.type === 'image' && current.callouts) {
      const kept = current.callouts.filter((c) => !taken.has(c.id));
      if (kept.length > 0) current.callouts = kept;
      else delete current.callouts;
    }
    for (const slot of slotsOf(current)) {
      const kept = slot.nodes.filter((n) => !taken.has(n.id));
      slot.nodes.splice(0, slot.nodes.length, ...kept);
      pending.push(...kept);
    }
  }
  // Children before their parents: an emptied holder goes, then its parent sees it gone.
  for (const current of order.reverse()) {
    for (const slot of slotsOf(current)) {
      const kept = slot.nodes.filter(
        (n) =>
          !('type' in n) ||
          !HOLDERS_ONLY.has(n.type) ||
          slotsOf(n).some((s) => s.nodes.length > 0),
      );
      if (kept.length !== slot.nodes.length) {
        slot.nodes.splice(0, slot.nodes.length, ...kept);
      }
    }
  }
  return copy;
}

const plain = (content: readonly Inline[]) => plainTextOf(content).text;

/**
 * The node with its translatable text replaced by `parts` (by field): a
 * paragraph's or item's `content`, a title, a safety block's hazard, an
 * FAQ entry's question, an
 * image's alt text and title, an attachment's name and description.
 * Nothing else of it changes: its ID, an image's or attachment's file,
 * a variant's condition, its nested blocks.
 */
function translate(node: Node, parts: readonly TranslatablePart[]): void {
  const target = node as unknown as Record<string, unknown>;
  const kind = 'type' in node ? node.type : 'item';
  for (const { field, content } of parts) {
    switch (field) {
      case 'content':
        if (kind === 'paragraph' || kind === 'item')
          target['content'] = [...content];
        break;
      case 'title':
        if (
          kind === 'section' ||
          kind === 'procedure' ||
          kind === 'table' ||
          kind === 'image'
        ) {
          target['title'] = [...content];
        }
        break;
      case 'hazard':
        if (kind === 'safety') target['hazard'] = [...content];
        break;
      case 'question':
        if (kind === 'faq') target['question'] = [...content];
        break;
      case 'alt':
        if (kind === 'image') target['alt'] = plain(content);
        break;
      case 'name':
        if (kind === 'attachment') target['name'] = plain(content);
        break;
      case 'description':
        if (kind === 'attachment') target['description'] = plain(content);
        break;
      case 'legend':
        // A callout's legend: merged by `mergeCallout`, never on a block.
        break;
    }
  }
}

/**
 * The target module (`target`, a translation of `source` into `lang`)
 * with each translated unit (`units`, by block ID) merged in by block ID:
 *
 * - a block the target has takes the unit's text (`translate`); nothing
 *   else of it changes, so image and attachment references, variant
 *   conditions and IDs of the target stay;
 * - a block the target lacks is added from the source's structure: the
 *   source block (with its nested blocks, less any the target has
 *   elsewhere) goes into the nearest slot the target shares with the
 *   source, after the nearest preceding block it shares there (first
 *   when there is none), then takes the unit's text;
 * - without a target file at all, the source module (in `lang`) is the
 *   start: blocks without a translated unit keep the source's text.
 *
 * Units are merged in the source's document order. A unit whose block
 * neither has (the source no longer has it) is left out; the import's
 * check has reported it (`unknown-block`, `removed`).
 *
 * A callout's legend (#548, the unit's ID the callout's) is merged after
 * the blocks, into the callout of that ID in the target (only its legend
 * changes: its points, condition and style stay the target's). A callout
 * the target lacks is added from the source to the image holding it in the
 * source (placed first, as a block is, when the target lacks it too), after
 * the nearest preceding callout both have there (first when there is none),
 * unless the target has a block of that ID or the image is full
 * (`MAX_CALLOUTS`): then, as when the image has no place in the target, the
 * legend is left out.
 */
export function mergeTranslation(
  target: Module | undefined,
  source: Module,
  lang: string,
  units: ReadonlyMap<string, readonly TranslatablePart[]>,
): Module {
  const merged: Module = structuredClone(
    target ?? { ...source, meta: { ...source.meta, lang } },
  );
  const inSource = index(source);
  // The source's document order: a parent before its children.
  const order = [...inSource.keys()].filter((id) => units.has(id));
  // Read again only after a block was added (each read walks the module).
  let inMerged = index(merged);
  for (const id of order) {
    let found = inMerged.get(id);
    if (!found) {
      place(merged, source, inSource, id);
      inMerged = index(merged);
      found = inMerged.get(id);
    }
    if (found)
      translate(found.node, units.get(id) as readonly TranslatablePart[]);
  }
  const calloutsInSource = calloutIndex(source);
  for (const [id, { image }] of calloutsInSource) {
    const parts = units.get(id);
    if (!parts) continue;
    const legend = parts.find((p) => p.field === 'legend');
    if (!legend) continue;
    const callout = mergeCallout(merged, source, inSource, id, image);
    if (callout) callout.legend = [...legend.content];
  }
  return merged;
}

/** The target's callout `id`, added from the source's `image` when the target lacks it (`mergeTranslation`). */
function mergeCallout(
  merged: Module,
  source: Module,
  inSource: ReadonlyMap<string, { node: Node; slot: Slot }>,
  id: string,
  image: Image,
): Callout | undefined {
  const there = calloutIndex(merged).get(id);
  if (there) return there.callout;
  let found = index(merged).get(image.id);
  if (!found) {
    place(merged, source, inSource, image.id);
    found = index(merged).get(image.id);
    const placed = calloutIndex(merged).get(id);
    if (placed) return placed.callout;
  }
  if (!found || !('type' in found.node) || found.node.type !== 'image') {
    return undefined;
  }
  const into = found.node;
  // Never an ID the target has for a block, nor more callouts than an image holds: the
  // legend is left out rather than the module made invalid.
  if (index(merged).has(id) || (into.callouts?.length ?? 0) >= MAX_CALLOUTS) {
    return undefined;
  }
  const sourceCallouts = image.callouts ?? [];
  const original = sourceCallouts.find((c) => c.id === id);
  if (!original) return undefined;
  const callout = structuredClone(original);
  const list = into.callouts ?? [];
  const before = sourceCallouts.slice(
    0,
    sourceCallouts.findIndex((c) => c.id === id),
  );
  const anchor = [...before]
    .reverse()
    .find((c) => list.some((d) => d.id === c.id));
  const at = anchor ? list.findIndex((d) => d.id === anchor.id) + 1 : 0;
  list.splice(at, 0, callout);
  into.callouts = list;
  return callout;
}

/** Adds the source's block `id` (and what it holds) to `merged`, as `mergeTranslation` says. */
function place(
  merged: Module,
  source: Module,
  inSource: ReadonlyMap<string, { node: Node; slot: Slot }>,
  id: string,
): void {
  const targetNodes = index(merged);
  const targetSlots = slotIndex(merged);
  // Walk up the source from the block until a slot the target has too.
  let child = id;
  let slot = inSource.get(id)?.slot;
  while (slot && !targetSlots.has(slot.key)) {
    const owner = slot.key.slice(0, slot.key.indexOf('/'));
    const up = inSource.get(owner);
    if (!up) return;
    child = owner;
    slot = up.slot;
  }
  // The block's container is in the target, where the source has it not
  // (a table of another shape): there is no place for it.
  if (!slot || targetNodes.has(child)) return;
  const into = targetSlots.get(slot.key) as Slot;
  const original = inSource.get(child)?.node as Node;
  const node = without(
    original,
    new Set([...targetNodes.keys(), ...calloutIndex(merged).keys()]),
  );
  const before = slot.nodes.slice(
    0,
    slot.nodes.findIndex((n) => n.id === child),
  );
  const anchor = [...before]
    .reverse()
    .find((n) => into.nodes.some((m) => m.id === n.id));
  let at = anchor ? into.nodes.findIndex((n) => n.id === anchor.id) + 1 : 0;
  // Sections close a level (nothing but sections follows one): a section
  // goes after every other block there, any other block before the first section.
  const isSection = (n: Node) => 'type' in n && n.type === 'section';
  if (isSection(node)) {
    const lastOther = into.nodes.findLastIndex((n) => !isSection(n));
    at = Math.max(at, lastOther + 1);
  } else {
    const firstSection = into.nodes.findIndex(isSection);
    if (firstSection !== -1) at = Math.min(at, firstSection);
  }
  into.nodes.splice(at, 0, node);
}
