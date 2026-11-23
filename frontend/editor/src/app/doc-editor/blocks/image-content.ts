import {
  Fragment,
  type Node as ProseMirrorNode,
  type Schema,
} from '@tiptap/pm/model';

import type { ImageChoice } from './doc-blocks-context';

/** One line, trimmed: what an alt text or a caption from a form field becomes. */
export const oneLine = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

/** An image's caption: the text of its title, never its callouts' legends. */
export function captionOf(image: ProseMirrorNode): string {
  const first = image.firstChild;
  return first?.type.name === 'title' ? first.textContent : '';
}

/**
 * An image's content: its caption as its title (nothing for none), then the callouts of
 * `image` as they are, so a new caption never takes them away (#498).
 */
export function imageContent(
  schema: Schema,
  caption: string,
  image?: ProseMirrorNode,
): Fragment {
  const line = oneLine(caption);
  const title = schema.nodes['title'];
  if (!title) throw new Error('the schema has no title');
  const nodes: ProseMirrorNode[] = line
    ? [title.create(null, schema.text(line))]
    : [];
  image?.forEach((child) => {
    if (child.type.name !== 'title') nodes.push(child);
  });
  return Fragment.from(nodes);
}

/** A new image block (no ID yet: the repair step gives it one) from the image picker's choice. */
export function newImage(schema: Schema, choice: ImageChoice): ProseMirrorNode {
  const image = schema.nodes['image'];
  if (!image) throw new Error('the schema has no image');
  return image.create(
    {
      id: null,
      asset: choice.asset,
      alt: oneLine(choice.alt),
      width: choice.width,
    },
    imageContent(schema, choice.caption),
  );
}
