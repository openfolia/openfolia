import { z } from 'zod';
import {
  CONFIG_KEY_PATTERN,
  MAX_CONFIG_KEY_LENGTH,
} from './condition-check.js';

/**
 * Block IDs are written into AsciiDoc as `[#id]`, so they follow AsciiDoc's
 * ID rules (start with a letter or underscore) and stay lowercase for
 * readable diffs. They never change once assigned: translations, comments,
 * RAG chunks and import traceability all hang on them.
 */
export const BlockId = z
  .string()
  .max(64)
  .regex(
    /^[a-z_][a-z0-9_-]*$/,
    'lowercase letters, digits, "_" and "-", starting with a letter or "_"',
  );
export type BlockId = z.infer<typeof BlockId>;

/** Module IDs double as file names, so they are slugs. */
export const ModuleId = z
  .string()
  .max(100)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'lowercase slug, e.g. "battery-charging"',
  );
export type ModuleId = z.infer<typeof ModuleId>;

/**
 * IDs no term may take: `export` is a route of its own next to the terms'
 * (`/terms/export`), so a term of that name could never be read by ID.
 */
export const RESERVED_TERM_IDS: readonly string[] = ['export'];

/** A term's ID, as its file name gives it: a module ID's format, the reserved IDs aside. */
export const TermId = ModuleId.refine(
  (id) => !RESERVED_TERM_IDS.includes(id),
  `reserved: ${RESERVED_TERM_IDS.map((id) => `"${id}"`).join(', ')}`,
);

/** Images and other binaries are content-addressed, so a release tag pins the exact file. */
export const AssetRef = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'sha256:<64 hex chars>');
export type AssetRef = z.infer<typeof AssetRef>;

/**
 * A media type as the blob store keeps it: lowercase `type/subtype`
 * without parameters, e.g. `application/zip`.
 */
export const MediaType = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/,
    'a lowercase media type, e.g. "application/zip"',
  );
export type MediaType = z.infer<typeof MediaType>;

/** The longest file name, in UTF-16 code units (as most file systems allow 255). */
export const MAX_FILE_NAME_LENGTH = 255;

/**
 * Characters no file name holds: path separators, what Windows refuses,
 * control characters, line and paragraph separators, invisible format
 * characters (the direction marks and overrides that make
 * `evil\u202Egpj.exe` read as `evilexe.jpg`, zero-width spaces and joiners,
 * a byte order mark: Unicode's `Cf`) and lone surrogates (no UTF-8 holds
 * them; with the `u` flag a surrogate range matches only an unpaired one).
 */
const FILE_NAME_FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- control characters are what it finds
  /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]|[\ud800-\udfff]/gu;

/**
 * A file name a download is saved under, e.g. `config-v2.zip`: one name,
 * never a path. 1 to 255 characters, none of `< > : " / \\ | ? *`, no
 * control characters or direction marks, no leading or trailing
 * whitespace, no trailing dot; stored in NFC.
 */
export const FileName = z
  .string()
  .min(1)
  .max(MAX_FILE_NAME_LENGTH)
  .refine(
    (name) => toFileName(name) === name,
    'a file name without path separators, control characters or < > : " | ? *, and no leading or trailing space or trailing dot',
  );
export type FileName = z.infer<typeof FileName>;

/**
 * The file name to keep for `raw` (an uploaded file's name as the client
 * sent it): its last path segment, in NFC, with every forbidden character
 * as `_`, runs of whitespace as one space, without leading or trailing
 * whitespace or trailing dots, and cut to `MAX_FILE_NAME_LENGTH` keeping
 * its extension. `undefined` when nothing is left. A valid `FileName`
 * comes back unchanged.
 */
export function toFileName(raw: string): string | undefined {
  const segment = raw.normalize('NFC').split(/[/\\]/u).pop() ?? '';
  let name = segment
    .replace(FILE_NAME_FORBIDDEN, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '');
  if (name.length > MAX_FILE_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    const base = cutAt(
      name.slice(0, name.length - extension.length),
      MAX_FILE_NAME_LENGTH - extension.length,
    );
    // Without its extension, the cut may end in a dot as well as a space.
    name = extension ? base.trimEnd() + extension : base.replace(/[. ]+$/u, '');
  }
  return /[^. ]/u.test(name) ? name : undefined;
}

/** The first `length` code units of `text`, never splitting a surrogate pair. */
function cutAt(text: string, length: number): string {
  const cut = text.slice(0, length);
  return /[\ud800-\udbff]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

/** IDs of configured things (module types, audiences, facets, variant attributes, symbols). */
export const ConfigKey = z
  .string()
  .max(MAX_CONFIG_KEY_LENGTH)
  .regex(CONFIG_KEY_PATTERN, 'lowercase key, e.g. "product-line"');
export type ConfigKey = z.infer<typeof ConfigKey>;

/**
 * A one-line string without leading or trailing whitespace: titles, alt
 * texts, source references. Stored as single AsciiDoc lines, so they
 * can't hold line breaks.
 */
export const SingleLine = z
  .string()
  .min(1)
  .regex(/^\S(?:[^\n\r]*\S)?$/, 'one line, no leading or trailing whitespace');

/**
 * BCP 47 language tag, stored in canonical case ("pt-BR", "zh-Hans"), so
 * "pt-br" and "pt-BR" are the same language everywhere.
 */
export const LanguageTag = z
  .string()
  .regex(
    /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
    'BCP 47 tag, e.g. "en" or "pt-BR"',
  )
  .refine(
    (tag) => canonicalLanguage(tag) !== undefined,
    'not a valid BCP 47 tag',
  )
  .overwrite((tag) => canonicalLanguage(tag) ?? tag);

function canonicalLanguage(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}
export type LanguageTag = z.infer<typeof LanguageTag>;
