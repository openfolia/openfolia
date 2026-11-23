import {
  walk,
  type Block,
  type Condition,
  type HiddenContent,
  type Inline,
  type Item,
} from '@openfolia/content-model';

/** What a preview lists as hidden for its variant, as the API answers it. */
export interface HiddenItem {
  kind: HiddenContent['kind'];
  /** The module (a variant block's, or the module entry); none for a group. */
  module?: string;
  /** The variant block's own ID; only for a block. */
  block?: string;
  when: Condition;
  /**
   * How a person recognises it: a block's first text (at most
   * `LABEL_LENGTH` characters), a module's or group's title. Empty when a
   * block holds no text (an image without alt text, say).
   */
  label: string;
}

export const LABEL_LENGTH = 120;

/** Turns what resolving left out into the items a preview lists. */
export function hiddenItems(hidden: readonly HiddenContent[]): HiddenItem[] {
  return hidden.map((h): HiddenItem => {
    switch (h.kind) {
      case 'block':
        return {
          kind: 'block',
          module: h.module,
          block: h.block,
          when: h.when,
          label: firstText(h.blocks),
        };
      case 'module':
        return {
          kind: 'module',
          module: h.module,
          when: h.when,
          label: h.title,
        };
      case 'group':
        return { kind: 'group', when: h.when, label: h.title };
      default:
        return h satisfies never;
    }
  });
}

/** The first text in the blocks, in document order, whitespace folded and cut to a label's length. */
function firstText(blocks: readonly Block[]): string {
  for (const { node } of walk(blocks)) {
    const text = ownText(node).replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    const chars = [...text];
    return chars.length <= LABEL_LENGTH
      ? text
      : `${chars
          .slice(0, LABEL_LENGTH - 1)
          .join('')
          .trimEnd()}…`;
  }
  return '';
}

/** The plain text a block or item carries itself (not its children's). */
function ownText(node: Block | Item): string {
  if (!('type' in node)) return inlineText(node.content);
  switch (node.type) {
    case 'paragraph':
      return inlineText(node.content);
    case 'section':
      return inlineText(node.title);
    case 'procedure':
    case 'table':
      return inlineText(node.title);
    case 'image':
      return node.alt || inlineText(node.title);
    case 'attachment':
      return node.name;
    case 'safety':
      return inlineText(node.hazard);
    case 'faq':
      return inlineText(node.question);
    case 'literal':
      return node.text;
    case 'list':
    case 'admonition':
    case 'variant':
    case 'moduleRef':
    case 'passthrough':
    case 'pageBreak':
      return '';
    default:
      node satisfies never;
      return '';
  }
}

function inlineText(content: readonly Inline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'xref':
          return node.text?.map((run) => run.text).join('') ?? '';
        case 'kbd':
          return node.keys.join('+');
        case 'hardBreak':
          return ' ';
        case 'attribute':
          return `{${node.name}}`;
        case 'placeholder':
        case 'calloutRef':
          // A placeholder is a page design's value, never in a module (a validation error); a
          // callout reference's number depends on the variant.
          return '';
        default:
          node satisfies never;
          return '';
      }
    })
    .join('');
}
