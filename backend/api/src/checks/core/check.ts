import type {
  ContentSubject,
  LockSubject,
} from '../../change-sets/core/lock.js';
import { bySubjectKey } from '../../change-sets/core/commit.js';

/** Whether a problem holds up review and release, or only asks for a look. */
export const CHECK_SEVERITIES = ['blocking', 'warning'] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

/** What kind of problem it is, for grouping and filtering. */
export const CHECK_CATEGORIES = [
  'validation',
  'reference',
  'image',
  'attachment',
  'translation',
  'writing',
] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

interface CodeRule {
  readonly severity: CheckSeverity;
  readonly category: CheckCategory;
  /** What it means, for the API reference. */
  readonly description: string;
}

/**
 * Every check code with its severity and category: the one place they are
 * decided (the README's table and the API reference are made from it). A
 * code is stable; its severity is fixed here, never taken from where the
 * problem was found.
 */
export const CHECK_CODES = {
  'invalid-module': {
    severity: 'blocking',
    category: 'validation',
    description: 'A module file cannot be read.',
  },
  'invalid-manifest': {
    severity: 'blocking',
    category: 'validation',
    description: 'The manual’s manifest cannot be read.',
  },
  'unknown-module-type': {
    severity: 'blocking',
    category: 'validation',
    description: 'The module’s type is not configured.',
  },
  'unknown-audience': {
    severity: 'blocking',
    category: 'validation',
    description:
      'The module’s or manual’s audience is not configured (a module with one is left out of every manual).',
  },
  'unknown-language': {
    severity: 'blocking',
    category: 'validation',
    description: 'The module’s language is neither the source nor a target.',
  },
  'unknown-facet': {
    severity: 'blocking',
    category: 'validation',
    description: 'The module names a facet that is not configured.',
  },
  'unknown-facet-value': {
    severity: 'blocking',
    category: 'validation',
    description: 'The module names a value its facet does not have.',
  },
  'unknown-safety-symbol': {
    severity: 'blocking',
    category: 'validation',
    description: 'A safety block uses a symbol that is not configured.',
  },
  'unknown-text-attribute': {
    severity: 'blocking',
    category: 'validation',
    description: 'A text attribute is not configured.',
  },
  'placeholder-in-module': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A module holds a page design placeholder (`placeholder:<key>[]`), which only a design’s regions, header and footer may hold.',
  },
  'unknown-placeholder': {
    severity: 'blocking',
    category: 'validation',
    description: 'A placeholder names no known value.',
  },
  'unknown-variant-attribute': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A condition or variant names an attribute that is not configured.',
  },
  'unknown-variant-value': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A condition or variant names a value its attribute does not have.',
  },
  'version-compare-on-enum': {
    severity: 'blocking',
    category: 'validation',
    description: 'A condition compares an attribute that is not a version.',
  },
  'invalid-version-value': {
    severity: 'blocking',
    category: 'validation',
    description: 'A version attribute’s value is not a version.',
  },
  'missing-variant-attribute': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A published variant does not set an attribute a condition tests: the content under it is left out.',
  },
  'missing-text-attribute': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A published variant has no value for a text attribute the content uses.',
  },
  'pdf-accessibility': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A variant’s PDF in a language cannot meet PDF/UA-1, the configured PDF standard (`params.problem` says why): the PDF route refuses it.',
  },
  'pdf-not-checked': {
    severity: 'warning',
    category: 'validation',
    description:
      'A variant’s PDF in a language could not be rendered (too slow, or a template that does not compile), so PDF/UA-1 was not checked: the PDF route says why.',
  },
  'pdf-layout-not-checked': {
    severity: 'warning',
    category: 'validation',
    description:
      'With `pdf.standard` `none`, a variant’s PDF in a language with a page design (or a callout legend beside its image) could not be rendered (too slow, or a template that does not compile; `params.reason`), so what its layout cannot fit was not checked: the PDF route says why.',
  },
  'page-design-missing-value': {
    severity: 'warning',
    category: 'validation',
    description:
      'A placeholder or title page field of the manual’s page design has no value for the manual and variant (`params.design`, `params.at`, `params.name` the placeholder or field): a placeholder stays one, a field is left out. The release and the date are not reported, as a manual’s checks never know them.',
  },
  'page-design-missing-text-attribute': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A text of the manual’s page design uses a text attribute the variant has no value for (`params.design`, `params.at`, `params.name` the attribute).',
  },
  'page-design-missing-variant-attribute': {
    severity: 'blocking',
    category: 'validation',
    description:
      'A condition in the manual’s page design tests an attribute the variant does not set (`params.design`, `params.at`, `params.name` the attribute): what it holds is left out.',
  },
  'page-design-overflow': {
    severity: 'warning',
    category: 'validation',
    description:
      'A region of the manual’s page design does not fit its place on the title or back page in a variant’s PDF (`params.at`, e.g. `regions.footer`): the PDF cuts it off.',
  },
  'running-head-truncated': {
    severity: 'warning',
    category: 'validation',
    description:
      'A running header or footer of the manual’s page design does not fit on one line even at its smallest size (`params.at`, e.g. `header.default.right`; `params.text`, the whole text): the PDF shortens it with an ellipsis.',
  },
  'callout-label-overflow': {
    severity: 'warning',
    category: 'validation',
    description:
      'A callout’s legend beside its image does not fit the image’s height in a variant’s PDF, even at the smallest size (`pdf.calloutLabelMinSize`): the PDF cuts it off (`params.module`, `params.image`, `params.callout`; `params.at`, `callouts.<module>.<image>.<callout>`).',
  },
  'safety-message-split': {
    severity: 'warning',
    category: 'validation',
    description:
      'A safety message is taller than a whole page of the manual’s page design in a variant’s PDF, so it cannot be kept on one page: the PDF breaks it across pages (`params.module`, `params.block`, `params.text` its hazard; `params.at`, `safety.<module>.<block>`). Shorten it or split it into several messages.',
  },
  passthrough: {
    severity: 'warning',
    category: 'validation',
    description: 'Content kept verbatim from an import: convert it to blocks.',
  },
  'empty-table': {
    severity: 'warning',
    category: 'validation',
    description: 'Every cell of a table is empty.',
  },
  'snippet-too-large': {
    severity: 'warning',
    category: 'validation',
    description:
      'A snippet holds a section or a module reference: snippets are one or a few blocks of text.',
  },
  'inconsistent-variants': {
    severity: 'warning',
    category: 'validation',
    description: 'The manual’s variants set different attributes.',
  },
  'above-audience': {
    severity: 'warning',
    category: 'validation',
    description: 'A module above the manual’s audience is left out of it.',
  },
  'delivery-access-capped': {
    severity: 'warning',
    category: 'validation',
    description:
      'The project’s `delivery.access` (`params.access`) opens the stable addresses further than this deployment allows (`CCMS_DELIVERY_MAX_ACCESS`, `params.maxAccess`): they are served at that instead.',
  },
  'missing-manufacturer': {
    severity: 'warning',
    category: 'validation',
    description:
      'The project has no manufacturer details (`manufacturer`) and turns this check on (`release.checkManufacturer`, #395): the manual would be released without its imprint, the manufacturer’s name, address and contact.',
  },
  'missing-module': {
    severity: 'blocking',
    category: 'reference',
    description:
      'The manual, or a module reference block, names a module that does not exist.',
  },
  'module-cycle': {
    severity: 'blocking',
    category: 'reference',
    description: 'Module references form a cycle.',
  },
  'module-ref-unknown-block': {
    severity: 'blocking',
    category: 'reference',
    description:
      'A module reference to one block of a module (#223) names a block that module does not have (`params.module`, `params.block`): nothing is included in its place.',
  },
  'expansion-too-large': {
    severity: 'blocking',
    category: 'reference',
    description:
      'Too large once its module references are included: more than `MAX_EXPANDED_NODES` (500,000) content nodes, `MAX_EXPANDED_CHARS` (12,000,000) characters or `MAX_EXPANDED_TABLE_CELLS` (1,000,000) table cells (rows × columns) (a module referred to over several paths counts once per path), or blocks and references nested more than `MAX_NESTING_DEPTH` (100) deep; the message says which. At a manual, for a variant in a language: nothing of it is resolved, so its resolution, PDF, pages and previews are 422 `expansion-too-large`, and its PDF is not checked. At a module (#688), its retrieval chunks (every variant block kept, its FAQ entries counted with it): `GET /chunks` leaves the module out and names it in `meta.leftOut`; `params.reason` is `size` or `depth`.',
  },
  'chunk-set-too-large': {
    severity: 'blocking',
    category: 'reference',
    description:
      'At a change set’s head, the retrieval chunks of the whole commit, as the reader sees it, are too large together (#710): many modules each include a lot, past four times the content they are made from plus room for 32 modules at the limits of one (`MAX_CHUNK_SET_FACTOR`, `CHUNK_SET_MODULES_AT_LIMITS`; of the text they keep, room for 8). Once released, `GET /chunks` refuses that commit (422 `chunk-set-too-large`) and the change feed tells none of its chunks. One check at each of the modules that expanded the most (`meta.largest` of that error, at most five, only modules the reader may see), `params.chars` and `params.nodes` what its chunks expanded to; `params.kept` `true` when the room for the text kept was the one passed.',
  },
  'chunks-not-checked': {
    severity: 'warning',
    category: 'reference',
    description:
      'Cutting the retrieval chunks of the modules a checks run checks took more than its budget (#711: four times their content plus room for 32 modules at the limits of one, `ExpansionBudget.forContent`, as `GET /chunks` holds a commit’s chunks), so from this module on (module ID, then language order) whether they can be cut was not checked (`params.modules`: how many module files, a module in one language each, were not, this one included). Their modules include a lot: refer to fewer modules, over fewer paths.',
  },
  'xref-unknown-module': {
    severity: 'blocking',
    category: 'reference',
    description: 'A cross-reference links to a module that does not exist.',
  },
  'xref-unknown-block': {
    severity: 'blocking',
    category: 'reference',
    description: 'A cross-reference links to a block that does not exist.',
  },
  'xref-outside-manual': {
    severity: 'warning',
    category: 'reference',
    description:
      'A cross-reference links to a module that is not in the manual.',
  },
  'deprecated-module': {
    severity: 'warning',
    category: 'reference',
    description:
      'The manual includes a deprecated module, directly or through module references (`params.module`; `params.replacedBy`, the module replacing it, when it names one).',
  },
  'unknown-page-design': {
    severity: 'blocking',
    category: 'reference',
    description:
      'The manual’s own page design (`design` in its manifest) or the project’s default (`pdf.design`) names a design that is not in the content, or whose file is no design (`params.design`, `params.from`: `manual` or `config`): the PDF uses the built-in design.',
  },
  'unknown-replacement': {
    severity: 'warning',
    category: 'reference',
    description:
      'A deprecated module or manual names a replacement that does not exist, or itself (`params.replacedBy`).',
  },
  'address-taken': {
    severity: 'blocking',
    category: 'reference',
    description:
      'A stable address (`params.address`) is both the ID of a manual and the slug or a former address of another (`delivery.manuals`, `params.as`: `slug` or `formerly`), both manuals ones the reader sees: the address opens the manual configured for it, never the one of that ID (`params.manual`, the other manual).',
  },
  'unknown-term': {
    severity: 'blocking',
    category: 'reference',
    description:
      'A term link names a term that does not exist, or whose file cannot be read (`params.term`).',
  },
  'deprecated-term': {
    severity: 'warning',
    category: 'reference',
    description:
      'A term link names a deprecated term (`params.term`; `params.replacedBy`, the term to use instead, when it names one).',
  },
  'unknown-callout': {
    severity: 'blocking',
    category: 'reference',
    description:
      'A callout reference names an image of its module, or a callout of that image, that does not exist.',
  },
  'hidden-callout': {
    severity: 'warning',
    category: 'reference',
    description:
      'A callout reference names a callout (or an image) that a variant of the manual leaves out: it has no number there.',
  },
  'unknown-callout-style': {
    severity: 'blocking',
    category: 'validation',
    description: 'A callout on an image names a style that is not configured.',
  },
  'missing-image': {
    severity: 'blocking',
    category: 'image',
    description: 'An image block refers to an image that is not stored.',
  },
  'missing-attachment': {
    severity: 'blocking',
    category: 'attachment',
    description: 'An attachment block refers to a file that is not stored.',
  },
  'attachment-file-name': {
    severity: 'blocking',
    category: 'attachment',
    description:
      'An attachment block names its file with an extension that does not fit the stored file (or a dangerous one): downloads ignore that name.',
  },
  'missing-translation': {
    severity: 'warning',
    category: 'translation',
    description:
      'A module has no translation into a target language (a manual falls back to the source language).',
  },
  'outdated-translation': {
    severity: 'warning',
    category: 'translation',
    description:
      'Blocks of the source module changed since this translation was made from it, or were never translated (`params.blocks` counts them; a translation without a record counts every block). At a manual (#656): units of its cover images’ alternative text (`params.at` `coverImage`) or of its page design’s region text (`params.design`) with a version in `params.lang` made from another source text, or without a record.',
  },
  'page-design-missing-translation': {
    severity: 'warning',
    category: 'translation',
    description:
      'A text of the manual’s page design has no version in the manual’s language (`params.design`, `params.at`): the source language’s is used.',
  },
  'missing-cover-image': {
    severity: 'warning',
    category: 'image',
    description:
      'The manual’s cover image, or a variant’s (#394), is not stored or is no image (`params.at` where the manifest names it, `params.asset`): the PDF goes without it.',
  },
  'missing-cover-alt': {
    severity: 'blocking',
    category: 'validation',
    description:
      'The alternative text of the manual’s cover image, or a variant’s (#394), has no version in the source language (`params.at`), which every other language falls back to.',
  },
  'missing-source-title': {
    severity: 'blocking',
    category: 'validation',
    description:
      'The manual’s title, or a group’s (`params.at`), is written per language without a version in the source language (#731), which every other language falls back to.',
  },
  'unknown-cover-variant': {
    severity: 'warning',
    category: 'validation',
    description:
      'The manual gives a cover image to a variant it does not build, or to one that has one already (`params.at`): it is never shown.',
  },
  'unknown-source-manual': {
    severity: 'blocking',
    category: 'reference',
    description:
      'The derived manual’s source manual (#451, `rule.source`) does not exist or cannot be read: it holds only its front and back matter.',
  },
  'derived-source': {
    severity: 'blocking',
    category: 'reference',
    description:
      'The derived manual’s source manual (#451) is a derived manual itself, or the manual itself: nothing is gathered, a derived manual is made from an assembled one.',
  },
  'no-gathered-types': {
    severity: 'blocking',
    category: 'validation',
    description:
      'The derived manual’s rule (#451) names no module types and the configuration marks none as safety (`moduleTypes[].safety`): nothing is gathered.',
  },
  'safety-module-excluded': {
    severity: 'warning',
    category: 'validation',
    description:
      'A module of a safety type (`moduleTypes[].safety`) in the derived manual’s source is left out by its rule (#451; `params.at` the module): excluded, or of a type the rule does not gather.',
  },
  'safety-notice-excluded': {
    severity: 'warning',
    category: 'validation',
    description:
      'A safety notice of the derived manual’s source is left out by its notice gathering (#670; `params.at` the module holding it): every module of the source that includes it is excluded or of a type the rule does not search, or its hazard level is not one the rule gathers.',
  },
  'unknown-excluded-module': {
    severity: 'warning',
    category: 'reference',
    description:
      'The derived manual’s rule excludes a module its source manual does not include (#451; `params.at` the module).',
  },
  'empty-derived-manual': {
    severity: 'warning',
    category: 'validation',
    description:
      'The derived manual’s rule gathers no module from its source manual (#451): it holds only its front and back matter.',
  },
  'derived-audience-wider': {
    severity: 'blocking',
    category: 'validation',
    description:
      'The derived manual is for a wider audience than its source manual (#451): nothing is gathered (only its front and back matter, with its own text attributes), so the source’s text never reaches readers it is not for.',
  },
  'page-design-template-error': {
    severity: 'blocking',
    category: 'validation',
    description:
      'The page design’s own template (#396) does not compile: at a manual laid out with it, or at the design itself when a change set changes the design or its template (checked on a small manual of its own). `params.design`, `params.template`, `params.file` (its repository path), `params.line` and `params.column` (1-based; 0 when the compiler named no place) and `params.problem` (the compiler’s message). The PDF route answers 422 `template-error`; on the base branch the template merged before stays in use.',
  },
  'page-design-unknown-template': {
    severity: 'blocking',
    category: 'validation',
    description:
      'The page design names an own template (`template`, #396) the content repository does not have (`templates/<id>/manual.typ`): its preset lays the PDF out. `params.design`, `params.template`.',
  },
  'page-design-missing-font': {
    severity: 'warning',
    category: 'validation',
    description:
      'A font file of the manual’s page design is not stored, or is no TrueType, OpenType, WOFF or WOFF2 font (`params.design`, `params.at` the face, `params.asset`): the PDF uses the default font in its place.',
  },
  'page-design-dropped-text': {
    severity: 'warning',
    category: 'translation',
    description:
      'A text of the manual’s page design has a version in neither the manual’s language nor the source language (`params.design`, `params.at`): it is left out of the PDF.',
  },
  'page-design-region-languages-differ': {
    severity: 'warning',
    category: 'translation',
    description:
      'A region of the manual’s page design has other blocks in the manual’s language than in the source language (`params.design`, `params.at`, `params.name` the source language): its translation does not keep the source’s block IDs.',
  },
  'missing-label': {
    severity: 'warning',
    category: 'translation',
    description: 'No output labels in the manual’s language: English is used.',
  },
  'forbidden-term': {
    severity: 'warning',
    category: 'writing',
    description:
      'The text uses a forbidden variant of an approved term in the module’s language, matched without case as a whole word (#55; `params.term`, `params.text` what was found, `params.replacement` the preferred variant, `params.note` the variant’s note, `params.field`, `params.start` and `params.end` where in the block’s plain text, UTF-16 offsets), or a variant of a deprecated term (`params.status` `deprecated`; `params.replacement` its replacement’s preferred variant, when it names one). Blocking when the configuration says so (`terminology.forbiddenIsBlocking`), for forbidden variants only; else a warning.',
  },
  'style-rule': {
    severity: 'warning',
    category: 'writing',
    description:
      'The text matches a style rule of the module’s language (#55, `styleRules` in `openfolia.yaml`; `params.rule` its ID, `params.message` its message, `params.replacement` its fix, `params.text`, `params.field`, `params.start`, `params.end`), or has a sentence longer than `maxSentenceWords` (`params.rule` `max-sentence-words`, `params.words`, `params.max`). The rule’s `severity` decides: a warning unless it says `blocking`.',
  },
  'writing-not-checked': {
    severity: 'warning',
    category: 'writing',
    description:
      'The writing checks (#55) stopped before the end of the module’s text (`params.stopped`): it is longer than they read (`chars`, `MAX_WRITING_CHARS`, 1,000,000 characters), it has more findings than they report (`findings`, `MAX_WRITING_FINDINGS`, 1,000), or its style rules’ patterns took more than their steps (`steps`, `MAX_WRITING_STEPS`). What comes after was not checked.',
  },
} as const satisfies Record<string, CodeRule>;

export type CheckCode = keyof typeof CHECK_CODES;

export function isCheckCode(code: string): code is CheckCode {
  return Object.hasOwn(CHECK_CODES, code);
}

/** One problem found, where it is, and where it can be fixed. */
export interface Check {
  readonly code: CheckCode;
  /** The module (in one language) or manual it is in. */
  readonly subject: ContentSubject;
  /** The block, list item or procedure step, by its ID; absent for the subject as a whole. */
  readonly blockId?: string;
  /** For people reading logs; clients show their own text for `code`. */
  readonly message: string;
  /** What the code is about, e.g. `module`, `lang`, `asset`, `target`, `at`. */
  readonly params: Readonly<Record<string, string>>;
  /** The variants (slugs) of a manual it was found in; empty when it does not depend on one. */
  readonly variants: readonly string[];
  /** The languages of a manual it was found in; empty when it does not depend on one. */
  readonly languages: readonly string[];
  /** The subject's title as the reader reads it; absent when it could not be read. */
  readonly title?: string;
  /**
   * Where the configuration decides (`forbidden-term`, `style-rule`, #55): the severity
   * configured, in place of the code's.
   */
  readonly severity?: CheckSeverity;
}

export const severityOf = (
  check: Pick<Check, 'code' | 'severity'>,
): CheckSeverity => check.severity ?? CHECK_CODES[check.code].severity;

export const categoryOf = (check: Pick<Check, 'code'>): CheckCategory =>
  CHECK_CODES[check.code].category;

/** What makes two checks the same problem (found in several variants or languages). */
export function checkKey(
  check: Omit<Check, 'variants' | 'languages' | 'title' | 'severity'>,
): string {
  const params = Object.entries(check.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return JSON.stringify([
    check.code,
    check.subject,
    check.blockId ?? null,
    params,
  ]);
}

/**
 * Collects checks, merging the same problem found again (in another
 * variant or language) into one, which names where it was found.
 */
export class CheckList {
  readonly #checks = new Map<
    string,
    { check: Check; variants: Set<string>; languages: Set<string> }
  >();

  add(
    check: Omit<Check, 'variants' | 'languages' | 'params'> & {
      params?: Check['params'];
      variant?: string;
      language?: string;
    },
  ): void {
    const { variant, language, ...rest } = check;
    const found: Omit<Check, 'variants' | 'languages'> = {
      ...rest,
      params: rest.params ?? {},
    };
    const key = checkKey(found);
    let entry = this.#checks.get(key);
    if (!entry) {
      entry = {
        check: { ...found, variants: [], languages: [] },
        variants: new Set(),
        languages: new Set(),
      };
      this.#checks.set(key, entry);
    }
    if (variant !== undefined) entry.variants.add(variant);
    if (language !== undefined) entry.languages.add(language);
  }

  /**
   * In order: by subject (manuals, then modules by language and ID), the
   * subject's own checks first, then by where the block is in it
   * (`blockOrder`), then blocking before warnings, then by code.
   */
  sorted(
    blockOrder: (subject: LockSubject, blockId: string) => number,
  ): Check[] {
    const checks = [...this.#checks.values()].map(
      ({ check, variants, languages }) => ({
        ...check,
        variants: [...variants],
        languages: [...languages],
      }),
    );
    const position = (check: Check) =>
      check.blockId === undefined
        ? -1
        : blockOrder(check.subject, check.blockId);
    return checks.sort(
      (a, b) =>
        bySubjectKey(a.subject, b.subject) ||
        position(a) - position(b) ||
        (a.blockId ?? '').localeCompare(b.blockId ?? '') ||
        CHECK_SEVERITIES.indexOf(severityOf(a)) -
          CHECK_SEVERITIES.indexOf(severityOf(b)) ||
        a.code.localeCompare(b.code) ||
        checkKey(a).localeCompare(checkKey(b)),
    );
  }
}

/** How many checks of each severity. */
export function countBySeverity(
  checks: readonly Check[],
): Record<CheckSeverity, number> {
  const counts = { blocking: 0, warning: 0 };
  for (const check of checks) counts[severityOf(check)] += 1;
  return counts;
}
