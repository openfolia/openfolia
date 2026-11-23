import { OWN_NAMESPACE, CodeIds, inlineContent } from './inline.js';
import type { XliffUnit } from './units.js';
import { attributes, plainText } from './xml.js';

/** XLIFF 2.0's namespace. */
export const XLIFF_NAMESPACE = 'urn:oasis:names:tc:xliff:document:2.0';

/** The media type of an XLIFF document (RFC 3023 style, as registered by OASIS). */
export const XLIFF_MEDIA_TYPE = 'application/xliff+xml';

/** One module's units, a `<file>` of the document. */
export interface XliffModule {
  readonly moduleId: string;
  /** The module's title in the source language, for the translator. */
  readonly title: string;
  /** The source file's path in the repository, as the `<file>`'s `original`. */
  readonly original?: string;
  /** Never empty; in document order. */
  readonly units: readonly XliffUnit[];
}

export interface XliffDocument {
  /** The source language (a BCP 47 tag). */
  readonly srcLang: string;
  /** The target language. */
  readonly trgLang: string;
  /**
   * The source and target text's directions (#458), as each `<file>`'s `srcDir` and `trgDir`
   * (XLIFF 2.0: `ltr`, `rtl`; left out, a tool reads `auto`).
   */
  readonly srcDir?: 'ltr' | 'rtl';
  readonly trgDir?: 'ltr' | 'rtl';
  /** What the document was made for, as `ccms:` attributes of `<xliff>` (e.g. a job ID and a commit). */
  readonly meta?: Readonly<Record<string, string>>;
  /** Never empty: XLIFF needs at least one `<file>`. */
  readonly modules: readonly XliffModule[];
}

/** Thrown for a document XLIFF cannot express: no modules, a module without units, a malformed key. */
export class XliffWriteError extends Error {
  override readonly name = 'XliffWriteError';
}

/** A direction XLIFF takes, or undefined (left out) for anything else. */
function direction(dir: unknown): 'ltr' | 'rtl' | undefined {
  return dir === 'ltr' || dir === 'rtl' ? dir : undefined;
}

/** An XML name without a prefix (the local part of a `ccms:` attribute). */
const NC_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * An XLIFF 2.0 document (core only) for translating `doc.modules` from
 * `srcLang` into `trgLang`:
 *
 * - one `<file id="<moduleId>">` per module, its `original` the source
 *   path;
 * - one `<unit id="<blockId>">` per unit, with `ccms:sourceHash` (what
 *   the translation will be made from, for the import) and `ccms:kind`
 *   (and, for a callout's legend, `ccms:image`: the image block holding it),
 *   `canResegment="no"` and `xml:space="preserve"` (spaces at the edges
 *   of a run are text), and notes naming the module's title
 *   (`category="ccms:module"`) and the unit's path (`ccms:path`);
 * - one `<segment id="<field>">` per part of the unit (a paragraph's
 *   `content`; an image's `alt` and `title`; …), each with its
 *   `<source>`; no `<target>` (no previous translation is sent).
 *
 * Inline content is written by `inlineContent`. Everything from the
 * content is escaped; a code point XML cannot carry is a `<cp>` in text
 * and U+FFFD elsewhere. The output is UTF-8 text with an XML declaration
 * and no DOCTYPE.
 */
export function writeXliff(doc: XliffDocument): string {
  if (doc.modules.length === 0) {
    throw new XliffWriteError('An XLIFF document needs at least one module.');
  }
  const meta = Object.entries(doc.meta ?? {}).map(([key, value]) => {
    if (!NC_NAME.test(key)) {
      throw new XliffWriteError(`"${key}" is no XML name.`);
    }
    return [`ccms:${key}`, value] as const;
  });
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff${attributes([
      ['xmlns', XLIFF_NAMESPACE],
      ['xmlns:ccms', OWN_NAMESPACE],
      ['version', '2.0'],
      ['srcLang', doc.srcLang],
      ['trgLang', doc.trgLang],
      ...meta,
    ])}>`,
  ];
  for (const module of doc.modules) {
    if (module.units.length === 0) {
      throw new XliffWriteError(
        `The module "${module.moduleId}" has no units.`,
      );
    }
    out.push(
      `  <file${attributes([
        ['id', module.moduleId],
        ['original', module.original],
        ['srcDir', direction(doc.srcDir)],
        ['trgDir', direction(doc.trgDir)],
      ])}>`,
    );
    for (const unit of module.units) {
      const ids = new CodeIds();
      out.push(
        `    <unit${attributes([
          ['id', unit.blockId],
          ['canResegment', 'no'],
          ['xml:space', 'preserve'],
          ['ccms:sourceHash', unit.sourceHash],
          ['ccms:kind', unit.kind],
          ['ccms:image', unit.image],
        ])}>`,
        '      <notes>',
        `        <note category="ccms:module">${plainText(module.title)}</note>`,
        `        <note category="ccms:path">${plainText(unit.path.join(' > '))}</note>`,
        '      </notes>',
      );
      for (const part of unit.parts) {
        out.push(
          `      <segment${attributes([['id', part.field]])}>`,
          `        <source>${inlineContent(part.content, ids)}</source>`,
          '      </segment>',
        );
      }
      out.push('    </unit>');
    }
    out.push('  </file>');
  }
  out.push('</xliff>', '');
  return out.join('\n');
}
