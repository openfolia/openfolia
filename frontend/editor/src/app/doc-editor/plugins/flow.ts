import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';

// The content model nests: a module holds blocks, then sections; a section holds its title, its
// blocks, then its subsections. A "flow" is one of those containers, the document or a section.
// Its children (but a section's title) are the blocks the grip drags, Alt+Up/Down moves and the
// caret gaps stand between. Within a flow, blocks stand among blocks and sections among sections
// (the schema keeps sections last); where a block may go beyond its flow is `drop-rules.ts`.
// A procedure is a flow of its steps too (after its title), so a step moves among its
// procedure's steps; and a step is a flow of the blocks under its text (an image, a note…), so
// those move within their step, and between steps. A variant block's, a safety notice's and an
// FAQ entry's content is a flow of its blocks too (after the hazard or the question), so those
// have a grip of their own and are dragged out of their container and back.

const FLOWS = new Set(['doc', 'section', 'procedure']);

export const isFlow = (node: ProseMirrorNode) => FLOWS.has(node.type.name);
export const isSection = (node: ProseMirrorNode | null | undefined) =>
  node?.type.name === 'section';
export const isTitle = (node: ProseMirrorNode | null | undefined) =>
  node?.type.name === 'title';
/** A list item's own text: in a procedure's step, what the step's blocks stand under. */
export const isStepText = (node: ProseMirrorNode | null | undefined) =>
  node?.type.name === 'itemText';
/** A procedure's step (a list item of a procedure): the flow of the blocks under its text. */
export const isStep = (
  node: ProseMirrorNode,
  parent: ProseMirrorNode | null | undefined,
) => node.type.name === 'listItem' && parent?.type.name === 'procedure';
/** Where a step's blocks move as blocks of a flow: holders the drop rules look into. */
const REACHED = new Set([
  'doc',
  'section',
  'variant',
  'safety',
  'faq',
  'procedure',
]);

/** The containers whose blocks form a flow: what the drop rules let a block go into. */
export const CONTAINERS: ReadonlySet<string> = new Set([
  'variant',
  'safety',
  'faq',
]);

/** Whether every node above `depth` of `$pos` is a flow, a container or a step. */
function reached($pos: ResolvedPos, depth: number): boolean {
  for (let d = depth - 1; d >= 0; d -= 1) {
    const node = $pos.node(d);
    if (REACHED.has(node.type.name)) continue;
    if (d > 0 && isStep(node, $pos.node(d - 1))) continue;
    return false;
  }
  return true;
}

/**
 * Whether the node at `depth` of `$pos` is a step whose blocks form a flow: a procedure's step
 * reached through flows, variant and safety blocks and steps only. A step of a procedure in a
 * note, a table cell or a list item is moved whole, as the procedure's step.
 */
export function isStepFlow($pos: ResolvedPos, depth: number): boolean {
  if (depth < 1 || !isStep($pos.node(depth), $pos.node(depth - 1)))
    return false;
  return reached($pos, depth);
}

/**
 * Whether the node at `depth` of `$pos` is a container whose blocks form a flow: a variant
 * block, a safety notice or an FAQ entry reached the way a step's flow is. In a note, a table
 * cell or a list item it moves whole, its blocks with it.
 */
export function isContainerFlow($pos: ResolvedPos, depth: number): boolean {
  if (depth < 1 || !CONTAINERS.has($pos.node(depth).type.name)) return false;
  return reached($pos, depth);
}

/** What leads a flow and is no block of it: a title, a step's text, a hazard, a question. */
const isLead = (node: ProseMirrorNode | null | undefined) =>
  isTitle(node) ||
  isStepText(node) ||
  node?.type.name === 'hazard' ||
  node?.type.name === 'question';
export const isBlank = (node: ProseMirrorNode | null | undefined) =>
  node?.type.name === 'paragraph' && node.childCount === 0;

/** A block of a flow: where the flow's content starts, the block's index in it and its place. */
export interface FlowBlock {
  /** The position where the flow's content starts: 0 for the document. */
  flow: number;
  index: number;
  pos: number;
  node: ProseMirrorNode;
}

/**
 * The flow block around `$pos`: the child of the innermost flow that holds it. In a section's
 * title, that is the section itself, in the flow around it. Null where there is none (an empty
 * document, the document's end).
 */
export function blockAround($pos: ResolvedPos): FlowBlock | null {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const flow = $pos.node(depth);
    if (
      !isFlow(flow) &&
      !isStepFlow($pos, depth) &&
      !isContainerFlow($pos, depth)
    )
      continue;
    const index = $pos.index(depth);
    const node = flow.maybeChild(index);
    // The title stands for its section, one flow out (a step's text for its step, a hazard for
    // its safety notice, a question for its FAQ entry); so does a section's very end.
    if (!node || isLead(node)) continue;
    return {
      flow: $pos.start(depth),
      index,
      pos: $pos.posAtIndex(index, depth),
      node,
    };
  }
  return null;
}

/** The flow whose content starts at `flow`. */
export function flowNode(doc: ProseMirrorNode, flow: number): ProseMirrorNode {
  return flow === 0 ? doc : doc.resolve(flow).parent;
}

/** The start position of each child of the flow, its title included. */
export function childStarts(doc: ProseMirrorNode, flow: number): number[] {
  const starts: number[] = [];
  flowNode(doc, flow).forEach((_node, offset) => starts.push(flow + offset));
  return starts;
}

/**
 * The indexes a child of the flow may stand at within it: blocks between the title and the first
 * section, sections after the blocks. Null for the title.
 */
export function allowedRange(
  flow: ProseMirrorNode,
  index: number,
): { first: number; last: number } | null {
  const child = flow.maybeChild(index);
  if (!child || isLead(child)) return null;
  let firstBlock = 0;
  let firstSection = flow.childCount;
  flow.forEach((node, _offset, i) => {
    if (isLead(node)) firstBlock = i + 1;
    else if (isSection(node) && i < firstSection) firstSection = i;
  });
  return isSection(child)
    ? { first: firstSection, last: flow.childCount - 1 }
    : { first: firstBlock, last: firstSection - 1 };
}
