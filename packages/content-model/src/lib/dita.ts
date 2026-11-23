import { z } from 'zod';
import { ConfigKey } from './ids.js';

/**
 * DITA (#432), OASIS's Darwin Information Typing Architecture, version 1.3:
 * the names of the standard a project's mapping may use, and the mapping
 * itself (`dita` in `openfolia.yaml`). Which topic type becomes which module type,
 * which profiling attribute and value becomes which variant attribute or
 * audience level, which key is which text attribute: configuration, never
 * code. The DITA import reads it (`@openfolia/dita`); an export can read it
 * backwards (#433).
 */

/** The DITA version the import is made to. */
export const DITA_VERSION = '1.3';

/** The topic types of the OASIS document types (the root element's name), base and technical content. */
export const DITA_TOPIC_TYPES = [
  'topic',
  'concept',
  'task',
  'reference',
  'troubleshooting',
  'glossentry',
  'glossgroup',
] as const;
export type DitaTopicType = (typeof DITA_TOPIC_TYPES)[number];

/** The attributes DITA filters on (DITA 1.3, 2.4.3.1); `@rev` only flags. */
export const DITA_FILTER_ATTRIBUTES = [
  'audience',
  'platform',
  'product',
  'otherprops',
  'props',
  'deliveryTarget',
] as const;

/** How a DITAVAL file no map names is used: `none` (left out, reported, the default) or `all` (a variant of every manual). */
export const DITAVAL_DEFAULTS = ['none', 'all'] as const;
export type DitavalDefault = (typeof DITAVAL_DEFAULTS)[number];

/** The most entries of one map in the mapping. */
export const MAX_DITA_MAPPING_ENTRIES = 1_000;

/**
 * A DITA name as the mapping keys it: an attribute or group name, a topic
 * type, an `@outputclass` token, a profiling value, a key, a file name.
 * One token: no whitespace, no parentheses, 1 to 200 characters.
 */
export const DitaName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s()]+$/u, 'one token: no whitespace or parentheses');

const tooMany = (record: Record<string, unknown>) =>
  Object.keys(record).length <= MAX_DITA_MAPPING_ENTRIES;

/**
 * The DITA mapping (`dita` in `openfolia.yaml`), its objects made by `object`
 * (`z.object` or `z.strictObject`, as the configuration's). Values name the
 * project's own module types, variant attributes and values, audience
 * levels, text attributes and safety symbols; one naming nothing is
 * reported (`ditaMappingIssues`), never refused, so removing a module type
 * never makes the file unreadable. Every map is optional.
 */
export function ditaMappingSchema(object: typeof z.object) {
  const Values = z
    .record(DitaName, z.string().min(1).max(100))
    .refine(tooMany, 'too many values');
  const Profiling = z
    .union([
      /** Its values become a variant attribute's (by the same IDs unless `values` says otherwise). */
      object({
        variantAttribute: ConfigKey.describe(
          'The ID of the variant attribute the profiling attribute’s values become, e.g. `model`.',
        ),
        values: Values.optional().describe(
          'Per DITA value, the variant attribute’s value it becomes, e.g. `{ basic-unit: basic }`. Left out, or a DITA value not listed: the value of the same ID.',
        ),
      }),
      /** Its values become audience levels (only where a module or manual entry starts). */
      object({
        audience: z
          .record(DitaName, ConfigKey)
          .refine(tooMany, 'too many values')
          .describe(
            'Per DITA value, the audience level’s ID it becomes, e.g. `{ user: operator }`. It applies only where a module or a manual entry starts.',
          ),
      }),
    ])
    .describe(
      'What one profiling attribute’s values become: a variant attribute’s values (`{ variantAttribute, values }`) or audience levels (`{ audience }`).',
    );
  const map = (what: string, sample: string, fallback: string) =>
    `${what}, e.g. \`${sample}\`. Keys are DITA names (one token, no whitespace or parentheses), at most ${MAX_DITA_MAPPING_ENTRIES.toLocaleString('en')} entries. Left out, or a name not listed: ${fallback}`;
  return object({
    /** Topic type (the root element: `concept`, `task`, …, or a specialisation's) → module type. */
    moduleTypes: z
      .record(DitaName, ConfigKey)
      .refine(tooMany, 'too many topic types')
      .default({})
      .describe(
        map(
          'Per topic type (a topic’s root element: `concept`, `task`, … or a specialisation’s), the module type its topics become',
          '{ task: procedure }',
          'a configured module type named like the topic type, else `defaultModuleType`.',
        ),
      ),
    /** A token of the topic's `@outputclass` → module type; wins over `moduleTypes`. */
    outputclasses: z
      .record(DitaName, ConfigKey)
      .refine(tooMany, 'too many output classes')
      .default({})
      .describe(
        map(
          'Per token of a topic’s `@outputclass`, the module type its topics become; it wins over `moduleTypes`',
          '{ howto: procedure }',
          '`moduleTypes` decides.',
        ),
      ),
    /** The module type of any other topic; default: a module type named like the topic type, else the first configured. */
    defaultModuleType: ConfigKey.optional().describe(
      'The module type, by ID, of a topic whose type neither `outputclasses`, `moduleTypes` nor a configured module type of the same name gives, e.g. `concept`. Left out: the first configured module type.',
    ),
    /** A profiling attribute (or a group name, `product="appserver(a)"`) → what its values become. */
    profiling: z
      .record(DitaName, Profiling)
      .refine(tooMany, 'too many profiling attributes')
      .default({})
      .describe(
        map(
          'Per profiling attribute (or a group name inside one, `product="unit(basic)"`), what its values become',
          '{ product: { variantAttribute: model } }',
          'a profiling attribute named like a variant attribute maps to it, and `audience` to the audience levels of the same IDs.',
        ),
      ),
    /** A key holding text (`<keydef keys="…"><topicmeta><keywords><keyword>`) → a text attribute. */
    textKeys: z
      .record(DitaName, ConfigKey)
      .refine(tooMany, 'too many keys')
      .default({})
      .describe(
        map(
          'Per key that holds text (`<keydef keys="…">` with a `<keyword>`), the text attribute an empty `<ph keyref="…"/>` becomes',
          '{ prodname: product-name }',
          'a text attribute named like the key, if there is one; any other key is imported as its text.',
        ),
      ),
    /** A `<hazardsymbol>`'s file name (its `@href`'s last segment) or key → a safety symbol. */
    hazardSymbols: z
      .record(DitaName, ConfigKey)
      .refine(tooMany, 'too many hazard symbols')
      .default({})
      .describe(
        map(
          'Per `<hazardsymbol>` file name (its `@href`’s last segment) or key, the safety symbol it becomes',
          '{ hot-surface.svg: hot-surface }',
          'the symbol is left out, and the import reports it.',
        ),
      ),
    /** A DITAVAL file no map names: `none` (left out, the default) or `all` (a variant of every manual). */
    ditavalDefault: z
      .enum(DITAVAL_DEFAULTS)
      .default('none')
      .describe(
        'What becomes of a DITAVAL file no map names: `none`, it is not applied (and reported), or `all`, it becomes a variant of every manual. Left out: `none`.',
      ),
  });
}

/** The DITA mapping as `openfolia.yaml` holds it. */
export const DitaMapping = ditaMappingSchema(z.object);
export type DitaMapping = z.infer<typeof DitaMapping>;
export type DitaProfiling = DitaMapping['profiling'][string];

/** The mapping a project without `dita` imports with: every default. */
export const DEFAULT_DITA_MAPPING: DitaMapping = DitaMapping.parse({});

/** What `ditaMappingIssues` reports: a value of the mapping naming nothing the configuration holds. */
export interface DitaMappingIssue {
  readonly code:
    | 'unknown-module-type'
    | 'unknown-variant-attribute'
    | 'unknown-variant-value'
    | 'unknown-audience'
    | 'unknown-text-attribute'
    | 'unknown-safety-symbol';
  /** Where in `dita`, e.g. `moduleTypes.task`. */
  readonly path: string;
  readonly message: string;
}

/** The parts of the configuration the mapping names. */
export interface DitaMappingTargets {
  readonly moduleTypes: readonly { readonly id: string }[];
  readonly audiences: readonly { readonly id: string }[];
  readonly variantAttributes: readonly (
    | {
        readonly id: string;
        readonly kind: 'enum';
        readonly values: readonly { readonly id: string }[];
      }
    | { readonly id: string; readonly kind: 'version' }
  )[];
  readonly textAttributes: readonly { readonly id: string }[];
  readonly safetySymbols: readonly { readonly id: string }[];
}

const entries = <T>(record: Readonly<Record<string, T>>) =>
  Object.keys(record).map((key) => [key, record[key] as T] as const);

/**
 * Each value of the mapping that names nothing the configuration holds
 * (#432): the import falls back to its default there and lists the issue in
 * its report, and `GET /config` shows them. In the mapping's own order.
 */
export function ditaMappingIssues(
  mapping: DitaMapping,
  config: DitaMappingTargets,
): DitaMappingIssue[] {
  const issues: DitaMappingIssue[] = [];
  const has = (list: readonly { readonly id: string }[], id: string) =>
    list.some((x) => x.id === id);
  const moduleType = (path: string, id: string) => {
    if (!has(config.moduleTypes, id)) {
      issues.push({
        code: 'unknown-module-type',
        path,
        message: `"${id}" is no configured module type.`,
      });
    }
  };
  for (const [key, id] of entries(mapping.moduleTypes)) {
    moduleType(`moduleTypes.${key}`, id);
  }
  for (const [key, id] of entries(mapping.outputclasses)) {
    moduleType(`outputclasses.${key}`, id);
  }
  if (mapping.defaultModuleType !== undefined) {
    moduleType('defaultModuleType', mapping.defaultModuleType);
  }
  for (const [key, target] of entries(mapping.profiling)) {
    if ('audience' in target) {
      for (const [value, id] of entries(target.audience)) {
        if (!has(config.audiences, id)) {
          issues.push({
            code: 'unknown-audience',
            path: `profiling.${key}.audience.${value}`,
            message: `"${id}" is no configured audience level.`,
          });
        }
      }
      continue;
    }
    const attribute = config.variantAttributes.find(
      (a) => a.id === target.variantAttribute,
    );
    if (!attribute) {
      issues.push({
        code: 'unknown-variant-attribute',
        path: `profiling.${key}.variantAttribute`,
        message: `"${target.variantAttribute}" is no configured variant attribute.`,
      });
      continue;
    }
    if (attribute.kind !== 'enum') continue;
    for (const [value, id] of entries(target.values ?? {})) {
      if (!has(attribute.values, id)) {
        issues.push({
          code: 'unknown-variant-value',
          path: `profiling.${key}.values.${value}`,
          message: `"${id}" is no value of the variant attribute "${attribute.id}".`,
        });
      }
    }
  }
  for (const [key, id] of entries(mapping.textKeys)) {
    if (!has(config.textAttributes, id)) {
      issues.push({
        code: 'unknown-text-attribute',
        path: `textKeys.${key}`,
        message: `"${id}" is no configured text attribute.`,
      });
    }
  }
  for (const [key, id] of entries(mapping.hazardSymbols)) {
    if (!has(config.safetySymbols, id)) {
      issues.push({
        code: 'unknown-safety-symbol',
        path: `hazardSymbols.${key}`,
        message: `"${id}" is no configured safety symbol.`,
      });
    }
  }
  return issues;
}
