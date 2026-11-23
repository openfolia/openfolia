import {
  ConfigKey,
  LanguageTag,
  ModuleId,
  SAFETY_SEVERITIES,
  SingleLine,
} from '@openfolia/content-model';
import { z } from 'zod';

/** A macro's name as written in the markup (`info`, `expand`), compared ignoring case. */
const MacroName = z
  .string()
  .regex(/^[A-Za-z][\w-]*$/, 'a macro name, e.g. "info"')
  .transform((name) => name.toLowerCase());

const Facets = z.record(ConfigKey, z.array(ConfigKey).min(1));

/** What a page label sets on the module of a page carrying it. */
const LabelMapping = z.strictObject({
  type: ConfigKey.optional(),
  audience: ConfigKey.optional(),
  facets: Facets.optional(),
});

/**
 * How pages of the markup map onto the target's configuration: every module
 * type, audience, facet and safety symbol here is one the target configures
 * (`openfolia.yaml`), checked when the bundle is validated. Nothing about the
 * target is built in.
 */
export const WikiMapping = z.strictObject({
  /** The source system's name, for `source.system` and each module's `meta.source`. */
  system: SingleLine.max(200).default('Wiki'),
  /** The pages' language (a BCP 47 tag, the target's source language or one of its targets). */
  language: LanguageTag,
  /** The module type of every page (a label may set another). */
  moduleType: ConfigKey,
  /** The audience of every page, if any (a label may set another). */
  audience: ConfigKey.optional(),
  /** Facet values of every page; a label's are added. */
  facets: Facets.default({}),
  /** Page label → what it sets. A label not named here is reported, unless `labelsAsKeywords`. */
  labels: z.record(z.string().min(1), LabelMapping).default({}),
  /** Labels the mapping does not name become the module's keywords (default: reported, not used). */
  labelsAsKeywords: z.boolean().default(false),
  /** Module IDs from the page's source ID (stable, the default) or its title; with an optional prefix. */
  moduleIds: z
    .strictObject({
      from: z.enum(['id', 'title']).default('id'),
      prefix: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a lowercase slug')
        .max(40)
        .optional(),
    })
    .default({ from: 'id' }),
  /** Numbered lists at the top of a page or section as lists (the default) or as procedures. */
  orderedLists: z.enum(['list', 'procedure']).default('list'),
  /** Block macro → the admonition it becomes. */
  admonitions: z
    .record(MacroName, z.enum(['note', 'tip', 'important']))
    .default({
      info: 'note',
      tip: 'tip',
      note: 'important',
      warning: 'important',
    }),
  /** Block macro → the safety notice it becomes (wins over `admonitions`); its `title=` is the hazard. */
  safety: z
    .record(
      MacroName,
      z.strictObject({
        severity: z.enum(SAFETY_SEVERITIES),
        symbols: z.array(ConfigKey).default([]),
      }),
    )
    .default({}),
  /** Block macros whose content is converted and whose frame is left out (and reported). */
  containers: z
    .array(MacroName)
    .default(['panel', 'expand', 'section', 'column', 'details']),
  /** One manual holding every page, in the order given. */
  manual: z
    .strictObject({
      id: ModuleId,
      title: SingleLine.max(200),
      audience: ConfigKey.optional(),
      /** The variant combinations it ships for (default one, with no variant attribute set). */
      variants: z
        .array(z.record(ConfigKey, z.string().min(1)))
        .min(1)
        .default([{}]),
    })
    .optional(),
});
export type WikiMapping = z.output<typeof WikiMapping>;
export type WikiMappingInput = z.input<typeof WikiMapping>;
