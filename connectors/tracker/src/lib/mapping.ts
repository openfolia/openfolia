import {
  ConfigKey,
  LanguageTag,
  ModuleId,
  SingleLine,
} from '@openfolia/content-model';
import { WikiMapping } from '@openfolia/connector-wiki-markup';
import { z } from 'zod';

/**
 * Where a value comes from: `kind`, `state`, `labels` or `fields.<name>`.
 * A list field gives each of its values.
 */
const FieldPath = z
  .string()
  .regex(
    /^(kind|state|labels|fields\.[^\s]+)$/,
    'kind, state, labels or fields.<name>',
  );

/** A source field mapped onto configured values: source value → target value. */
const ValueMapping = z.strictObject({
  from: FieldPath,
  values: z.record(z.string(), ConfigKey),
  /** When no value of the field is mapped. */
  default: ConfigKey.optional(),
});
export type ValueMapping = z.output<typeof ValueMapping>;

/**
 * How items map onto modules of the target: which items, their module IDs,
 * types, audiences, facets, and the variants a manual shows them in. Every
 * configured value here (types, audiences, facets, variant attributes) is
 * one the target's `openfolia.yaml` names; the bundle is checked against it
 * before anything is written. Nothing about a particular tracker is built
 * in.
 */
export const TrackerMapping = z.strictObject({
  /** The source system's name, for `meta.source` and the import's report. */
  system: SingleLine.max(200).default('Issue tracker'),
  language: LanguageTag,
  /** Which items: each list, when given, must hold the item's value (labels: any of them). */
  include: z
    .strictObject({
      kinds: z.array(z.string().min(1)).optional(),
      states: z.array(z.string().min(1)).optional(),
      labels: z.array(z.string().min(1)).optional(),
    })
    .default({}),
  module: z.strictObject({
    /** The module ID: a template of `{id}`, `{kind}` or `{fields.<name>}`, made a slug. */
    id: z.string().min(1).max(100).default('{id}'),
    type: ConfigKey,
    /** A fixed audience, or one mapped from a field (the first mapped value). */
    audience: z.union([ConfigKey, ValueMapping]).optional(),
    /** Facet → its values, fixed or mapped from a field. */
    facets: z
      .record(ConfigKey, z.union([z.array(ConfigKey).min(1), ValueMapping]))
      .default({}),
    /** Keywords from a field (unmapped, as written; at most 32 of at most 64 characters). */
    keywords: z.strictObject({ from: FieldPath }).optional(),
  }),
  /** How the description's markup is converted (the wiki converter's settings, less what is per page). */
  markup: WikiMapping.pick({
    admonitions: true,
    safety: true,
    containers: true,
    orderedLists: true,
  })
    .partial()
    .default({}),
  /** A manual listing every imported item's module. */
  manual: z
    .strictObject({
      id: ModuleId,
      title: SingleLine.max(200),
      audience: ConfigKey.optional(),
      variants: z.array(z.record(ConfigKey, z.string().min(1))).min(1),
      /**
       * The variants an item's module shows in: a variant attribute and
       * its values mapped from a field. An item with none of them mapped
       * shows in every variant.
       */
      showIn: z
        .strictObject({
          attribute: ConfigKey,
          from: FieldPath,
          values: z.record(z.string(), z.string().min(1)),
        })
        .optional(),
    })
    .optional(),
  /** What happens to the change set the import makes. */
  changeSet: z
    .strictObject({
      /** Submitted for review (the default); else left as a draft for its reviewer to submit. */
      submit: z.boolean().default(true),
      comment: z
        .string()
        .min(1)
        .max(2_000)
        .default(
          'Imported by the tracker connector. Review before it is merged.',
        ),
    })
    .default({
      submit: true,
      comment: 'Imported by the tracker connector. Review before it is merged.',
    }),
});
export type TrackerMapping = z.output<typeof TrackerMapping>;
export type TrackerMappingInput = z.input<typeof TrackerMapping>;
