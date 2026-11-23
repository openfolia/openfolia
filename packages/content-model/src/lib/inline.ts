import { z } from 'zod';
import { BlockId, ConfigKey, ModuleId, TermId } from './ids.js';

export { MARK_ORDER } from './mark-order.js';

/**
 * A link's address: an absolute `http:` or `https:` URL with a host, or a `mailto:` address.
 * Any other scheme (`javascript:`, `data:`, `file:`, …) and a relative address are refused, so a
 * link can never run script or point at the page around it.
 */
export const LinkHref = z
  .url({ protocol: /^(https?|mailto)$/ })
  // Reject host-less forms like "https:foo", which browsers resolve relative to the page.
  .refine(
    (href) => /^mailto:/i.test(href) || /^https?:\/\/[^/]/i.test(href),
    'absolute URL with a host',
  )
  .refine(
    (href) => !/[\s[\]|]/.test(href),
    'no whitespace, square brackets or "|"; percent-encode them',
  )
  // Nor control characters, a backslash or invisible format characters (zero-width, direction
  // overrides), which would make the address shown differ from the one opened.
  .refine(
    // Cc: control characters; Cf: format characters (zero-width, soft hyphen, direction marks).
    (href) => !/[\p{Cc}\p{Cf}\\]/u.test(href),
    'no control, invisible or direction characters, and no backslash',
  );

/**
 * Whether `href` may be a link's address (`LinkHref`). Every place that takes or shows a link
 * checks this one rule: the editor on input, `fromEditor`, and the HTML and PDF renderers.
 */
export function isLinkHref(href: unknown): href is string {
  return typeof href === 'string' && LinkHref.safeParse(href).success;
}

/**
 * Inline content mirrors ProseMirror: flat runs of text carrying marks,
 * plus a few inline nodes. No nesting, so editor mapping is one-to-one.
 */
export const Mark = z.discriminatedUnion('type', [
  z.object({ type: z.literal('strong') }),
  z.object({ type: z.literal('emphasis') }),
  z.object({ type: z.literal('code') }),
  z.object({ type: z.literal('sub') }),
  z.object({ type: z.literal('sup') }),
  /** A label shown in a user interface: button, menu entry, screen name. */
  z.object({ type: z.literal('ui') }),
  z.object({ type: z.literal('link'), href: LinkHref }),
  /**
   * A term link (#245): the text names the term `termId` (`terms/<id>.yaml`),
   * and links to its glossary entry, with its definition. Never on the same
   * text as a link: both are links.
   */
  z.object({ type: z.literal('term'), termId: TermId }),
]);
export type Mark = z.infer<typeof Mark>;

/** Whether marks hold a link or a term link: what a link's own text may not. */
export const isLinking = (mark: Mark): boolean =>
  mark.type === 'link' || mark.type === 'term';

export const TextNode = z.object({
  type: z.literal('text'),
  /** Never contains line breaks; use a `hardBreak` node. */
  text: z
    .string()
    .min(1)
    .regex(/^[^\n\r]*$/, 'no line breaks; use a hardBreak node'),
  marks: z
    .array(Mark)
    .refine(
      (marks) => new Set(marks.map((m) => m.type)).size === marks.length,
      'each mark type at most once',
    )
    .refine(
      (marks) => marks.filter(isLinking).length <= 1,
      'a link and a term link never mark the same text',
    )
    .optional(),
});
export type TextNode = z.infer<typeof TextNode>;

/**
 * A named text value filled in at build time, e.g. the product name or a
 * rated load. Its value can differ per variant, which covers most cases of
 * "this word changes per model" without inline conditions.
 */
export const AttributeRef = z.object({
  type: z.literal('attribute'),
  /** "empty" is reserved: AsciiDoc uses `{empty}` as an invisible placeholder. */
  name: ConfigKey.refine(
    (name) => name !== 'empty',
    '"empty" is a reserved attribute name',
  ),
});
export type AttributeRef = z.infer<typeof AttributeRef>;

/** Cross-reference to a module, or to a block inside one. Text defaults to the target's title. */
export const Xref = z.object({
  type: z.literal('xref'),
  module: ModuleId,
  block: BlockId.optional(),
  /** Link text; may carry marks, but not a link or a term link of its own. */
  text: z
    .array(TextNode)
    .min(1)
    .refine(
      (runs) => runs.every((r) => !r.marks?.some(isLinking)),
      'no links or term links inside cross-reference text',
    )
    .optional(),
});
export type Xref = z.infer<typeof Xref>;

/** Keyboard shortcut, e.g. ["Ctrl", "S"]. */
export const Kbd = z.object({
  type: z.literal('kbd'),
  keys: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^[^\n\r\]]+$/, 'no line breaks or "]"'),
    )
    .min(1),
});
export type Kbd = z.infer<typeof Kbd>;

/**
 * A reference to a callout on an image (#498): the callout's number as the
 * reader sees it ("press the switch (1)"). `block` is an image block in the
 * same module, `callout` one of its callouts. The number is derived when the
 * manual is resolved (`ResolvedManual.callouts`), never stored; a reference
 * to a missing callout, or to one its variant hides, is a finding.
 */
export const CalloutRef = z.object({
  type: z.literal('calloutRef'),
  block: BlockId,
  callout: BlockId,
});
export type CalloutRef = z.infer<typeof CalloutRef>;

export const HardBreak = z.object({ type: z.literal('hardBreak') });
export type HardBreak = z.infer<typeof HardBreak>;

/**
 * A page design's placeholder (#390): data filled in when a manual is put on its pages (the
 * title, the release, the page number, …; `PLACEHOLDER_KEYS`). Only a page design's text holds
 * one: a module's text with one is a validation error (`placeholder-in-module`). The key is any
 * configuration key here; one that is not a placeholder key is a validation error of the design
 * (`unknown-placeholder`), so a file with it still reads.
 */
export const Placeholder = z.object({
  type: z.literal('placeholder'),
  key: ConfigKey,
});
export type Placeholder = z.infer<typeof Placeholder>;

export const Inline = z.discriminatedUnion('type', [
  TextNode,
  AttributeRef,
  Xref,
  Kbd,
  CalloutRef,
  HardBreak,
  Placeholder,
]);
export type Inline = z.infer<typeof Inline>;

/** A run of inline content; never empty. */
export const InlineContent = z.array(Inline).min(1);

/** Inline content for titles and headings, which are single lines. */
export const InlineTitle = InlineContent.refine(
  (nodes) => nodes.every((n) => n.type !== 'hardBreak'),
  'titles cannot contain line breaks',
);
