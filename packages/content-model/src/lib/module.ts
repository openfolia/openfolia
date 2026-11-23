import { z } from 'zod';
import { Block } from './blocks.js';
import { Deprecation } from './deprecation.js';
import { ConfigKey, LanguageTag, ModuleId, SingleLine } from './ids.js';
import { checkStructure } from './structure.js';
import { TABLE_TOO_LARGE, tablesTooLarge } from './table-limits.js';
import { walk } from './walk.js';

/** Bumped on every breaking change to the model; each bump ships a migration. */
export const CURRENT_SCHEMA_VERSION = 1;

/** The longest keyword, in characters (UTF-16 units). */
export const MAX_KEYWORD_LENGTH = 64;
/** The most keywords a module (one language file) holds. */
export const MAX_KEYWORDS = 32;

/**
 * A free-form keyword, a word or short phrase in the module's language.
 * Stored in NFC with runs of whitespace as one space and no leading or
 * trailing whitespace; 1 to `MAX_KEYWORD_LENGTH` characters. The AsciiDoc
 * header separates keywords by commas, so a keyword holds none (nor any
 * control character).
 */
export const Keyword = z
  .string()
  .overwrite((k) => k.normalize('NFC').replace(/\s+/g, ' ').trim())
  .min(1, 'a keyword needs at least one character')
  .max(
    MAX_KEYWORD_LENGTH,
    `a keyword has at most ${MAX_KEYWORD_LENGTH} characters`,
  )
  .regex(/^[^,\p{Cc}]+$/u, 'a keyword holds no comma or control character');
export type Keyword = z.infer<typeof Keyword>;

/** The key two keywords are the same by: case aside (`Battery` is `battery`). */
export const keywordKey = (keyword: string): string =>
  keyword.normalize('NFC').toLowerCase();

/** `keywords` without the repeats (case aside), the first spelling kept, in order. */
export function uniqueKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  return keywords.filter((k) => {
    const key = keywordKey(k);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Module metadata. Workflow status is deliberately absent: it is derived
 * from Git (latest release + open change set), never stored.
 */
export const ModuleMeta = z.object({
  title: SingleLine,
  /** One of the configured module types, e.g. "procedure" or "safety". */
  type: ConfigKey,
  lang: LanguageTag,
  /** One of the configured audience levels. Missing means the most restricted level. */
  audience: ConfigKey.optional(),
  /** Configured classification dimensions, e.g. { "product-line": ["forklifts"], "region": ["eu"] }. */
  facets: z
    .record(
      ConfigKey,
      z
        .array(ConfigKey)
        .min(1)
        .refine(
          (values) => new Set(values).size === values.length,
          'duplicate facet value',
        ),
    )
    .default({}),
  /**
   * Free-form keywords in the module's language, for finding it: not
   * configured, unlike facets. Repeats (case aside) are dropped, the first
   * spelling kept; at most `MAX_KEYWORDS`. An empty list is the same as none.
   */
  keywords: z
    .array(Keyword)
    .overwrite(uniqueKeywords)
    .max(MAX_KEYWORDS, `at most ${MAX_KEYWORDS} keywords`)
    .optional(),
  /** Where the module came from when it was imported, for traceability. */
  source: z.object({ system: SingleLine, id: SingleLine }).optional(),
  /**
   * Withdrawn or superseded (#266), with why and what replaces it (a module
   * ID). The module's deprecation is its source-language file's: a
   * translation's own is not read.
   */
  deprecated: Deprecation.optional(),
});
export type ModuleMeta = z.infer<typeof ModuleMeta>;

export const Module = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: ModuleId,
    meta: ModuleMeta,
    blocks: z.array(Block),
  })
  .superRefine((module, ctx) => {
    // Callouts share the blocks' IDs: a reference, a translation or a comment names either alike.
    const seen = new Set<string>();
    const check = (id: string, what: string) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate ${what} id "${id}"`,
          path: ['blocks'],
        });
      }
      seen.add(id);
    };
    for (const { node } of walk(module.blocks)) {
      check(node.id, 'block');
      if ('type' in node && node.type === 'image') {
        for (const callout of node.callouts ?? []) check(callout.id, 'callout');
      }
    }
    // The tables' places together (#686): past the cap, no table's grid is checked.
    let cells = 0;
    for (const { node } of walk(module.blocks)) {
      if ('type' in node && node.type === 'table') {
        cells += node.rows.length * node.columns.length;
      }
    }
    const problem = tablesTooLarge(cells);
    if (problem) {
      ctx.addIssue({
        code: 'custom',
        message: problem,
        path: ['blocks'],
        params: { code: TABLE_TOO_LARGE },
      });
      return;
    }
    for (const message of checkStructure(module.blocks)) {
      ctx.addIssue({ code: 'custom', message, path: ['blocks'] });
    }
  });
export type Module = z.infer<typeof Module>;
