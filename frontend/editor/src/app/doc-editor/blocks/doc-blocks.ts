import { Node, type Editor, type Extensions } from '@tiptap/core';
import {
  Fragment,
  type Node as ProseMirrorNode,
  type NodeType,
  type Schema,
} from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type Command } from '@tiptap/pm/state';

import { findBlock } from '../plugins/block-issues';
import { blockAt, isStepText, placeFor } from '../plugins/block-place';
import { isBlank, isSection, isTitle } from '../plugins/flow';
import { AdmonitionNodeComponent } from './admonition-node.component';
import { AttachmentNodeComponent } from './attachment-node.component';
import { FaqNodeComponent } from './faq-node.component';
import { angularNodeView, type AngularHost } from './angular-node-view';
import {
  docBlocksOf,
  type AttachmentChoice,
  type ImageChoice,
} from './doc-blocks-context';
import { captionOf, imageContent, newImage, oneLine } from './image-content';
import { ImageNodeComponent } from './image-node.component';
import { LiteralNodeComponent } from './literal-node.component';
import { ModuleRefNodeComponent } from './module-ref-node.component';
import { PageBreakNodeComponent } from './page-break-node.component';
import { PassthroughNodeComponent } from './passthrough-node.component';
import { ProcedureNodeComponent } from './procedure-node.component';
import { SafetyNodeComponent } from './safety-node.component';
import { VariantNodeComponent } from './variant-node.component';

// The documentation blocks: a safety notice, a variant block, a module reference, an image, an
// attachment, an admonition, an FAQ entry, a procedure, a code block (`literal`) and a passthrough, drawn by their node views
// (Angular components on `@openfolia/ui`'s blocks) on the content model's own node types, and the commands that insert them. The node types and their content stay
// exactly the model's: a node view changes how a block shows and is edited, never what is stored.

/**
 * The block types with a node view here, whether their content is edited in place, and whether
 * the editor treats them as one piece (an atom: selected, moved and deleted whole). An image's
 * caption is its content, edited with the rest of the image in the image dialog.
 */
const VIEWS = {
  safety: { component: SafetyNodeComponent, content: true, atom: false },
  variant: { component: VariantNodeComponent, content: true, atom: false },
  moduleRef: { component: ModuleRefNodeComponent, content: false, atom: false },
  image: { component: ImageNodeComponent, content: false, atom: true },
  attachment: {
    component: AttachmentNodeComponent,
    content: false,
    atom: true,
  },
  admonition: {
    component: AdmonitionNodeComponent,
    content: true,
    atom: false,
  },
  faq: { component: FaqNodeComponent, content: true, atom: false },
  procedure: { component: ProcedureNodeComponent, content: true, atom: false },
  literal: { component: LiteralNodeComponent, content: true, atom: false },
  passthrough: {
    component: PassthroughNodeComponent,
    content: false,
    atom: true,
  },
  pageBreak: { component: PageBreakNodeComponent, content: false, atom: true },
} as const;

export type DocBlockType = keyof typeof VIEWS;

/** The block types drawn by a node view of their own. */
export const DOC_BLOCK_TYPES = Object.keys(VIEWS) as readonly DocBlockType[];

const hasView = (name: string): name is DocBlockType =>
  Object.hasOwn(VIEWS, name);

/**
 * The content model's node extensions with the documentation blocks drawn by their node views.
 * Without a host (a test editor, a server) they keep the model's own HTML (an image is an atom
 * either way).
 */
export function withDocBlocks(
  extensions: Extensions,
  host: AngularHost | null,
): Extensions {
  return extensions.map((extension) => {
    if (!(extension instanceof Node) || !hasView(extension.name))
      return extension;
    const { component, content, atom } = VIEWS[extension.name];
    if (!host)
      return atom
        ? extension.extend({ atom: true, selectable: true })
        : extension;
    return extension.extend({
      ...(atom ? { atom: true } : {}),
      selectable: true,
      draggable: false,
      addNodeView: () => angularNodeView(component, host, { content }),
    });
  });
}

const nodeType = (schema: Schema, name: string): NodeType => {
  const type = schema.nodes[name];
  if (!type) throw new Error(`the schema has no ${name}`);
  return type;
};

/** A new safety notice: the default level, no symbols, an empty hazard, consequence and measure. */
export function newSafety(schema: Schema): ProseMirrorNode {
  const paragraph = () => nodeType(schema, 'paragraph').create();
  return nodeType(schema, 'safety').create(
    { id: null, severity: 'warning', symbols: [] },
    [nodeType(schema, 'hazard').create(), paragraph(), paragraph()],
  );
}

/** A new variant block around `content` (an empty paragraph by default), with no condition yet. */
export function newVariant(
  schema: Schema,
  content?: ProseMirrorNode,
): ProseMirrorNode {
  return nodeType(schema, 'variant').create(
    { id: null, when: null },
    content ?? nodeType(schema, 'paragraph').create(),
  );
}

/** A new module reference, to no module yet. */
export function newModuleRef(schema: Schema): ProseMirrorNode {
  return nodeType(schema, 'moduleRef').create({ id: null, module: '' });
}

/** A safety notice's hazard or an FAQ entry's question: the line that leads its block. */
const isHazard = (node: ProseMirrorNode) =>
  node.type.name === 'hazard' || node.type.name === 'question';

/**
 * Inserts a safety notice at the caret (in place of a blank line, else after its block) with
 * the caret in its hazard.
 */
export const insertSafety: Command = (state, dispatch) => {
  const type = nodeType(state.schema, 'safety');
  const place = placeFor(state, type);
  if (!place) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(
      place.from,
      place.to,
      newSafety(state.schema),
    );
    tr.setSelection(TextSelection.create(tr.doc, place.from + 2));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Puts the block at the caret into a new variant block (a section's heading: a new, empty one
 * as the section's first block; a safety notice's hazard: one as its first block; a blank line:
 * an empty one in its place). The caret stays where it was in the block.
 */
export const insertVariant: Command = (state, dispatch) => {
  const type = nodeType(state.schema, 'variant');
  const block = blockAt(state.selection.$from);
  if (
    block &&
    !isSection(block.node) &&
    !isHazard(block.node) &&
    !isStepText(block.node) &&
    !isBlank(block.node)
  ) {
    const $at = state.doc.resolve(block.pos);
    if (!$at.parent.canReplaceWith($at.index(), $at.index() + 1, type))
      return false;
    if (dispatch) {
      const { from, to } = state.selection;
      const tr = state.tr.replaceWith(
        block.pos,
        block.pos + block.node.nodeSize,
        newVariant(state.schema, block.node),
      );
      const inside = (pos: number) =>
        Math.min(pos + 1, block.pos + block.node.nodeSize);
      tr.setSelection(
        state.selection instanceof NodeSelection
          ? NodeSelection.create(tr.doc, block.pos)
          : TextSelection.create(tr.doc, inside(from), inside(to)),
      );
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  const place = placeFor(state, type);
  if (!place) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(
      place.from,
      place.to,
      newVariant(state.schema),
    );
    tr.setSelection(TextSelection.create(tr.doc, place.from + 2));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Inserts a module reference at the caret, selected, so its "Choose module" is next. */
export const insertModuleRef: Command = (state, dispatch) => {
  const type = nodeType(state.schema, 'moduleRef');
  const place = placeFor(state, type);
  if (!place) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(
      place.from,
      place.to,
      Fragment.from(newModuleRef(state.schema)),
    );
    tr.setSelection(NodeSelection.create(tr.doc, place.from));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Inserts the chosen image at the caret (in place of a blank line, else after its block),
 * selected. Without a choice it only says whether an image could go there.
 */
export const insertImage =
  (choice: ImageChoice | null): Command =>
  (state, dispatch) => {
    const type = nodeType(state.schema, 'image');
    const place = placeFor(state, type);
    if (!place) return false;
    if (choice && dispatch) {
      const tr = state.tr.replaceWith(
        place.from,
        place.to,
        newImage(state.schema, choice),
      );
      tr.setSelection(NodeSelection.create(tr.doc, place.from));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

/** Whether the page around `editor` offers the image picker, and the document can be changed. */
export function canPickImage(editor: Editor): boolean {
  const context = docBlocksOf(editor);
  return !!context?.settings().pickImage && context.editable();
}

/**
 * Opens the image picker and inserts what was chosen where the caret was (the dialog leaves the
 * editor's selection alone). Resolves to whether an image was inserted: not when the picker is
 * cancelled, missing, or the editor went or became read-only meanwhile.
 */
export async function pickAndInsertImage(
  editor: Editor,
  file?: File,
): Promise<boolean> {
  const pick = docBlocksOf(editor)?.settings().pickImage;
  if (!pick || !canPickImage(editor) || !insertImage(null)(editor.state))
    return false;
  const choice = await (file ? pick(null, file) : pick(null));
  if (!choice || editor.isDestroyed || !canPickImage(editor)) return false;
  editor.commands.focus();
  return insertImage(choice)(editor.state, editor.view.dispatch);
}

/**
 * Opens the image picker on the image block with this ID, as its Edit does, and puts back what
 * comes out in one step that Undo takes back (the media library's "Replace in <language>").
 * Resolves to whether the image changed: not when there is no such image block, the picker is
 * cancelled or missing, or the editor went or became read-only meanwhile.
 */
export async function pickAndReplaceImage(
  editor: Editor,
  id: string,
): Promise<boolean> {
  const pick = docBlocksOf(editor)?.settings().pickImage;
  const found = findBlock(editor.state.doc, id);
  if (!pick || !canPickImage(editor) || found?.node.type.name !== 'image')
    return false;
  const { asset, alt, width } = found.node.attrs;
  const current: ImageChoice = {
    asset: typeof asset === 'string' ? asset : '',
    alt: typeof alt === 'string' ? alt : '',
    caption: captionOf(found.node),
    width: typeof width === 'number' ? width : null,
  };
  const next = await pick(current);
  if (!next || editor.isDestroyed || !canPickImage(editor)) return false;
  // Found again: the document may have changed while the picker was open.
  const now = findBlock(editor.state.doc, id);
  if (now?.node.type.name !== 'image') return false;
  const { state, view } = editor;
  const tr = state.tr;
  if (next.caption !== current.caption) {
    tr.replaceWith(
      now.pos + 1,
      now.pos + now.node.nodeSize - 1,
      imageContent(state.schema, next.caption, now.node),
    );
  }
  tr.setNodeMarkup(now.pos, undefined, {
    ...now.node.attrs,
    asset: next.asset,
    alt: oneLine(next.alt),
    width: next.width,
  });
  tr.setSelection(NodeSelection.create(tr.doc, now.pos));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** A new attachment block (no ID yet: the repair step gives it one) from the dialog's choice. */
export function newAttachment(
  schema: Schema,
  choice: AttachmentChoice,
): ProseMirrorNode {
  const description = oneLine(choice.description);
  return nodeType(schema, 'attachment').create({
    id: null,
    asset: choice.asset,
    name: oneLine(choice.name),
    description: description || null,
    fileName: choice.fileName,
    mediaType: choice.mediaType,
    size: choice.size,
  });
}

/**
 * Inserts the chosen file at the caret (in place of a blank line, else after its block),
 * selected. Without a choice it only says whether an attachment could go there.
 */
export const insertAttachment =
  (choice: AttachmentChoice | null): Command =>
  (state, dispatch) => {
    const type = nodeType(state.schema, 'attachment');
    const place = placeFor(state, type);
    if (!place) return false;
    if (choice && dispatch) {
      const tr = state.tr.replaceWith(
        place.from,
        place.to,
        newAttachment(state.schema, choice),
      );
      tr.setSelection(NodeSelection.create(tr.doc, place.from));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

/** Whether the page around `editor` offers the attach-file dialog, and the document can be changed. */
export function canPickAttachment(editor: Editor): boolean {
  const context = docBlocksOf(editor);
  return !!context?.settings().pickAttachment && context.editable();
}

/**
 * Opens the attach-file dialog and inserts what was chosen where the caret was (the dialog leaves
 * the editor's selection alone). Resolves to whether an attachment was inserted: not when the
 * dialog is cancelled, missing, or the editor went or became read-only meanwhile.
 */
export async function pickAndInsertAttachment(
  editor: Editor,
): Promise<boolean> {
  const pick = docBlocksOf(editor)?.settings().pickAttachment;
  if (
    !pick ||
    !canPickAttachment(editor) ||
    !insertAttachment(null)(editor.state)
  )
    return false;
  const choice = await pick(null);
  if (!choice || editor.isDestroyed || !canPickAttachment(editor)) return false;
  editor.commands.focus();
  return insertAttachment(choice)(editor.state, editor.view.dispatch);
}

/** A new admonition: a note holding an empty paragraph. */
export function newAdmonition(schema: Schema): ProseMirrorNode {
  return nodeType(schema, 'admonition').create(
    { id: null, kind: 'note' },
    nodeType(schema, 'paragraph').create(),
  );
}

/** A new FAQ entry: an empty question over an empty answer. */
export function newFaq(schema: Schema): ProseMirrorNode {
  return nodeType(schema, 'faq').create({ id: null }, [
    nodeType(schema, 'question').create(),
    nodeType(schema, 'paragraph').create(),
  ]);
}

/** A new procedure: no title, one empty step. */
export function newProcedure(schema: Schema): ProseMirrorNode {
  return nodeType(schema, 'procedure').create(
    { id: null },
    nodeType(schema, 'listItem').create(
      { id: null },
      nodeType(schema, 'itemText').create(),
    ),
  );
}

/** A new, empty code block with no language. */
export function newLiteral(schema: Schema): ProseMirrorNode {
  return nodeType(schema, 'literal').create({ id: null, language: null });
}

/** Inserts `create`'s block at the caret, with the caret `depth` levels into its first text. */
const inserting =
  (
    name: string,
    create: (schema: Schema) => ProseMirrorNode,
    depth: number,
  ): Command =>
  (state, dispatch) => {
    const type = nodeType(state.schema, name);
    const place = placeFor(state, type);
    if (!place) return false;
    if (dispatch) {
      const tr = state.tr.replaceWith(
        place.from,
        place.to,
        create(state.schema),
      );
      tr.setSelection(TextSelection.create(tr.doc, place.from + depth));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

/** A new page break. */
export function newPageBreak(schema: Schema): ProseMirrorNode {
  return nodeType(schema, 'pageBreak').create({ id: null });
}

/** Where a page can break: between the blocks of the document or a section. */
const FLOWS = new Set(['doc', 'section']);

/**
 * Inserts a page break, selected, where a page can break: in place of a blank line, else after the
 * block at the caret, in the document or the section the caret is in. Inside a list, a table, a
 * notice or a variant block it goes after that whole block; in a section's heading, as the
 * section's first block.
 */
export const insertPageBreak: Command = (state, dispatch) => {
  const type = nodeType(state.schema, 'pageBreak');
  const { $from } = state.selection;
  let from = state.doc.content.size;
  let to = from;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const flow = $from.node(depth);
    if (!FLOWS.has(flow.type.name)) continue;
    const index = $from.index(depth);
    const node = flow.maybeChild(index);
    const pos = $from.posAtIndex(index, depth);
    if (!node) {
      from = to = pos;
    } else if (isTitle(node)) {
      // The caret is in a section's heading: the break is its first block.
      from = to = pos + node.nodeSize;
    } else if (isBlank(node)) {
      from = pos;
      to = pos + node.nodeSize;
    } else {
      from = to = pos + node.nodeSize;
    }
    break;
  }
  // Blocks come before a flow's sections: never after one.
  const $at = state.doc.resolve(from);
  const index = $at.index();
  if (!$at.parent.canReplaceWith(index, to > from ? index + 1 : index, type))
    return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(from, to, newPageBreak(state.schema));
    tr.setSelection(NodeSelection.create(tr.doc, from));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Inserts a note (an admonition) at the caret, with the caret in its paragraph. */
export const insertAdmonition: Command = inserting(
  'admonition',
  newAdmonition,
  2,
);

/** Inserts an FAQ entry at the caret, with the caret in its question. */
export const insertFaq: Command = inserting('faq', newFaq, 2);

/** Inserts a procedure at the caret, with the caret in its first step. */
export const insertProcedure: Command = inserting('procedure', newProcedure, 3);

/** Inserts a code block at the caret, with the caret in it. */
export const insertLiteral: Command = inserting('literal', newLiteral, 1);

/**
 * The insert commands of the blocks inserted at once (an image and an attachment are chosen
 * first: `pickAndInsertImage`, `pickAndInsertAttachment`).
 */
export const INSERT_BLOCK: Record<
  Exclude<DocBlockType, 'image' | 'attachment' | 'passthrough'>,
  Command
> = {
  safety: insertSafety,
  variant: insertVariant,
  moduleRef: insertModuleRef,
  admonition: insertAdmonition,
  faq: insertFaq,
  procedure: insertProcedure,
  literal: insertLiteral,
  pageBreak: insertPageBreak,
};
