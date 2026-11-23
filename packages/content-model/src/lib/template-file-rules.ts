/**
 * The files of an organisation's own Typst template (#396) that are edited as text in a change
 * set: what a file's path in its template folder may be, which files are text, and how large one
 * may be. Schema-free, for the editor (`@openfolia/content-model/core`) and the API alike; the
 * full entry's `DesignTemplateFilePath` is the schema.
 */

/** The text files a template folder's editor opens: Typst sources and the data they read. */
export const TEMPLATE_TEXT_EXTENSIONS = [
  'typ',
  'yaml',
  'yml',
  'json',
  'toml',
  'csv',
  'txt',
  'xml',
  'svg',
  'bib',
] as const;
export type TemplateTextExtension = (typeof TEMPLATE_TEXT_EXTENSIONS)[number];

/** The most bytes (UTF-8) one template file edited as text may hold. */
export const MAX_TEMPLATE_FILE_BYTES = 256 * 1024;

/** The longest path of a file in its template folder, in characters. */
export const MAX_TEMPLATE_FILE_PATH = 150;

/** The most folders deep a file in a template folder sits (its name included). */
export const MAX_TEMPLATE_FILE_DEPTH = 8;

/**
 * One name in a template file's path: letters, digits, `_`, `-` and `.`, never starting with a
 * `.` (so never `.`, `..` or a hidden file), at most 100 characters.
 */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/**
 * Whether `path` is a file's path in its template folder (`manual.typ`, `parts/notice.typ`) as a
 * change set may write it: names joined by `/` (`SEGMENT`), at most `MAX_TEMPLATE_FILE_DEPTH`
 * deep and `MAX_TEMPLATE_FILE_PATH` long, never absolute and never leaving the folder.
 */
export function isTemplateFilePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_TEMPLATE_FILE_PATH) return false;
  const names = path.split('/');
  return (
    names.length <= MAX_TEMPLATE_FILE_DEPTH &&
    names.every((name) => SEGMENT.test(name))
  );
}

/** Whether a template file is edited as text: its extension is one of `TEMPLATE_TEXT_EXTENSIONS`. */
export function isTemplateTextFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return false;
  const extension = path.slice(dot + 1).toLowerCase();
  return (TEMPLATE_TEXT_EXTENSIONS as readonly string[]).includes(extension);
}

/** The bytes `text` takes as UTF-8. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
