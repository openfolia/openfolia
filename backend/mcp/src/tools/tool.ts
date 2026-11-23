import { z } from 'zod';
import { ToolError, type ContentApi } from '../api-client.js';
import type { ReleasedRefs, TokenCheck } from '../released.js';

/** What every tool reads through. */
export interface ToolContext {
  readonly api: ContentApi;
  readonly refs: ReleasedRefs;
  readonly token: TokenCheck;
  /** The call's cancellation and deadline. */
  readonly signal?: AbortSignal;
}

/** A tool's answer: `structured` as JSON, and `text` for clients that read only text (default: `structured` as JSON). */
export interface ToolOutput {
  readonly structured: Record<string, unknown>;
  readonly text?: string;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Shape;
  run(
    context: ToolContext,
    args: z.infer<z.ZodObject<Shape>>,
  ): Promise<ToolOutput>;
}

/** Declares a tool, keeping its argument types. */
export function defineTool<Shape extends z.ZodRawShape>(
  tool: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return tool;
}

/** IDs as the content model has them: modules, manuals, terms. */
export const Id = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a lowercase slug, e.g. "charging"');
export const Lang = z
  .string()
  .max(35)
  .regex(
    /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
    'a BCP 47 language tag, e.g. "en" or "pt-BR"',
  );
/** A configuration key: a module type, an audience level, a facet ID. */
export const ConfigKey = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'a configuration ID, e.g. "procedure"');
const SLUG_PART = '[a-z][a-z0-9-]*=[A-Za-z0-9.~;-]+';
export const VariantSlug = z
  .string()
  .min(1)
  .max(500)
  .regex(
    new RegExp(`^${SLUG_PART}(,${SLUG_PART})*$`),
    'a variant slug such as `model=large`',
  )
  .describe(
    'A variant slug, as `list_manuals` lists them, e.g. `model=large` (several attributes separated by `,`).',
  );
export const Facets = z
  .array(
    z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/,
        '`<facet>:<value>`, e.g. `region:north`',
      ),
  )
  .max(32)
  .describe('Facet values as `<facet>:<value>`; every one has to hold.');
export const Keywords = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^,]+$/, 'no comma'),
  )
  .max(32)
  .describe(
    'Exact keywords (case and diacritics aside); every one has to hold.',
  );

/** The largest page number a cursor may name. */
const MAX_PAGE = 10_000;

/** A cursor for the next page of a list: the page number, as a string. */
export const PageCursor = z
  .string()
  .regex(/^[1-9][0-9]{0,4}$/, 'a cursor a previous answer gave in `nextCursor`')
  .describe('`nextCursor` of the previous answer, for the next page.');

export function pageOf(cursor: string | undefined): number {
  const page = cursor === undefined ? 1 : Number(cursor);
  if (page > MAX_PAGE) {
    throw new ToolError('invalid-cursor', 'The cursor is past the last page');
  }
  return page;
}

/** `nextCursor` for a page, or null after the last one. */
export function nextPage(meta: {
  currentPage: number;
  lastPage: number;
}): string | null {
  return meta.currentPage < meta.lastPage && meta.currentPage < MAX_PAGE
    ? String(meta.currentPage + 1)
    : null;
}

/** A cursor into a long text: the character offset to go on from. */
export const TextCursor = z
  .string()
  .regex(
    /^(0|[1-9][0-9]{0,8})$/,
    'a cursor a previous answer gave in `nextCursor`',
  )
  .describe(
    '`nextCursor` of the previous answer, for the text after what it gave.',
  );

/**
 * At most `limit` characters of `text` from the cursor's offset, never
 * splitting a surrogate pair, with the cursor for the rest (null when none).
 */
export function sliceText(
  text: string,
  cursor: string | undefined,
  limit: number,
): { text: string; nextCursor: string | null; total: number } {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (start > text.length) {
    throw new ToolError(
      'invalid-cursor',
      'The cursor is past the end of the text',
    );
  }
  let end = Math.min(text.length, start + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return {
    text: text.slice(start, end),
    nextCursor: end < text.length ? String(end) : null,
    total: text.length,
  };
}

/** Plain text made safe inside Markdown: every character Markdown reads as markup is escaped. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, '\\$&');
}

/**
 * An ID the API gave, as Markdown code: in backticks when it is a plain
 * identifier (it then holds no backtick), else escaped as text.
 */
export function idMarkdown(id: string): string {
  return /^[A-Za-z0-9._=,~;-]{1,500}$/.test(id)
    ? `\`${id}\``
    : escapeMarkdown(id);
}

/** The API's URL of a resource, for a person or a client to follow. */
export function apiUrl(api: ContentApi, path: string, ref: string): string {
  return `${api.baseUrl}${path}?ref=${encodeURIComponent(ref)}`;
}

/**
 * A title or label as the API stores it (#731): one text for every language, or one per
 * language by language tag.
 */
export const LocalizedText = z.union([
  z.string(),
  z.record(z.string(), z.string()),
]);
export type LocalizedText = z.infer<typeof LocalizedText>;

/**
 * A title or label for a tool's answer: `text`, the one for every language or the source
 * language's (else its first), and `byLanguage`, every language's when it is written per
 * language (none for one text).
 */
export function localizedFields(
  text: LocalizedText,
  source: string,
): { text: string; byLanguage?: Record<string, string> } {
  if (typeof text === 'string') return { text };
  return {
    text: text[source] ?? Object.values(text)[0] ?? '',
    byLanguage: { ...text },
  };
}
