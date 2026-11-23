import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { parseInline, printInline } from './asciidoc/inline.js';
import { AsciidocParseError } from './asciidoc/syntax.js';
import type { ProjectConfig } from './config.js';
import { LanguageTag, TermId } from './ids.js';
import { HardBreak, type Inline, TextNode } from './inline.js';
import { normalizeInline } from './normalize.js';
import { foldText } from './snippet.js';
import type { Issue } from './validate.js';

/**
 * A term's file, `terms/<id>.yaml`: one concept, the words everyone must
 * use for it and the ones they must not, per language. Strict: an ID (the
 * file name), a status, an optional domain, an optional replacement (a
 * deprecated term's successor) and, per configured language, the preferred
 * variant, allowed and forbidden variants (each with an optional note), a
 * definition (inline content: text with marks, as AsciiDoc inline markup
 * in the file) and a usage note.
 */
export const TERM_SCHEMA_VERSION = 1;

/** Whether `id` is a term's ID (`TermId`). */
export function isTermId(id: unknown): id is string {
  return TermId.safeParse(id).success;
}

/** A language as a term's key: a language tag in its canonical case. */
const TermLanguageKey = z
  .string()
  .max(35)
  .refine(
    (tag) => LanguageTag.safeParse(tag).data === tag,
    'a language tag in its canonical case, e.g. "en" or "pt-BR"',
  );

/** Text of up to `max` characters, no control characters but line breaks and tabs. */
const Text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^(?:[^\p{Cc}]|[\n\t])*$/u, 'no control characters');

/** One line of up to `max` characters, no control characters at all. */
const Line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, 'one line, no control characters');

/** The most characters of text a definition holds. */
export const MAX_DEFINITION_LENGTH = 10_000;

/**
 * A definition: text runs with the editor's inline marks (strong,
 * emphasis, code, sub, sup, UI label, link) and line breaks; no
 * attributes, cross-references or keys, which depend on a manual, and no
 * term links (a definition is shown in a term link's popover). At most
 * `MAX_DEFINITION_LENGTH` characters of text, no control characters.
 */
export const TermDefinition = z
  .array(z.discriminatedUnion('type', [TextNode, HardBreak]))
  .min(1)
  .max(1000)
  .refine(
    (nodes) =>
      nodes.every(
        (node) => node.type !== 'text' || /^[^\p{Cc}]*$/u.test(node.text),
      ),
    'no control characters',
  )
  .refine(
    (nodes) =>
      nodes.every(
        (node) =>
          node.type !== 'text' || !node.marks?.some((m) => m.type === 'term'),
      ),
    'no term links: a definition is shown where a term link is',
  )
  .refine(
    (nodes) =>
      nodes.reduce(
        (length, node) =>
          length + (node.type === 'text' ? node.text.length : 1),
        0,
      ) <= MAX_DEFINITION_LENGTH,
    `at most ${MAX_DEFINITION_LENGTH} characters`,
  )
  .meta({ id: 'TermDefinition' });
export type TermDefinition = z.output<typeof TermDefinition>;

const Variant = z
  .strictObject({
    term: Line(200),
    note: Text(1000).optional(),
  })
  .meta({ id: 'TermVariant' });
export type TermVariant = z.output<typeof Variant>;

export const TermLanguage = z
  .strictObject({
    preferred: Line(200),
    allowed: z.array(Variant).max(50).default([]),
    forbidden: z.array(Variant).max(50).default([]),
    definition: TermDefinition.optional(),
    usage: Text(10_000).optional(),
  })
  .meta({ id: 'TermLanguage' });
export type TermLanguage = z.output<typeof TermLanguage>;

/** The most languages one term holds. */
export const MAX_TERM_LANGUAGES = 100;

export const TERM_STATUSES = ['proposed', 'approved', 'deprecated'] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

export const Term = z
  .strictObject({
    schemaVersion: z.literal(TERM_SCHEMA_VERSION),
    id: TermId,
    status: z.enum(TERM_STATUSES).default('proposed'),
    domain: Line(100).optional(),
    /** The term to use instead of this deprecated one. */
    replacedBy: TermId.optional(),
    languages: z
      .record(TermLanguageKey, TermLanguage)
      .refine(
        (langs) => Object.keys(langs).length >= 1,
        'at least one language',
      )
      .refine(
        (langs) => Object.keys(langs).length <= MAX_TERM_LANGUAGES,
        `at most ${MAX_TERM_LANGUAGES} languages`,
      ),
  })
  .refine(
    (term) => term.replacedBy === undefined || term.status === 'deprecated',
    {
      message: 'only a deprecated term is replaced by another',
      path: ['replacedBy'],
    },
  )
  .refine((term) => term.replacedBy !== term.id, {
    message: 'a term cannot replace itself',
    path: ['replacedBy'],
  })
  .meta({ id: 'Term' });
export type Term = z.output<typeof Term>;

export class TermParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TermParseError';
  }
}

/**
 * The file's definitions (AsciiDoc inline markup) read as inline content,
 * in place; a definition that is no inline markup throws.
 */
function readDefinitions(data: Record<string, unknown>): void {
  const languages = data['languages'];
  if (typeof languages !== 'object' || languages === null) return;
  for (const [lang, entry] of Object.entries(languages)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const definition = (entry as Record<string, unknown>)['definition'];
    if (typeof definition !== 'string') continue;
    // Markup aside, never more than the text a definition may hold: refused unparsed.
    if (definition.length > 2 * MAX_DEFINITION_LENGTH) {
      throw new TermParseError(
        `invalid term: languages.${lang}.definition: at most ${MAX_DEFINITION_LENGTH} characters`,
      );
    }
    try {
      (entry as Record<string, unknown>)['definition'] =
        parseInline(definition);
    } catch (e) {
      if (!(e instanceof AsciidocParseError)) throw e;
      throw new TermParseError(
        `invalid term: languages.${lang}.definition: ${e.message}`,
      );
    }
  }
}

/** A term's file as `Term`; the ID is the file name's. */
export function parseTerm(source: string, options: { id: string }): Term {
  let data: unknown;
  try {
    data = parseYaml(source, { maxAliasCount: 0 });
  } catch (e) {
    throw new TermParseError(`invalid YAML: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TermParseError('a term must be a YAML mapping');
  }
  // The ID is the file name's; a file naming another is no term of it.
  if ('id' in data && (data as { id: unknown }).id !== options.id) {
    throw new TermParseError(
      `the file names the term "${String((data as { id: unknown }).id)}", not "${options.id}"`,
    );
  }
  readDefinitions(data as Record<string, unknown>);
  const result = Term.safeParse({ ...data, id: options.id });
  if (!result.success) {
    throw new TermParseError(
      `invalid term: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

/** A definition as the file holds it: AsciiDoc inline markup. */
export function printDefinition(definition: TermDefinition): string {
  return printInline(normalizeInline(definition as Inline[]), false);
}

/**
 * A term as canonical YAML: fixed key order, languages sorted, empty lists
 * and the ID (the file name) left out, definitions as AsciiDoc inline markup.
 */
export function printTerm(term: Term): string {
  const variants = (list: readonly TermVariant[]) =>
    list.map((v) => ({ term: v.term, ...(v.note && { note: v.note }) }));
  const doc: Record<string, unknown> = {
    schemaVersion: TERM_SCHEMA_VERSION,
    status: term.status,
    ...(term.domain !== undefined && { domain: term.domain }),
    ...(term.replacedBy !== undefined && { replacedBy: term.replacedBy }),
    languages: Object.fromEntries(
      termLanguages(term).map((lang) => {
        const entry = term.languages[lang] as TermLanguage;
        return [
          lang,
          {
            preferred: entry.preferred,
            ...(entry.allowed.length > 0 && {
              allowed: variants(entry.allowed),
            }),
            ...(entry.forbidden.length > 0 && {
              forbidden: variants(entry.forbidden),
            }),
            ...(entry.definition !== undefined && {
              definition: printDefinition(entry.definition),
            }),
            ...(entry.usage !== undefined && { usage: entry.usage }),
          },
        ];
      }),
    ),
  };
  return stringify(doc, { lineWidth: 0 });
}

/** The languages a term holds, sorted. */
export function termLanguages(term: Term): string[] {
  return Object.keys(term.languages).sort();
}

/** A definition as plain text: its text runs, a line break as a space. */
export function definitionText(definition: TermDefinition | undefined): string {
  return (definition ?? [])
    .map((node) => (node.type === 'text' ? node.text : ' '))
    .join('');
}

/** Every variant of a term in one language: the preferred, the allowed, the forbidden. */
export function termVariants(entry: TermLanguage): string[] {
  return [
    entry.preferred,
    ...entry.allowed.map((v) => v.term),
    ...entry.forbidden.map((v) => v.term),
  ];
}

/**
 * Whether a term matches `query` in one of `langs` (every language it
 * holds when `langs` is undefined): the query, folded as search folds it
 * (`foldText`: case, diacritics and runs of white space aside) and
 * trimmed, is part of one of its variants or of its definition. An empty
 * query matches nothing.
 */
export function termMatches(
  term: Term,
  query: string,
  langs?: readonly string[],
): boolean {
  const folded = foldText(query).trim();
  if (folded === '') return false;
  return termLanguages(term)
    .filter((lang) => langs === undefined || langs.includes(lang))
    .some((lang) => {
      const entry = term.languages[lang] as TermLanguage;
      return [...termVariants(entry), definitionText(entry.definition)].some(
        (text) => foldText(text).includes(folded),
      );
    });
}

/**
 * The term checked against the configuration: every language it holds is
 * configured. (Whether `replacedBy` names a term is a question for the
 * repository, not for one file.)
 */
export function validateTerm(term: Term, config: ProjectConfig): Issue[] {
  const configured = new Set([
    config.languages.source,
    ...config.languages.targets,
  ]);
  return termLanguages(term).flatMap((lang) =>
    configured.has(lang)
      ? []
      : [
          {
            severity: 'error' as const,
            code: 'unknown-language' as const,
            message: `language "${lang}" is neither the source nor a target language`,
            at: lang,
          },
        ],
  );
}
