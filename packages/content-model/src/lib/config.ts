import { z } from 'zod';
import { ConfigKey, LanguageTag, ModuleId, SingleLine } from './ids.js';
import { LinkHref } from './inline.js';
import { Token } from './blocks.js';
import {
  DEFAULT_CALLOUT_LABEL_MIN_SIZE,
  MAX_CALLOUT_LABEL_SIZE,
  MIN_CALLOUT_LABEL_SIZE,
} from './callouts.js';
import { OUTPUT_LABEL_KEYS, type OutputLabelKey } from './labels.js';
import { DEFAULT_MAX_HEADING_LEVEL, MAX_SECTION_DEPTH } from './structure.js';
import {
  DEFAULT_DELIVERY_ACCESS,
  DEFAULT_MISSING_LANGUAGE,
  DEFAULT_PDF_QR_CODE,
  DELIVERY_ACCESS,
  MAX_FORMER_ADDRESSES,
  MISSING_LANGUAGE,
  PDF_QR_CODE,
} from './delivery.js';
import { TEXT_DIRECTIONS } from './direction.js';
import { ditaMappingSchema } from './dita.js';
import { iirdsMappingSchema } from './iirds.js';
import {
  MAX_STYLE_PATTERN_LENGTH,
  MAX_STYLE_PATTERN_REPEAT,
  MAX_STYLE_PATTERN_STATES,
  stylePatternProblem,
} from './style-pattern.js';
import {
  MAX_SENTENCE_WORDS,
  MAX_STYLE_RULES,
  MAX_STYLE_WORDS_LENGTH,
  MIN_SENTENCE_WORDS,
  SENTENCE_RULE_ID,
  WRITING_SEVERITIES,
} from './writing-check.js';
import { LanguageKey, localizedText } from './localized-text-schema.js';
import { CommitId, SourceHash } from './translation.js';
import { configTexts } from './config-units.js';
import { sourceTextOf } from './localized-text.js';

// Schema-free, in their own files for `@openfolia/content-model/core`; here too, where they belong.
export { DEFAULT_MAX_HEADING_LEVEL } from './structure.js';
export { productFacet, type Facet } from './facets.js';

/**
 * Everything organisation-specific lives here, not in code: languages,
 * module types, audience levels, classification facets, variant attributes,
 * text attributes, safety symbols and the labels printed in outputs.
 */
const uniqueIds = <T extends { id: string }>(items: T[]) =>
  new Set(items.map((i) => i.id)).size === items.length;

/**
 * Every address in `delivery.manuals` names one manual: no two manuals share a slug, no
 * former address is another manual's (or its own) slug or another manual's former address,
 * and no former address is the ID of another manual listed there. (A manual not listed keeps
 * its ID as its address; a slug equal to it wins, see `manualOfSlug`.)
 */
function uniqueAddresses(
  manuals: Record<string, { slug?: string; formerly: string[] }>,
): boolean {
  const owner = new Map<string, string>();
  const claim = (address: string, manual: string) => {
    const held = owner.get(address);
    if (held !== undefined && held !== manual) return false;
    owner.set(address, manual);
    return true;
  };
  const entries = Object.entries(manuals);
  for (const [id, entry] of entries) {
    if (!claim(entry.slug ?? id, id)) return false;
  }
  const current = new Set(owner.keys());
  // A listed manual's own ID stays its own: another's former address would take it over.
  const listed = new Set(entries.map(([id]) => id));
  for (const [id, entry] of entries) {
    for (const former of entry.formerly) {
      if (current.has(former) || (listed.has(former) && former !== id)) {
        return false;
      }
      if (!claim(former, id)) return false;
    }
  }
  return true;
}

/** The longest `styleGuide` (UTF-16 code units). */
export const MAX_STYLE_GUIDE_LENGTH = 20_000;

/**
 * The PDF standards a manual's PDF can be made to: `ua-1`, PDF/UA-1 (tagged
 * and accessible: structure tree, language, title, alt texts; a document
 * that cannot meet it is refused), or `none`, a plain PDF (tagged as far as
 * the renderer does by itself, never refused for accessibility).
 */
export const PDF_STANDARDS = ['ua-1', 'none'] as const;
export type PdfStandard = (typeof PDF_STANDARDS)[number];

/** The PDF standard when the configuration names none: PDF/UA-1. */
export const DEFAULT_PDF_STANDARD: PdfStandard = 'ua-1';

/** The longest line of the manufacturer's details (#395): its name, an address line, the contact. */
export const MAX_MANUFACTURER_LINE = 200;
/** The most lines the manufacturer's address has (#395). */
export const MAX_MANUFACTURER_ADDRESS_LINES = 10;

/** An output label's description: what it is, a sample and the fallback. */
const outputLabel = (what: string, sample: string) =>
  `${what}, e.g. \`${sample}\`. Without it: the label of the base language (\`pt\` for \`pt-BR\`), then the shipped default (English, German, French, Arabic and Hebrew ship one), else English, reported as \`missing-label\`.`;

/**
 * What each output label is, for the `openfolia.yaml` reference (`outputLabels.<lang>.<key>`).
 * Every key needs one: a new label key without it does not compile.
 */
const OUTPUT_LABEL_DESCRIPTIONS: Record<OutputLabelKey, string> = {
  danger: outputLabel('The signal word of a `danger` safety message', 'DANGER'),
  warning: outputLabel(
    'The signal word of a `warning` safety message',
    'WARNING',
  ),
  caution: outputLabel(
    'The signal word of a `caution` safety message',
    'CAUTION',
  ),
  notice: outputLabel('The signal word of a `notice` safety message', 'NOTICE'),
  note: outputLabel('The caption of a `note` admonition', 'Note'),
  tip: outputLabel('The caption of a `tip` admonition', 'Tip'),
  important: outputLabel(
    'The caption of an `important` admonition',
    'Important',
  ),
  contents: outputLabel('The title of the table of contents', 'Contents'),
  figure: outputLabel(
    'The word before a figure’s number in its caption',
    'Figure',
  ),
  table: outputLabel(
    'The word before a table’s number in its caption',
    'Table',
  ),
  unconverted: outputLabel(
    'The caption of content an import could not convert (a passthrough block)',
    'Unconverted content',
  ),
  attachment: outputLabel(
    'The label in front of an attached file’s name',
    'Attachment',
  ),
  attachmentNote: outputLabel(
    'The note the PDF prints with an attached file, which a reader downloads from the online version',
    'Download the file from the online version of this document.',
  ),
  glossary: outputLabel(
    'The title of the glossary that ends a manual whose manifest sets `glossary: true`',
    'Glossary',
  ),
  updateVersion: outputLabel(
    'The word before a version in an update guide’s headings (`Version 2.0`)',
    'Version',
  ),
  updateBefore: outputLabel(
    'The heading of an update guide’s steps done before the update',
    'Before the update',
  ),
  updateDuring: outputLabel(
    'The heading of an update guide’s steps done during the update',
    'During the update',
  ),
  updateAfter: outputLabel(
    'The heading of an update guide’s steps done after the update',
    'After the update',
  ),
};

/** One language's labels in the configuration: any subset, each overriding the shipped default. */
export const OutputLabelSet = z
  .object(
    Object.fromEntries(
      OUTPUT_LABEL_KEYS.map((key) => [
        key,
        z.string().min(1).optional().describe(OUTPUT_LABEL_DESCRIPTIONS[key]),
      ]),
    ) as Record<OutputLabelKey, z.ZodOptional<z.ZodString>>,
  )
  .strict();
export type OutputLabelSet = z.infer<typeof OutputLabelSet>;

/** The most languages the configuration's translation record names. */
const MAX_CONFIG_RECORD_LANGUAGES = 100;

/** The most units the configuration's translation record names in one language. */
export const MAX_CONFIG_UNITS = 20_000;

/**
 * A unit of the configuration's translatable text (#731): a configured label, keyed by its list
 * and ID (`moduleTypes.<id>`, `audiences.<id>`, `facets.<id>`, `facets.<id>.<value>`,
 * `variantAttributes.<id>`, `variantAttributes.<id>.<value>`, `textAttributes.<id>`,
 * `safetySymbols.<id>`, `calloutStyles.<id>`). An XML name token, as an XLIFF unit's `id` must be.
 */
export const ConfigUnitKey = z
  .string()
  .max(200)
  .regex(
    /^(?:moduleTypes|audiences|facets|variantAttributes|textAttributes|safetySymbols|calloutStyles)\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)?$/,
    'a configured label, e.g. "moduleTypes.task" or "facets.product.north"',
  );
export type ConfigUnitKey = z.infer<typeof ConfigUnitKey>;

/**
 * What the configuration's labels in one target language were translated from (#731), as a
 * manifest's record says it: per unit (`ConfigUnitKey`) the source hash of the label it was made
 * from, and the source commit that was read.
 */
export const ConfigTranslationRecord = z
  .strictObject({
    sourceCommit: CommitId.describe(
      'The full ID of the commit whose labels were translated.',
    ),
    blocks: z
      .record(
        ConfigUnitKey,
        SourceHash.describe(
          'The SHA-256 of the source-language label the translation was made from.',
        ),
      )
      .refine(
        (units) => Object.keys(units).length <= MAX_CONFIG_UNITS,
        `at most ${MAX_CONFIG_UNITS} units`,
      )
      .describe(
        'Per label (`moduleTypes.<id>`, `facets.<id>.<value>`, …), the source hash its translation was made from.',
      ),
  })
  .describe('One target language’s record.');
export type ConfigTranslationRecord = z.output<typeof ConfigTranslationRecord>;

/**
 * The configuration's schema, its objects made by `object`: `z.object`
 * (unknown keys dropped) for reading `openfolia.yaml`, `z.strictObject` (unknown
 * keys refused) for a configuration someone sends to be stored.
 */
function configSchema(object: typeof z.object, strict: boolean) {
  /**
   * A configured thing's `id` and `label`, described for what it is (`what`). The label is one
   * text for every language or one per language (#731, `LocalizedText`).
   */
  const option = (id: string, label: string) =>
    object({
      id: ConfigKey.describe(
        `${id} Lowercase letters, digits and \`-\`, starting with a letter, at most 64 characters; unique in its list.`,
      ),
      label: localizedText(z.string().min(1)).describe(
        `${label} One text for every language, or one per language by language tag (\`{ en: Task, de: Handlung }\`), the source language’s among them; a language without its own shows the source language’s.`,
      ),
    });
  const kindDescription =
    'How the attribute’s values are compared: `enum`, one of a fixed list of values (`values`, e.g. a model or a market), or `version`, a dotted version compared numerically (`2.10` is after `2.9`, e.g. a software version), which lists no values.';
  const variantAttributeOption = () =>
    option(
      'The variant attribute’s ID, which `variant` blocks, `when:` conditions and a manual’s variants name, e.g. `model` or `software`.',
      'The variant attribute’s name in the editor and where a variant is named, e.g. `Model` (a version shows as `Software 2.1`).',
    );
  const VariantAttribute = z.discriminatedUnion('kind', [
    /** A fixed set of values, e.g. model, market, installed option. */
    variantAttributeOption().extend({
      kind: z.literal('enum').describe(kindDescription),
      values: z
        .array(
          option(
            'The value’s ID, which conditions compare with, e.g. `large` in `when: model = large`.',
            'The value’s name in the editor and where a variant is named, e.g. `Large`.',
          ).extend({
            /**
             * Archived: still valid where content uses it, but no longer
             * offered for new content (pickers hide it). Removing a value
             * content still uses is refused; archiving it is the way out.
             */
            archived: z
              .boolean()
              .optional()
              .describe(
                '`true` retires the value: content that uses it stays valid, but the editor no longer offers it. Removing a value that content still uses is refused, so archiving is the way to retire one. Left out: the value is offered.',
              ),
          }),
        )
        .min(1)
        .refine(uniqueIds, 'duplicate value id')
        .describe(
          'For `kind: enum` only: the values the attribute can take, at least one, each `{ id, label }`.',
        ),
    }),
    /** A dotted version, compared numerically, e.g. software version. */
    variantAttributeOption().extend({
      kind: z.literal('version').describe(kindDescription),
    }),
  ]);
  const config = object({
    languages: object({
      source: LanguageTag.describe(
        'The language content is written in, as a BCP 47 tag, e.g. `en` or `pt-BR`. Every module has a file in it; a missing translation falls back to it.',
      ),
      targets: z
        .array(LanguageTag)
        .refine(
          (tags) => new Set(tags).size === tags.length,
          'duplicate target language',
        )
        .describe(
          'The languages content is translated into, as BCP 47 tags, e.g. `[de, fr-CA]`; no repeats, and not the source language. Manuals are made in the source language and in each of these. An empty list: no translations.',
        ),
      /**
       * A language's text direction where its script's is not the one wanted
       * (`ltr` or `rtl`, by language tag): e.g. `ku-Arab: rtl` is the script's anyway, a
       * tag whose script is unknown may need it. A language without one takes its
       * script's (`defaultDirection`); an entry for a language not configured does nothing.
       */
      direction: z
        .record(LanguageTag, z.enum(TEXT_DIRECTIONS))
        .optional()
        .describe(
          'Per language tag, the direction its text runs in, `ltr` or `rtl`, where its script’s own is not the one wanted, e.g. `{ ku: rtl }` for Kurdish written in Arabic script. A language left out takes its script’s direction (Arabic and Hebrew script run right to left); an entry for a language not configured does nothing.',
        ),
    }).describe(
      'The project’s languages: the one content is written in and the ones it is translated into.',
    ),
    moduleTypes: z
      .array(
        option(
          'The module type’s ID, which each module names in its `type`, e.g. `task`, `concept` or `safety`.',
          'The module type’s name in the editor, e.g. `Task`.',
        ).extend({
          /** Restricted types need the `content.approve` permission to sign off, e.g. safety. */
          restricted: z
            .boolean()
            .default(false)
            .describe(
              '`true`: a change set that changes a module of this type also needs a sign-off from someone with the `content.approve` permission over those modules (not its author, unless the installation allows self-approval) before it is merged, e.g. for safety content. Left out: `false`, the review’s approval is enough.',
            ),
          /**
           * Snippet types hold reusable wording (a standard sentence, a safety paragraph): one or
           * a few blocks, inserted by reference or copied, and suggested while writing.
           */
          snippet: z
            .boolean()
            .default(false)
            .describe(
              '`true`: modules of this type hold reusable wording (a standard sentence, a safety paragraph), one or a few blocks that authors insert by reference or copy and that the editor suggests while writing. Left out: `false`, an ordinary module type.',
            ),
          /** Safety types (#451): what a derived manual such as a safety leaflet gathers by default. */
          safety: z
            .boolean()
            .optional()
            .describe(
              '`true`: modules of this type are safety content. A derived manual (`kind: derived`, e.g. a safety leaflet) whose rule names no module types gathers the modules of these types from its source manual, and its checks warn about a module of one it leaves out. Left out: `false`.',
            ),
        }),
      )
      .min(1)
      .refine(uniqueIds, 'duplicate module type id')
      .describe(
        'The kinds of module the project writes, at least one, each `{ id, label }`. A module’s type decides whether it needs a sign-off, which roles may change it, and how exports classify it.',
      ),
    /** Ordered from least to most restricted. Modules without an audience get the last one. */
    audiences: z
      .array(
        option(
          'The audience level’s ID, which a module’s `audience` and a manual’s `audience` name, e.g. `operator` or `technician`.',
          'The audience level’s name in the editor and on title pages, e.g. `Operator`.',
        ),
      )
      .min(1)
      .refine(uniqueIds, 'duplicate audience id')
      .describe(
        'The audience levels, at least one, ordered from the least to the most restricted, each `{ id, label }`. A manual for one level leaves out modules for the levels after it; a module that names no audience gets the last, most restricted one.',
      ),
    facets: z
      .array(
        option(
          'The facet’s ID, which a module’s `facets` name, e.g. `product` or `topic`.',
          'The facet’s name in the editor, e.g. `Product`.',
        ).extend({
          values: z
            .array(
              option(
                'The value’s ID, which a module’s `facets` give for this facet, e.g. `north`.',
                'The value’s name in the editor, e.g. `North series`.',
              ),
            )
            .min(1)
            .refine(uniqueIds, 'duplicate value id')
            .describe(
              'The values a module can be classified with in this facet, at least one, each `{ id, label }`.',
            ),
        }),
      )
      .default([])
      .refine(uniqueIds, 'duplicate facet id')
      .describe(
        'Classifications of modules, each `{ id, label, values }`, e.g. a product line or a region: for finding and filtering modules, for keeping a role to some of them, and for the products a release is cut for (`release.productFacet`). Left out: none.',
      ),
    variantAttributes: z
      .array(VariantAttribute)
      .default([])
      .refine(uniqueIds, 'duplicate variant attribute id')
      .describe(
        'The attributes content varies by, each `{ id, label, kind }`, e.g. a model or a software version. `variant` blocks and `when:` conditions test them, and each manual lists the combinations it ships. Left out: content does not vary.',
      ),
    /** Named text values used inline (`attribute` nodes); their values are set per manual and variant. */
    textAttributes: z
      .array(
        option(
          'The text attribute’s ID, which text refers to as `{id}`, e.g. `{product-name}`. `empty` is reserved.',
          'The text attribute’s name in the editor, e.g. `Product name`.',
        ).refine(
          (a) => a.id !== 'empty',
          '"empty" is a reserved attribute name',
        ),
      )
      .default([])
      .refine(uniqueIds, 'duplicate text attribute id')
      .describe(
        'Named text values that content uses inline (`{product-name}`), each `{ id, label }`; each manual sets their values, per variant where they differ. Left out: none.',
      ),
    safetySymbols: z
      .array(
        option(
          'The symbol’s ID, which a safety message’s `symbols` name; its artwork is `symbols/<id>.svg` or `symbols/<id>.png` in the content repository, e.g. `hot-surface`.',
          'The symbol’s name in the editor, and its alternative text in outputs, e.g. `Hot surface`.',
        ),
      )
      .default([])
      .refine(uniqueIds, 'duplicate safety symbol id')
      .describe(
        'The pictograms safety messages may show, each `{ id, label }`. A symbol without artwork prints as a placeholder in the PDF and is left out of the web page. Left out: none.',
      ),
    /**
     * The marker styles an image callout may name (`style`, #498), e.g. a
     * square for parts to remove. A callout without one has the default
     * style (a filled circle with its number). Optional: none.
     */
    calloutStyles: z
      .array(
        option(
          'The style’s ID, which an image callout names in its `style`, e.g. `remove`.',
          'The style’s name in the editor, e.g. `Part to remove`.',
        ),
      )
      .refine(uniqueIds, 'duplicate callout style id')
      .optional()
      .describe(
        'The marker styles an image callout may use besides the default, each `{ id, label }`, e.g. a square for parts to remove. A callout without a style is a filled circle with its number. Left out: none.',
      ),
    /**
     * Per target language, what its labels were translated from (#731,
     * `ConfigTranslationRecord`), as a manifest's record. None: no translation of them has a
     * record (each is outdated).
     */
    translations: z
      .record(LanguageKey, ConfigTranslationRecord)
      .refine(
        (langs) => Object.keys(langs).length <= MAX_CONFIG_RECORD_LANGUAGES,
        `at most ${MAX_CONFIG_RECORD_LANGUAGES} languages`,
      )
      .optional()
      .describe(
        'Per target language, what its labels were translated from: `{ sourceCommit, blocks }`, `blocks` the source hash of each label (`moduleTypes.<id>`, `facets.<id>.<value>`, …) its translation was made from. Written by a translation import and by marking a translation current; left out: no record.',
      ),
    /**
     * Fixed output texts per manual language (signal words, "Contents", …),
     * each overriding the shipped default (`DEFAULT_OUTPUT_LABELS`).
     */
    outputLabels: z
      .record(
        LanguageTag,
        OutputLabelSet.describe(
          'One language’s labels, by language tag (`pt-BR`; `pt` also fills what a `pt-…` set leaves out): any of the keys below.',
        ),
      )
      .default({})
      .describe(
        'The fixed texts outputs print around the content (signal words, admonition captions, the contents title, …), per manual language, each replacing the shipped default. The manual’s language decides them, never the reader’s. Left out: the shipped defaults.',
      ),
    /**
     * The deepest heading level the editor offers (Heading 1 is a section at the top of a
     * module, Heading 2 one inside it, …): 1 to `MAX_SECTION_DEPTH`, default 3.
     */
    maxHeadingLevel: z
      .number()
      .int()
      .min(1)
      .max(MAX_SECTION_DEPTH)
      .default(DEFAULT_MAX_HEADING_LEVEL)
      .describe(
        `The deepest heading level the editor offers, 1 to ${MAX_SECTION_DEPTH}: Heading 1 is a section at the top of a module, Heading 2 a section inside it, and so on. Modules stored with deeper sections stay valid. Left out: ${DEFAULT_MAX_HEADING_LEVEL}.`,
      ),
    /**
     * Code languages the editor offers for a code block, beside the shipped list; each `id` is
     * the language word stored on the block (e.g. "php", "c++"), `label` its display name. A
     * configured id that is also shipped replaces its label.
     */
    codeLanguages: z
      .array(
        object({
          id: Token.max(32).describe(
            'The language word a code block stores, one word of letters, digits and `+ # . _ -`, at most 32 characters, e.g. `fortran` or `c++`. An ID the editor already ships replaces its label.',
          ),
          label: z
            .string()
            .min(1)
            .describe(
              'The language’s name in the editor’s picker, e.g. `Fortran`.',
            ),
        }),
      )
      .default([])
      .refine(uniqueIds, 'duplicate code language id')
      .describe(
        'Languages the editor offers for a code block besides the ones it ships, each `{ id, label }`. Left out: only the shipped ones.',
      ),
    /**
     * Releases: `productFacet` names the facet whose values are the products a release
     * is cut for (a release is `<product>` at a revision). Without it, the first facet.
     */
    release: object({
      productFacet: ConfigKey.optional().describe(
        'The ID of the facet whose values are the products a release is cut for (a release is a product at a revision), e.g. `product`; it must name a configured facet. Left out: the first facet.',
      ),
      /**
       * Whether every manual's checks warn while the project has no manufacturer details
       * (`missing-manufacturer`, #395): a manual is not released without its imprint. Default off.
       */
      checkManufacturer: z
        .boolean()
        .optional()
        .describe(
          '`true`: every manual’s checks warn (`missing-manufacturer`) while `manufacturer` is not set, so no manual is released without its imprint. Left out: `false`.',
        ),
    })
      .optional()
      .describe('How releases are cut. Left out: every default.'),
    /**
     * The manufacturer (#395): who makes the product and how to reach them, for a page design's
     * back page (imprint) and its `manufacturer-*` placeholders on any page. Optional.
     */
    manufacturer: object({
      name: SingleLine.max(MAX_MANUFACTURER_LINE).describe(
        `The manufacturer’s name as printed, one line, at most ${MAX_MANUFACTURER_LINE} characters, e.g. \`Example Works Ltd\`.`,
      ),
      address: z
        .array(SingleLine.max(MAX_MANUFACTURER_LINE))
        .max(MAX_MANUFACTURER_ADDRESS_LINES)
        .default([])
        .describe(
          `The postal address, one entry per printed line, at most ${MAX_MANUFACTURER_ADDRESS_LINES} lines, e.g. \`[1 Sample Street, 12345 Sample Town]\`. Left out: none.`,
        ),
      contact: SingleLine.max(MAX_MANUFACTURER_LINE)
        .optional()
        .describe(
          'How to reach the manufacturer, one line, e.g. `info@example.com · +1 555 0100`. Left out: none.',
        ),
      website: LinkHref.max(2000)
        .optional()
        .describe(
          'The manufacturer’s website, an absolute `https:` or `http:` address (or a `mailto:` one), e.g. `https://example.com`. Left out: none.',
        ),
    })
      .optional()
      .describe(
        'The manufacturer’s details for the imprint: a page design’s back page prints them, and its `manufacturer-name`, `manufacturer-address`, `manufacturer-contact` and `manufacturer-website` placeholders show them on any page. Left out: none (with `release.checkManufacturer`, every manual’s checks warn).',
      ),
    /**
     * The house style in plain words, for the model-based style review (the API's
     * `style-review`): sent with the module's text when an author asks for one. Optional.
     */
    styleGuide: z
      .string()
      .trim()
      .min(1)
      .max(MAX_STYLE_GUIDE_LENGTH)
      .optional()
      .describe(
        `The house style in plain words (e.g. “Address the reader as you. One instruction per step.”), at most ${MAX_STYLE_GUIDE_LENGTH.toLocaleString('en')} characters. The model-based style review sends it with a module’s text when an author asks for one. Left out: the review has no house style to check against.`,
      ),
    /**
     * The terminology checks (#55): whether a forbidden variant of a term holds up review and
     * release (`forbiddenIsBlocking`), or is only a warning (the default).
     */
    terminology: object({
      forbiddenIsBlocking: z
        .boolean()
        .default(false)
        .describe(
          '`true`: a forbidden variant of an approved term in a module’s text is a blocking check (`forbidden-term`), which holds up review and release until it is replaced. Left out: `false`, a warning. A variant of a deprecated term is always a warning.',
        ),
    })
      .optional()
      .describe(
        'How the terminology checks weigh what they find: forbidden variants of approved terms and the variants of deprecated terms, matched in each module’s language without case, as whole words. Left out: every default.',
      ),
    /**
     * The house style as rules the checks and the editor apply to every module's text (#55),
     * per language: phrases and patterns with a message, and the longest sentence.
     */
    styleRules: z
      .record(
        LanguageTag,
        object({
          maxSentenceWords: z
            .number()
            .int()
            .min(MIN_SENTENCE_WORDS)
            .max(MAX_SENTENCE_WORDS)
            .optional()
            .describe(
              `The most words a sentence may have, ${MIN_SENTENCE_WORDS} to ${MAX_SENTENCE_WORDS}, e.g. \`25\`: a longer one is a \`style-rule\` warning. A sentence ends at \`.\`, \`!\`, \`?\` or \`…\` before white space, or at a line break. Left out: sentences of any length.`,
            ),
          rules: z
            .array(
              object({
                id: ConfigKey.describe(
                  'The rule’s ID, which its findings name, e.g. `in-order-to`. Lowercase letters, digits and `-`, starting with a letter, at most 64 characters; unique in its language.',
                ),
                words: SingleLine.max(MAX_STYLE_WORDS_LENGTH)
                  .refine(
                    (words) => /[\p{L}\p{N}]/u.test(words),
                    'at least one letter or digit',
                  )
                  .optional()
                  .describe(
                    `A phrase to find, at most ${MAX_STYLE_WORDS_LENGTH} characters, e.g. \`in order to\`: matched as whole words, without case (unless \`matchCase\`), any white space between its words alike. Give \`words\` or \`pattern\`, not both.`,
                  ),
                pattern: z
                  .string()
                  .min(1)
                  .max(MAX_STYLE_PATTERN_LENGTH)
                  .superRefine((pattern, ctx) => {
                    const problem = stylePatternProblem(pattern);
                    if (problem !== undefined) {
                      ctx.addIssue({
                        code: 'custom',
                        message: `not a supported pattern: ${problem}`,
                      });
                    }
                  })
                  .optional()
                  .describe(
                    `A pattern to find, at most ${MAX_STYLE_PATTERN_LENGTH} characters, e.g. \`\\butili[sz]e\\b\`, matched without case (unless \`matchCase\`) in linear time, never by backtracking: characters, \`.\`, classes (\`[a-z]\`, \`[^…]\`, \`\\d\`, \`\\w\` (letters, digits, marks and \`_\` of any script), \`\\s\` and their negations), groups (\`(…)\`, \`(?:…)\`), \`|\`, \`?\`, \`*\`, \`+\`, counts up to ${MAX_STYLE_PATTERN_REPEAT} (\`{2}\`, \`{1,3}\`), \`^\`, \`$\` and \`\\b\`, \`\\B\`. No back-references, lookaround or lazy repetition; a pattern matching empty text, or of more than ${MAX_STYLE_PATTERN_STATES} states once its counts are written out, is refused. Each match is the longest from where it starts, matches never overlap. Give \`words\` or \`pattern\`, not both.`,
                  ),
                matchCase: z
                  .boolean()
                  .optional()
                  .describe(
                    '`true`: `words` or `pattern` match only in the case written. Left out: `false`, any case.',
                  ),
                message: SingleLine.max(500).describe(
                  'What the writer is told, in the language the rule is for, at most 500 characters, e.g. `Write “to”.`',
                ),
                replacement: z
                  .string()
                  .max(MAX_STYLE_WORDS_LENGTH)
                  .regex(/^[^\n\r]*$/, 'one line')
                  .optional()
                  .describe(
                    'What to write instead, offered as the fix, e.g. `to`; empty: delete what was found. For `words` without `matchCase`, written in the case found (a capital first, or all capitals). Left out: no fix is offered.',
                  ),
                severity: z
                  .enum(WRITING_SEVERITIES)
                  .optional()
                  .describe(
                    '`warning`, worth a look, or `blocking`, which holds up review and release until it is fixed. Left out: `warning`.',
                  ),
              })
                .refine(
                  (rule) =>
                    (rule.words === undefined) !== (rule.pattern === undefined),
                  'give exactly one of words and pattern',
                )
                .describe('One rule: a phrase or a pattern, and its message.'),
            )
            .max(MAX_STYLE_RULES)
            .refine(uniqueIds, 'duplicate style rule id')
            .refine(
              (rules) => rules.every((rule) => rule.id !== SENTENCE_RULE_ID),
              `"${SENTENCE_RULE_ID}" is the ID of the sentence length’s findings`,
            )
            .default([])
            .describe(
              `The language’s rules, at most ${MAX_STYLE_RULES}, each a \`style-rule\` check where it matches. Left out: none.`,
            ),
        }).describe(
          'One language’s style rules, by language tag, e.g. `en`; it must be a configured language.',
        ),
      )
      .optional()
      .describe(
        'The house style as rules, per language: phrases and patterns the checks before review and release, the CLI check (`check-content`) and the editor report in each module’s text, with their message and fix, and the longest sentence. Only translatable text is read (never code, literal or passthrough blocks). Left out: no style rules.',
      ),
    /**
     * The PDF output: `standard`, the PDF standard every manual's PDF is made to
     * (`PDF_STANDARDS`), default `ua-1` (PDF/UA-1); `none` turns it off.
     */
    pdf: object({
      standard: z
        .enum(PDF_STANDARDS)
        .default(DEFAULT_PDF_STANDARD)
        .describe(
          'The standard every manual’s PDF is made to: `ua-1`, PDF/UA-1, tagged and accessible (a document that cannot meet it is refused), or `none`, a plain PDF. Left out: `ua-1`.',
        ),
      /**
       * The project's default page design (#390), by ID (`design/<id>.yaml`): what a manual
       * whose manifest names none uses. None: the built-in design.
       */
      design: ModuleId.optional().describe(
        'The page design of every manual whose manifest names none, by its ID: the file `design/<id>.yaml` in the content repository, e.g. `classic-a4`. Left out: the built-in design.',
      ),
      /**
       * The smallest text size, in points, a callout legend beside its image shrinks to before
       * what still does not fit is cut off and reported (`callout-label-overflow`, #548): from
       * 4 to 12; absent: `DEFAULT_CALLOUT_LABEL_MIN_SIZE` (6).
       */
      calloutLabelMinSize: z
        .number()
        .min(MIN_CALLOUT_LABEL_SIZE)
        .max(MAX_CALLOUT_LABEL_SIZE)
        .optional()
        .describe(
          `The smallest text size, in points, that a callout legend beside its image shrinks to before what still does not fit is cut off and reported, ${MIN_CALLOUT_LABEL_SIZE} to ${MAX_CALLOUT_LABEL_SIZE}, e.g. \`7.5\`. Left out: ${DEFAULT_CALLOUT_LABEL_MIN_SIZE}.`,
        ),
    })
      .default({ standard: DEFAULT_PDF_STANDARD })
      .describe('How manuals are made as PDF. Left out: every default.'),
    /**
     * Stable addresses (#450, `delivery.ts`): who may open them (`access`, default
     * `signed-in`), the most restricted audience level a public one serves
     * (`publicAudience`, default the first level), what one in a language the release does
     * not have opens (`missingLanguage`), where a release's PDF prints its QR code
     * (`pdfQrCode`, default `none`), and per manual ID its address (`slug`, default the ID)
     * and the addresses it had before (`formerly`), which lead to the current one.
     */
    delivery: object({
      access: z
        .enum(DELIVERY_ACCESS)
        .default(DEFAULT_DELIVERY_ACCESS)
        .describe(
          'Who may open a manual’s stable address (`/d/<product>/<manual>/<variant>/<lang>`, the latest release’s manual): `public`, anyone without signing in; `signed-in`, a signed-in reader allowed to read content; or `off`, nobody. The installation may cap it to less. Left out: `signed-in`.',
        ),
      publicAudience: ConfigKey.optional().describe(
        'The most restricted audience level a public address shows, by its ID, e.g. `operator`; it must name a configured audience. Left out: the first, least restricted level.',
      ),
      missingLanguage: z
        .enum(MISSING_LANGUAGE)
        .default(DEFAULT_MISSING_LANGUAGE)
        .describe(
          'What an address in a language the release does not have opens: `picker`, a page listing the languages it has, or `source`, the manual in the source language. Left out: `picker`.',
        ),
      pdfQrCode: z
        .enum(PDF_QR_CODE)
        .default(DEFAULT_PDF_QR_CODE)
        .describe(
          'Where a release’s PDF prints the QR code of its stable address: `none`, on the `title-page`, or on a `back-cover` page of its own at the end. Printed only when the addresses are `public` (after the installation’s cap) and the installation’s public URL is set. Left out: `none`.',
        ),
      manuals: z
        .record(
          ModuleId,
          object({
            slug: ModuleId.optional().describe(
              'The manual’s segment in its address, a lowercase slug, e.g. `operating` in `/d/north/operating/…`; no two manuals share one. Left out: the manual’s ID.',
            ),
            formerly: z
              .array(ModuleId)
              .max(MAX_FORMER_ADDRESSES)
              .refine(
                (ids) => new Set(ids).size === ids.length,
                'duplicate former address',
              )
              .default([])
              .describe(
                `Segments the manual had before, at most ${MAX_FORMER_ADDRESSES}, e.g. \`[user-guide]\`: an address with one leads to the current one, and a release made before the rename holds the manual under it. None may be another manual’s address. Left out: none.`,
              ),
          }).describe(
            'One manual’s address, by the manual’s ID, e.g. `operating-manual`.',
          ),
        )
        .default({})
        .describe(
          'Per manual ID, its address segment and its former ones. Left out: every manual is addressed by its ID.',
        ),
    })
      .default({
        access: DEFAULT_DELIVERY_ACCESS,
        missingLanguage: DEFAULT_MISSING_LANGUAGE,
        pdfQrCode: DEFAULT_PDF_QR_CODE,
        manuals: {},
      })
      .describe(
        'The stable addresses that open a product’s latest released manual, for links and QR codes. Left out: every default.',
      ),
    /**
     * The iiRDS export (#431): how the project's module types, audiences,
     * facets and variant attributes map to the iiRDS vocabulary, and the
     * base IRI of the package's own IRIs. Optional: without it, releases
     * are not exported as iiRDS packages.
     */
    iirds: iirdsMappingSchema(object)
      .optional()
      .describe(
        'The iiRDS export: how module types, audiences, facets and variant attributes map to the iiRDS vocabulary, by the standard’s names. Left out: releases are not exported as iiRDS packages.',
      ),
    /**
     * The DITA import (#432): which topic types, output classes, profiling
     * attributes and values, keys and hazard symbols become which module
     * types, variant attributes, audience levels, text attributes and
     * safety symbols. Optional: without it, the import's defaults.
     */
    dita: ditaMappingSchema(object)
      .optional()
      .describe(
        'The DITA 1.3 import: which topic types, output classes, profiling attributes, keys and hazard symbols become which module types, variant attributes, audience levels, text attributes and safety symbols. Keys are DITA names, values the project’s IDs. Left out: the import’s defaults (names matched by the same IDs).',
      ),
  })
    .refine((c) => !c.languages.targets.includes(c.languages.source), {
      message: 'source language must not also be a target',
      path: ['languages', 'targets'],
    })
    .superRefine((c, ctx) => {
      // A label written per language needs the source language's, which every other falls back
      // to (#731). Only refused when a configuration is stored: a file read keeps working.
      if (!strict) return;
      for (const { key, text } of configTexts(c)) {
        if (sourceTextOf(text, c.languages.source) === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `the label of ${key} has no version in the source language "${c.languages.source}"`,
            path: key.split('.'),
          });
        }
      }
    })
    .refine(
      (c) =>
        c.release?.productFacet === undefined ||
        c.facets.some((f) => f.id === c.release?.productFacet),
      {
        message: 'release.productFacet must name a configured facet',
        path: ['release', 'productFacet'],
      },
    )
    .refine(
      (c) =>
        Object.keys(c.styleRules ?? {}).every(
          (tag) =>
            tag === c.languages.source || c.languages.targets.includes(tag),
        ),
      {
        message: 'styleRules: each language must be a configured one',
        path: ['styleRules'],
      },
    )
    .refine(
      (c) =>
        c.delivery.publicAudience === undefined ||
        c.audiences.some((a) => a.id === c.delivery.publicAudience),
      {
        message: 'delivery.publicAudience must name a configured audience',
        path: ['delivery', 'publicAudience'],
      },
    )
    .refine((c) => uniqueAddresses(c.delivery.manuals), {
      message:
        'delivery.manuals: each address (a slug, or a former address) names one manual only',
      path: ['delivery', 'manuals'],
    });
  return { config, VariantAttribute };
}

const lenient = configSchema(z.object, false);

export const VariantAttribute = lenient.VariantAttribute;
export type VariantAttribute = z.infer<typeof VariantAttribute>;

/** The project configuration as `openfolia.yaml` holds it; unknown keys are dropped. */
export const ProjectConfig = lenient.config;
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** The manufacturer's details (#395, `manufacturer`): a name, the address lines, contact, website. */
export type Manufacturer = NonNullable<ProjectConfig['manufacturer']>;

/**
 * `ProjectConfig` refusing unknown keys at every level: for a configuration
 * sent to be stored, so a misspelt key is an error rather than silently
 * dropped. The same output type.
 */
export const StrictProjectConfig = configSchema(
  // The strict constructor builds the same shapes; only unknown keys differ.
  z.strictObject as unknown as typeof z.object,
  true,
).config;
