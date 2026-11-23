import { z } from 'zod';
import { ConfigKey, ModuleId } from './ids.js';

/**
 * iiRDS (#431), the intelligent information Request and Delivery
 * Standard: the vocabulary a project's mapping may name, and the mapping
 * itself (`iirds` in `openfolia.yaml`). Only the standard's own terms are
 * listed here (iiRDS 1.3, whose core vocabulary is iiRDS 1.2's plus
 * additions none of these lists need); which of the project's module
 * types, audiences, facets and variant attributes map to which of them
 * is configuration, never code.
 */

/** The iiRDS core namespace. */
export const IIRDS_NAMESPACE = 'http://iirds.tekom.de/iirds#';

/** The iiRDS version the packages are made to (`iirds:iiRDSVersion`). */
export const IIRDS_VERSION = '1.3';

/** The standard's topic types (instances of the subclasses of `iirds:TopicType`). */
export const IIRDS_TOPIC_TYPES = [
  'GenericConcept',
  'GenericForm',
  'GenericLearning',
  'GenericReference',
  'GenericTask',
  'GenericTroubleshooting',
] as const;
export type IirdsTopicType = (typeof IIRDS_TOPIC_TYPES)[number];

/** The standard's document types (instances of `iirds:DocumentType`). */
export const IIRDS_DOCUMENT_TYPES = [
  'AdministratorGuide',
  'AssemblyInstructions',
  'BillOfMaterials',
  'CEDeclarationOfConformity',
  'Certificate',
  'ContractualDocument',
  'ElectronicIdentificationPlate',
  'IdentificationDocument',
  'InstallationInstructions',
  'MaintenanceInstructions',
  'OperatingInstructions',
  'PartsCatalog',
  'Plan',
  'QuickGuide',
  'RepairInstructions',
  'SafetyInstructions',
  'SalesCatalog',
  'Specification',
  'TechnicalDrawingDiagram',
  'TransportInstructions',
] as const;
export type IirdsDocumentType = (typeof IIRDS_DOCUMENT_TYPES)[number];

/** The standard's product lifecycle phases (instances of the subclasses of `iirds:ProductLifeCyclePhase`). */
export const IIRDS_LIFECYCLE_PHASES = [
  'Acquisition',
  'Configuration',
  'Decommissioning',
  'Design',
  'Development',
  'Diagnostics',
  'Disposal',
  'EmergencyOperation',
  'Fault',
  'GenericAfterUse',
  'GenericDesignAndRealization',
  'GenericPuttingToUse',
  'GenericUse',
  'Installation',
  'Maintenance',
  'Operation',
  'Production',
  'Repair',
  'RequirementsAnalysis',
] as const;
export type IirdsLifecyclePhase = (typeof IIRDS_LIFECYCLE_PHASES)[number];

/** The standard's information subjects (instances of the subclasses of `iirds:InformationSubject`). */
export const IIRDS_INFORMATION_SUBJECTS = [
  'ApplicableStandards',
  'Caution',
  'ContactInformation',
  'Danger',
  'DeclarationOfConformity',
  'ForeseeableMisuse',
  'GenericCollection',
  'GenericConformity',
  'GenericFormality',
  'GenericFunctionality',
  'GenericProcess',
  'GenericSafety',
  'GenericTechnicalData',
  'GenericTechnicalOverview',
  'GenericWarningMessage',
  'IntendedUse',
  'LegalInformation',
  'LicenceTerm',
  'ManufacturerInformation',
  'Notice',
  'OperatingElement',
  'ProductIdentification',
  'ProductName',
  'RestrictionOnUse',
  'RiskAssessment',
  'SafetyInstruction',
  'ScopeOfDelivery',
  'Symbol',
  'TechnicalReport',
  'WarrantyConditions',
  'Warning',
] as const;
export type IirdsInformationSubject =
  (typeof IIRDS_INFORMATION_SUBJECTS)[number];

/**
 * The product metadata classes a facet or variant attribute maps to: its
 * values become instances of it (docking points of the standard, so the
 * instances are the project's own).
 */
export const IIRDS_PRODUCT_CLASSES = [
  'ProductVariant',
  'Component',
  'ProductFunction',
  'ProductProperty',
] as const;
export type IirdsProductClass = (typeof IIRDS_PRODUCT_CLASSES)[number];

/** The qualification classes an audience level maps to (subclasses of `iirds:Qualification`). */
export const IIRDS_QUALIFICATION_CLASSES = ['Role', 'SkillLevel'] as const;
export type IirdsQualificationClass =
  (typeof IIRDS_QUALIFICATION_CLASSES)[number];

/** The most entries of one list or map in the mapping. */
export const MAX_IIRDS_MAPPING_ENTRIES = 1_000;

/**
 * A base IRI the package's own IRIs are made under: an absolute `http:` or
 * `https:` URL with a host and a path ending in `/`, without query,
 * fragment, user information, whitespace or characters an IRI cannot hold.
 * At most 200 characters.
 */
export function isIirdsBaseIri(value: string): boolean {
  if (value.length > 200 || !value.endsWith('/')) return false;
  // Only printable ASCII an IRI may hold literally (no space, quotes, angle brackets, braces, `\`, `^`, `` ` ``, `|`).
  if (!/^[A-Za-z0-9\-._~:/@!$&'()*+,;=%]+$/.test(value)) return false;
  if (value.includes('?') || value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    // Written as the URL parser would write it, so no `..` or `%2e` segment
    // and no default port or case it would change.
    url.href === value
  );
}

const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

const tooMany = (record: Record<string, unknown>) =>
  Object.keys(record).length <= MAX_IIRDS_MAPPING_ENTRIES;

/**
 * The iiRDS mapping (`iirds` in `openfolia.yaml`), its objects made by `object`
 * (`z.object` or `z.strictObject`, as the configuration's). Keys name the
 * project's own module types, audiences, facets, variant attributes and
 * manuals; a key naming none of them is reported, never refused
 * (`iirdsMappingIssues`), so removing a module type never makes the file
 * unreadable.
 */
export function iirdsMappingSchema(object: typeof z.object) {
  const DocumentTypes = z
    .array(z.enum(IIRDS_DOCUMENT_TYPES))
    .min(1)
    .max(IIRDS_DOCUMENT_TYPES.length)
    .refine(unique, 'duplicate document type');
  const ModuleTypeMapping = z
    .union([
      z.enum(IIRDS_TOPIC_TYPES),
      object({
        topicType: z
          .enum(IIRDS_TOPIC_TYPES)
          .optional()
          .describe(
            'The topic type its modules are, e.g. `GenericConcept`. Left out: the package names none for them.',
          ),
        subjects: z
          .array(z.enum(IIRDS_INFORMATION_SUBJECTS))
          .min(1)
          .max(IIRDS_INFORMATION_SUBJECTS.length)
          .refine(unique, 'duplicate information subject')
          .optional()
          .describe(
            'The information subjects its modules are about, at least one, no repeats, e.g. `[SafetyInstruction]`. Left out: none.',
          ),
      }).refine(
        (m) => m.topicType !== undefined || m.subjects !== undefined,
        'a topic type, information subjects or both',
      ),
    ])
    .describe(
      'One module type’s mapping, by the module type’s ID: its topic type alone (`task: GenericTask`), or `{ topicType, subjects }` with either or both (`safety: { topicType: GenericConcept, subjects: [SafetyInstruction] }`).',
    );
  const unmapped =
    'One the mapping leaves out has no such metadata in the package, and the export warns.';
  return object({
    /** Where the package's own IRIs live: `<baseIri>releases/<release>/…`, `<baseIri>modules/<module>`, … */
    baseIri: z
      .string()
      .refine(
        isIirdsBaseIri,
        'an absolute http or https IRI ending in "/", without query or fragment',
      )
      .describe(
        'Where the package’s own IRIs are made (`<baseIri>releases/<release>/…`, `<baseIri>modules/<module>`): an absolute `http` or `https` IRI ending in `/`, without query, fragment or user information, at most 200 characters, e.g. `https://docs.example.com/iirds/`.',
      ),
    /** The document types of every manual (at least one, as iiRDS requires), unless `manualDocumentTypes` names its own. */
    documentTypes: DocumentTypes.describe(
      'The document types of every manual, at least one as iiRDS requires, no repeats, e.g. `[OperatingInstructions]`; a manual listed in `manualDocumentTypes` takes its own instead.',
    ),
    /** Per manual (by ID), its own document types. */
    manualDocumentTypes: z
      .record(
        ModuleId,
        DocumentTypes.describe(
          'One manual’s document types, by the manual’s ID, e.g. `service-manual: [MaintenanceInstructions]`.',
        ),
      )
      .refine(tooMany, 'too many manuals')
      .default({})
      .describe(
        `Per manual ID, document types replacing \`documentTypes\` for that manual. At most ${MAX_IIRDS_MAPPING_ENTRIES.toLocaleString('en')} manuals. Left out: every manual has \`documentTypes\`.`,
      ),
    /** Per module type: its topic type, or `{ topicType?, subjects? }`. */
    moduleTypes: z
      .record(ConfigKey, ModuleTypeMapping)
      .refine(tooMany, 'too many module types')
      .default({})
      .describe(
        `Per module type ID, the iiRDS topic type and information subjects of its modules. ${unmapped}`,
      ),
    /** Per audience level: the qualification class its instance is (`Role` or `SkillLevel`). */
    audiences: z
      .record(ConfigKey, z.enum(IIRDS_QUALIFICATION_CLASSES))
      .refine(tooMany, 'too many audiences')
      .default({})
      .describe(
        `Per audience level ID, the qualification class it is: \`Role\` or \`SkillLevel\`, e.g. \`{ operator: Role }\`. ${unmapped}`,
      ),
    /** Per facet: the product metadata class its values are instances of. */
    facets: z
      .record(ConfigKey, z.enum(IIRDS_PRODUCT_CLASSES))
      .refine(tooMany, 'too many facets')
      .default({})
      .describe(
        `Per facet ID, the product metadata class its values are: \`ProductVariant\`, \`Component\`, \`ProductFunction\` or \`ProductProperty\`, e.g. \`{ region: ProductVariant }\`. ${unmapped}`,
      ),
    /** Per variant attribute: the product metadata class its values are instances of. */
    variantAttributes: z
      .record(ConfigKey, z.enum(IIRDS_PRODUCT_CLASSES))
      .refine(tooMany, 'too many variant attributes')
      .default({})
      .describe(
        `Per variant attribute ID, the product metadata class its values are, as for \`facets\`, e.g. \`{ model: ProductVariant }\`. ${unmapped}`,
      ),
    /** The facet whose values are product lifecycle phases, and the phase each value is. */
    lifecyclePhases: object({
      facet: ConfigKey.describe(
        'The ID of the facet whose values are lifecycle phases, e.g. `phase`; it must not also be in `facets`.',
      ),
      values: z
        .record(ConfigKey, z.enum(IIRDS_LIFECYCLE_PHASES))
        .refine(tooMany, 'too many values')
        .describe(
          'Per value ID of that facet, the lifecycle phase it is, e.g. `{ use: Operation }`. A value left out has no phase, and the export warns.',
        ),
    })
      .optional()
      .describe(
        'A facet whose values are product lifecycle phases, and the phase each value is. Left out: the package names no lifecycle phases.',
      ),
  }).refine(
    (m) =>
      m.lifecyclePhases === undefined ||
      !Object.hasOwn(m.facets, m.lifecyclePhases.facet),
    {
      message: 'the lifecycle phase facet must not also be mapped in "facets"',
      path: ['lifecyclePhases', 'facet'],
    },
  );
}

/** The iiRDS mapping as `openfolia.yaml` holds it. */
export const IirdsMapping = iirdsMappingSchema(z.object);
export type IirdsMapping = z.infer<typeof IirdsMapping>;

/** A module type's mapping, the short form spelt out. */
export function moduleTypeMapping(
  mapping: IirdsMapping,
  type: string,
):
  | {
      topicType: IirdsTopicType | undefined;
      subjects: readonly IirdsInformationSubject[];
    }
  | undefined {
  if (!Object.hasOwn(mapping.moduleTypes, type)) return undefined;
  const found = mapping.moduleTypes[type];
  if (found === undefined) return undefined;
  if (typeof found === 'string') return { topicType: found, subjects: [] };
  return { topicType: found.topicType, subjects: found.subjects ?? [] };
}

/** What `iirdsMappingIssues` reports: something of the project the mapping leaves out, or a key naming nothing. */
export interface IirdsMappingIssue {
  readonly code:
    | 'unmapped-module-type'
    | 'unmapped-audience'
    | 'unmapped-facet'
    | 'unmapped-variant-attribute'
    | 'unmapped-lifecycle-phase'
    | 'unknown-mapping-key';
  /** Where in `iirds`, e.g. `moduleTypes.task`. */
  readonly path: string;
  readonly message: string;
}

/**
 * What the configuration's iiRDS mapping leaves out (#431): each module
 * type, audience, facet and variant attribute it maps to nothing, each
 * value of the lifecycle phase facet without a phase (a package made
 * then lists them as warnings, and leaves the metadata out), and each key
 * naming nothing the configuration holds. Empty without a mapping (no
 * iiRDS export is configured). The configuration's own order.
 */
export function iirdsMappingIssues(config: {
  readonly moduleTypes: readonly { id: string }[];
  readonly audiences: readonly { id: string }[];
  readonly facets: readonly { id: string; values: readonly { id: string }[] }[];
  readonly variantAttributes: readonly { id: string }[];
  readonly iirds?: IirdsMapping | undefined;
}): IirdsMappingIssue[] {
  const mapping = config.iirds;
  if (!mapping) return [];
  const issues: IirdsMappingIssue[] = [];
  const lifecycle = mapping.lifecyclePhases;
  for (const { id } of config.moduleTypes) {
    if (!Object.hasOwn(mapping.moduleTypes, id)) {
      issues.push({
        code: 'unmapped-module-type',
        path: `moduleTypes.${id}`,
        message: `Module type "${id}" has no iiRDS topic type or subject.`,
      });
    }
  }
  for (const { id } of config.audiences) {
    if (!Object.hasOwn(mapping.audiences, id)) {
      issues.push({
        code: 'unmapped-audience',
        path: `audiences.${id}`,
        message: `Audience "${id}" has no iiRDS qualification class.`,
      });
    }
  }
  for (const facet of config.facets) {
    if (lifecycle?.facet === facet.id) {
      for (const { id } of facet.values) {
        if (!Object.hasOwn(lifecycle.values, id)) {
          issues.push({
            code: 'unmapped-lifecycle-phase',
            path: `lifecyclePhases.values.${id}`,
            message: `Value "${id}" of the lifecycle phase facet "${facet.id}" has no iiRDS lifecycle phase.`,
          });
        }
      }
    } else if (!Object.hasOwn(mapping.facets, facet.id)) {
      issues.push({
        code: 'unmapped-facet',
        path: `facets.${facet.id}`,
        message: `Facet "${facet.id}" has no iiRDS product metadata class.`,
      });
    }
  }
  for (const { id } of config.variantAttributes) {
    if (!Object.hasOwn(mapping.variantAttributes, id)) {
      issues.push({
        code: 'unmapped-variant-attribute',
        path: `variantAttributes.${id}`,
        message: `Variant attribute "${id}" has no iiRDS product metadata class.`,
      });
    }
  }
  const unknown = (
    section: string,
    keys: readonly string[],
    known: readonly { id: string }[],
  ) => {
    for (const key of keys) {
      if (!known.some((k) => k.id === key)) {
        issues.push({
          code: 'unknown-mapping-key',
          path: `${section}.${key}`,
          message: `"${key}" in iirds.${section} names nothing the configuration holds.`,
        });
      }
    }
  };
  unknown('moduleTypes', Object.keys(mapping.moduleTypes), config.moduleTypes);
  unknown('audiences', Object.keys(mapping.audiences), config.audiences);
  unknown('facets', Object.keys(mapping.facets), config.facets);
  unknown(
    'variantAttributes',
    Object.keys(mapping.variantAttributes),
    config.variantAttributes,
  );
  if (lifecycle) {
    const facet = config.facets.find((f) => f.id === lifecycle.facet);
    if (!facet) {
      unknown('lifecyclePhases.facet', [lifecycle.facet], config.facets);
    } else {
      unknown(
        'lifecyclePhases.values',
        Object.keys(lifecycle.values),
        facet.values,
      );
    }
  }
  return issues;
}
