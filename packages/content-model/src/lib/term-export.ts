import {
  definitionText,
  type Term,
  type TermLanguage,
  termLanguages,
} from './term.js';

/**
 * Terms written out for other tools: TBX-Basic (ISO 30042:2019, the
 * TBX-Basic dialect in its DCA style) and CSV. Both read only the terms
 * given, in the order given, and only the languages asked for.
 */
export interface TermExportOptions {
  /** Only these languages (every language a term holds when undefined); a term holding none of them is left out. */
  readonly langs?: readonly string[] | undefined;
  /** The file's main language (TBX `xml:lang` of the root), usually the source language. */
  readonly sourceLang: string;
}

/** The TBX namespace of ISO 30042:2019. */
export const TBX_NAMESPACE = 'urn:iso:std:iso:30042:ed-2';

/** The `id` a term's concept entry has in TBX: an XML ID, which a term ID (it may start with a digit) is not always. */
export function tbxConceptId(termId: string): string {
  return `term-${termId}`;
}

/** Characters XML 1.0 cannot hold: control characters but tab and line breaks, U+FFFE, U+FFFF. */
// eslint-disable-next-line no-control-regex
const NOT_IN_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * Characters XML 1.0 cannot hold (control characters but tab and line
 * breaks, lone surrogates, U+FFFE and U+FFFF) become U+FFFD; the five
 * special characters become references. The result is safe as element text
 * and inside a double-quoted attribute.
 */
export function escapeXml(text: string): string {
  return (
    text
      // Lone surrogates (half a pair) are no characters.
      .replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        '\uFFFD',
      )
      .replace(NOT_IN_XML, '\uFFFD')
      .replace(
        /[&<>"']/g,
        (c: string) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&apos;',
          })[c] as string,
      )
  );
}

/** The languages of `term` to write, sorted. */
function exportedLangs(
  term: Term,
  langs: readonly string[] | undefined,
): string[] {
  return termLanguages(term).filter(
    (lang) => langs === undefined || langs.includes(lang),
  );
}

type AdministrativeStatus =
  | 'preferredTerm-admn-sts'
  | 'admittedTerm-admn-sts'
  | 'deprecatedTerm-admn-sts'
  | 'supersededTerm-admn-sts';

/**
 * TBX-Basic: one `conceptEntry` per term (its `id` from `tbxConceptId`),
 * the domain as `subjectField`, a deprecated term's replacement as a
 * `crossReference` (only when that term is exported too, so every target
 * is an ID of the file), one `langSec` per language with the definition
 * (as plain text) and the usage note (`note`), and one `termSec` per
 * variant with its `administrativeStatus`: the preferred variant
 * `preferredTerm`, allowed ones `admittedTerm`, forbidden ones
 * `deprecatedTerm`; a deprecated concept's preferred and allowed variants
 * are `supersededTerm`. A variant's note is its `termSec`'s `note`. The
 * concept's own status beyond that has no TBX-Basic data category and is
 * left out (the CSV has it).
 */
export function termsToTbx(
  terms: readonly Term[],
  options: TermExportOptions,
): string {
  const entries = terms.filter(
    (term) => exportedLangs(term, options.langs).length > 0,
  );
  const exported = new Set(entries.map((term) => term.id));
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tbx type="TBX-Basic" style="dca" xml:lang="${escapeXml(options.sourceLang)}" xmlns="${TBX_NAMESPACE}">`,
    '  <tbxHeader>',
    '    <fileDesc>',
    '      <sourceDesc>',
    '        <p>Terminology exported from the content repository.</p>',
    '      </sourceDesc>',
    '    </fileDesc>',
    '  </tbxHeader>',
    '  <text>',
    '    <body>',
  ];
  const element = (indent: number, xml: string) =>
    lines.push(`${' '.repeat(indent)}${xml}`);
  const termSec = (
    term: string,
    status: AdministrativeStatus,
    note: string | undefined,
  ) => {
    element(10, '<termSec>');
    element(12, `<term>${escapeXml(term)}</term>`);
    element(12, `<termNote type="administrativeStatus">${status}</termNote>`);
    if (note !== undefined) element(12, `<note>${escapeXml(note)}</note>`);
    element(10, '</termSec>');
  };

  for (const term of entries) {
    const deprecated = term.status === 'deprecated';
    element(6, `<conceptEntry id="${escapeXml(tbxConceptId(term.id))}">`);
    if (term.domain !== undefined) {
      element(
        8,
        `<descrip type="subjectField">${escapeXml(term.domain)}</descrip>`,
      );
    }
    if (term.replacedBy !== undefined && exported.has(term.replacedBy)) {
      element(
        8,
        `<ref type="crossReference" target="${escapeXml(tbxConceptId(term.replacedBy))}">${escapeXml(term.replacedBy)}</ref>`,
      );
    }
    for (const lang of exportedLangs(term, options.langs)) {
      const entry = term.languages[lang] as TermLanguage;
      element(8, `<langSec xml:lang="${escapeXml(lang)}">`);
      const definition = definitionText(entry.definition);
      if (definition !== '') {
        element(
          10,
          `<descrip type="definition">${escapeXml(definition)}</descrip>`,
        );
      }
      if (entry.usage !== undefined) {
        element(10, `<note>${escapeXml(entry.usage)}</note>`);
      }
      termSec(
        entry.preferred,
        deprecated ? 'supersededTerm-admn-sts' : 'preferredTerm-admn-sts',
        undefined,
      );
      for (const variant of entry.allowed) {
        termSec(
          variant.term,
          deprecated ? 'supersededTerm-admn-sts' : 'admittedTerm-admn-sts',
          variant.note,
        );
      }
      for (const variant of entry.forbidden) {
        termSec(variant.term, 'deprecatedTerm-admn-sts', variant.note);
      }
      element(8, '</langSec>');
    }
    element(6, '</conceptEntry>');
  }
  lines.push('    </body>', '  </text>', '</tbx>', '');
  return lines.join('\n');
}

/** The CSV's columns, in order; its first row names them. */
export const TERM_CSV_COLUMNS = [
  'id',
  'lang',
  'status',
  'domain',
  'replacedBy',
  'preferred',
  'allowed',
  'forbidden',
  'definition',
  'usage',
] as const;

/**
 * A value a spreadsheet may run as a formula: its first character other
 * than whitespace (`\s`, which includes no-break spaces and the BOM) and
 * zero-width characters (U+200B to U+200D, U+2060) is `=`, `+`, `-` or
 * `@`, in ASCII, full width (U+FF1D, U+FF0B, U+FF0D, U+FF20) or small form
 * (U+FE66, U+FE62, U+FE63, U+FE6B), or it starts with a tab or a carriage
 * return.
 */
const FORMULA_START =
  /^(?:[\t\r]|[\s\u200B-\u200D\u2060]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20\uFE66\uFE62\uFE63\uFE6B])/u;

/**
 * A CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line
 * break, and also a semicolon or a tab, so it stays one cell where a
 * spreadsheet splits on those (Excel in many locales splits on `;`). A
 * value a spreadsheet would run as a formula (`FORMULA_START`) gets a
 * leading `'`, so opening the file never runs anything. A negative number
 * gets one too, so it reads as text (`'-5`): no cell is let through by its
 * shape.
 */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",;\t\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * CSV: a header row (`TERM_CSV_COLUMNS`), then one row per term and
 * language, lines ending in CRLF. Allowed and forbidden variants are one
 * cell each, one variant per line (a variant is one line, so the list
 * reads back unambiguously); their notes are left out (TBX has them). The
 * definition is plain text.
 */
export function termsToCsv(
  terms: readonly Term[],
  options: Pick<TermExportOptions, 'langs'>,
): string {
  const rows: string[][] = [[...TERM_CSV_COLUMNS]];
  for (const term of terms) {
    for (const lang of exportedLangs(term, options.langs)) {
      const entry = term.languages[lang] as TermLanguage;
      rows.push([
        term.id,
        lang,
        term.status,
        term.domain ?? '',
        term.replacedBy ?? '',
        entry.preferred,
        entry.allowed.map((v) => v.term).join('\n'),
        entry.forbidden.map((v) => v.term).join('\n'),
        definitionText(entry.definition),
        entry.usage ?? '',
      ]);
    }
  }
  return rows.map((row) => `${row.map(csvCell).join(',')}\r\n`).join('');
}
