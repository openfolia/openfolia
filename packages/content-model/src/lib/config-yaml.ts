import { parse as parseYaml, stringify } from 'yaml';
import { DEFAULT_CALLOUT_LABEL_MIN_SIZE } from './callouts.js';
import type { DitaMapping } from './dita.js';
import type { IirdsMapping } from './iirds.js';
import {
  DEFAULT_MAX_HEADING_LEVEL,
  DEFAULT_PDF_STANDARD,
  ProjectConfig,
} from './config.js';
import { isConfiguredLanguage } from './direction.js';
import { type LocalizedText, printableText } from './localized-text.js';
import {
  DEFAULT_DELIVERY_ACCESS,
  DEFAULT_MISSING_LANGUAGE,
  DEFAULT_PDF_QR_CODE,
} from './delivery.js';

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigParseError';
  }
}

/** The configuration file (`openfolia.yaml`) as `ProjectConfig`; unknown keys are dropped. */
export function parseConfig(source: string): ProjectConfig {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new ConfigParseError(`invalid YAML: ${(e as Error).message}`);
  }
  const result = ProjectConfig.safeParse(data);
  if (!result.success) {
    throw new ConfigParseError(
      `invalid configuration: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

/** The `languages` part: a direction only for a configured language, sorted by tag. */
function languagesDoc(languages: ProjectConfig['languages']) {
  const direction = Object.entries(languages.direction ?? {})
    .filter(([tag]) => isConfiguredLanguage(languages, tag))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    source: languages.source,
    targets: [...languages.targets],
    ...(direction.length > 0 && { direction: Object.fromEntries(direction) }),
  };
}

/**
 * Prints a configuration as canonical YAML: the schema's key order, what
 * equals a default left out (an empty list, no callout styles, `restricted: false`, `snippet: false`, `safety: false`, an
 * unarchived value, the default heading level, the default PDF standard and callout label size, a direction for a
 * language not configured), output labels and directions sorted by language and key. Comments
 * and the file's own order are not kept: the
 * file is the configuration as stored, so `printConfig(parseConfig(t))`
 * is `t` for every `t` this prints.
 */
export function printConfig(config: ProjectConfig): string {
  const option = ({ id, label }: { id: string; label: LocalizedText }) => ({
    id,
    label: printableText(label),
  });
  const doc: Record<string, unknown> = {
    languages: languagesDoc(config.languages),
    moduleTypes: config.moduleTypes.map((t) => ({
      ...option(t),
      ...(t.restricted && { restricted: true }),
      ...(t.snippet && { snippet: true }),
      ...(t.safety && { safety: true }),
    })),
    audiences: config.audiences.map(option),
  };
  if (config.facets.length > 0) {
    doc['facets'] = config.facets.map((f) => ({
      ...option(f),
      values: f.values.map(option),
    }));
  }
  if (config.variantAttributes.length > 0) {
    doc['variantAttributes'] = config.variantAttributes.map((a) =>
      a.kind === 'enum'
        ? {
            ...option(a),
            kind: a.kind,
            values: a.values.map((v) => ({
              ...option(v),
              ...(v.archived && { archived: true }),
            })),
          }
        : { ...option(a), kind: a.kind },
    );
  }
  if (config.textAttributes.length > 0) {
    doc['textAttributes'] = config.textAttributes.map(option);
  }
  if (config.safetySymbols.length > 0) {
    doc['safetySymbols'] = config.safetySymbols.map(option);
  }
  if (config.calloutStyles?.length) {
    doc['calloutStyles'] = config.calloutStyles.map(option);
  }
  const records = config.translations;
  if (records && Object.keys(records).length > 0) {
    doc['translations'] = Object.fromEntries(
      Object.keys(records)
        .sort()
        .map((lang) => {
          const record = records[lang] as NonNullable<typeof records>[string];
          return [
            lang,
            {
              sourceCommit: record.sourceCommit,
              blocks: Object.fromEntries(
                Object.keys(record.blocks)
                  .sort()
                  .map((k) => [k, record.blocks[k]]),
              ),
            },
          ];
        }),
    );
  }
  const labelLanguages = Object.keys(config.outputLabels).sort();
  if (labelLanguages.length > 0) {
    doc['outputLabels'] = Object.fromEntries(
      labelLanguages.map((lang) => {
        const set = config.outputLabels[lang] ?? {};
        const keys = Object.keys(set).sort() as (keyof typeof set)[];
        return [
          lang,
          Object.fromEntries(
            keys.flatMap((k) => (set[k] === undefined ? [] : [[k, set[k]]])),
          ),
        ];
      }),
    );
  }
  if (config.maxHeadingLevel !== DEFAULT_MAX_HEADING_LEVEL) {
    doc['maxHeadingLevel'] = config.maxHeadingLevel;
  }
  if (config.codeLanguages.length > 0) {
    doc['codeLanguages'] = config.codeLanguages.map(option);
  }
  if (
    config.release?.productFacet !== undefined ||
    config.release?.checkManufacturer === true
  ) {
    doc['release'] = {
      ...(config.release.productFacet !== undefined && {
        productFacet: config.release.productFacet,
      }),
      ...(config.release.checkManufacturer === true && {
        checkManufacturer: true,
      }),
    };
  }
  if (config.manufacturer !== undefined) {
    const m = config.manufacturer;
    doc['manufacturer'] = {
      name: m.name,
      ...(m.address.length > 0 && { address: [...m.address] }),
      ...(m.contact !== undefined && { contact: m.contact }),
      ...(m.website !== undefined && { website: m.website }),
    };
  }
  if (config.styleGuide !== undefined) doc['styleGuide'] = config.styleGuide;
  if (config.terminology?.forbiddenIsBlocking) {
    doc['terminology'] = { forbiddenIsBlocking: true };
  }
  const styleRules = printStyleRules(config.styleRules);
  if (styleRules) doc['styleRules'] = styleRules;
  // Absent: the default, which is never written.
  const minSize =
    config.pdf.calloutLabelMinSize ?? DEFAULT_CALLOUT_LABEL_MIN_SIZE;
  if (
    config.pdf.standard !== DEFAULT_PDF_STANDARD ||
    config.pdf.design !== undefined ||
    minSize !== DEFAULT_CALLOUT_LABEL_MIN_SIZE
  ) {
    doc['pdf'] = {
      ...(config.pdf.standard !== DEFAULT_PDF_STANDARD && {
        standard: config.pdf.standard,
      }),
      ...(config.pdf.design !== undefined && { design: config.pdf.design }),
      ...(minSize !== DEFAULT_CALLOUT_LABEL_MIN_SIZE && {
        calloutLabelMinSize: minSize,
      }),
    };
  }
  const delivery = printDelivery(config.delivery);
  if (delivery) doc['delivery'] = delivery;
  if (config.iirds !== undefined) doc['iirds'] = printIirds(config.iirds);
  if (config.dita !== undefined) doc['dita'] = printDita(config.dita);
  return stringify(doc, { lineWidth: 0 });
}

/**
 * `styleRules` by language tag, sorted, each rule's keys in the schema's order, what is left out
 * left out; a language without a rule or a sentence length is not printed. Undefined when empty.
 */
function printStyleRules(
  styleRules: ProjectConfig['styleRules'] = {},
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const lang of Object.keys(styleRules).sort()) {
    const entry = styleRules[lang];
    if (
      !entry ||
      (entry.maxSentenceWords === undefined && entry.rules.length === 0)
    ) {
      continue;
    }
    out[lang] = {
      ...(entry.maxSentenceWords !== undefined && {
        maxSentenceWords: entry.maxSentenceWords,
      }),
      ...(entry.rules.length > 0 && {
        rules: entry.rules.map((rule) => ({
          id: rule.id,
          ...(rule.words !== undefined && { words: rule.words }),
          ...(rule.pattern !== undefined && { pattern: rule.pattern }),
          ...(rule.matchCase === true && { matchCase: true }),
          message: rule.message,
          ...(rule.replacement !== undefined && {
            replacement: rule.replacement,
          }),
          ...(rule.severity === 'blocking' && { severity: 'blocking' }),
        })),
      }),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `delivery` without its defaults, manuals sorted by ID; undefined when all of it is default. */
function printDelivery(
  delivery: ProjectConfig['delivery'],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (delivery.access !== DEFAULT_DELIVERY_ACCESS) {
    out['access'] = delivery.access;
  }
  if (delivery.publicAudience !== undefined) {
    out['publicAudience'] = delivery.publicAudience;
  }
  if (delivery.missingLanguage !== DEFAULT_MISSING_LANGUAGE) {
    out['missingLanguage'] = delivery.missingLanguage;
  }
  if (delivery.pdfQrCode !== DEFAULT_PDF_QR_CODE) {
    out['pdfQrCode'] = delivery.pdfQrCode;
  }
  const manuals = Object.keys(delivery.manuals)
    .sort()
    .flatMap((id) => {
      const entry = delivery.manuals[id];
      if (!entry || (entry.slug === undefined && entry.formerly.length === 0))
        return [];
      return [
        [
          id,
          {
            ...(entry.slug !== undefined && { slug: entry.slug }),
            ...(entry.formerly.length > 0 && { formerly: [...entry.formerly] }),
          },
        ],
      ];
    });
  if (manuals.length > 0) out['manuals'] = Object.fromEntries(manuals);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A record with its keys sorted, so the same mapping prints the same. */
function sorted<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key] as T]),
  );
}

/** The iiRDS mapping in the schema's key order, maps sorted by key, empty maps left out. */
function printIirds(mapping: IirdsMapping): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    baseIri: mapping.baseIri,
    documentTypes: [...mapping.documentTypes],
  };
  const maps = [
    'manualDocumentTypes',
    'moduleTypes',
    'audiences',
    'facets',
    'variantAttributes',
  ] as const;
  for (const key of maps) {
    const map = mapping[key];
    if (Object.keys(map).length > 0) doc[key] = sorted<unknown>(map);
  }
  if (mapping.lifecyclePhases !== undefined) {
    doc['lifecyclePhases'] = {
      facet: mapping.lifecyclePhases.facet,
      values: sorted(mapping.lifecyclePhases.values),
    };
  }
  return doc;
}

/** The DITA mapping in the schema's key order, maps sorted by key, empty maps and the default left out. */
function printDita(mapping: DitaMapping): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const key of ['moduleTypes', 'outputclasses'] as const) {
    if (Object.keys(mapping[key]).length > 0) doc[key] = sorted(mapping[key]);
  }
  if (mapping.defaultModuleType !== undefined) {
    doc['defaultModuleType'] = mapping.defaultModuleType;
  }
  const profiling = Object.keys(mapping.profiling).sort();
  if (profiling.length > 0) {
    doc['profiling'] = Object.fromEntries(
      profiling.map((key) => {
        const target = mapping.profiling[
          key
        ] as DitaMapping['profiling'][string];
        return [
          key,
          'audience' in target
            ? { audience: sorted(target.audience) }
            : {
                variantAttribute: target.variantAttribute,
                ...(target.values !== undefined &&
                  Object.keys(target.values).length > 0 && {
                    values: sorted(target.values),
                  }),
              },
        ];
      }),
    );
  }
  for (const key of ['textKeys', 'hazardSymbols'] as const) {
    if (Object.keys(mapping[key]).length > 0) doc[key] = sorted(mapping[key]);
  }
  if (mapping.ditavalDefault !== 'none') {
    doc['ditavalDefault'] = mapping.ditavalDefault;
  }
  return doc;
}
