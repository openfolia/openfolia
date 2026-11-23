// The full entry, with zod: this file validates the configuration with its schema before saving at run time.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { productFacet, StrictProjectConfig } from '@openfolia/content-model';

import {
  type ConfigLabelsIn,
  type LocalizedText,
  sourceTextOf,
} from '@openfolia/content-model/core';

import type { Schema } from '../../api';

/** The project configuration (`openfolia.yaml`) as the API reads it. */
export type ProjectConfig = Schema<'ProjectConfig'>;
export type ConfigUsageKind =
  Schema<'ConfigUsageResource'>['attributes']['kind'];
export type VariantAttribute = ProjectConfig['variantAttributes'][number];
/** A variant attribute with its labels one text each (#731, `labelsIn`): as a list shows it. */
export type ShownVariantAttribute =
  ConfigLabelsIn<ProjectConfig>['variantAttributes'][number];
export type EnumAttribute = Extract<VariantAttribute, { kind: 'enum' }>;

/** The lists of `{ id, label }` options the settings edit with the same form. */
export type OptionListKey =
  | 'moduleTypes'
  | 'audiences'
  | 'textAttributes'
  | 'safetySymbols'
  | 'codeLanguages';

/** An option of one of those lists (a module type may be restricted, or hold snippets). */
export interface ConfigOption {
  readonly id: string;
  /** One text, or one per language (#731; a code language's: always one). */
  readonly label: LocalizedText;
  readonly restricted?: boolean;
  readonly snippet?: boolean;
  /** A safety type (#451), which a derived manual gathers by default; kept as the file has it. */
  readonly safety?: boolean;
}

/** A configuration key: lowercase, a letter first (`ConfigKey` in the content model). */
export const CONFIG_KEY = /^[a-z][a-z0-9-]*$/;
/** A code language's word (`Token`): what a code block stores. */
export const CODE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9+#._-]*$/;
/** A BCP 47 tag as the content model takes it. */
export const LANGUAGE_TAG = /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const KEY_MAX = 64;
export const CODE_LANGUAGE_MAX = 32;
export const LABEL_MAX = 200;

/** The ID a label suggests: lowercase words joined by hyphens, a letter first. */
export function keyFromLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, KEY_MAX)
    .replace(/-+$/, '');
}

/** Why a new option's ID cannot be taken (a translation key), or null. */
export function idProblem(
  list:
    | OptionListKey
    | 'facets'
    | 'facetValues'
    | 'variantAttributes'
    | 'variantValues',
  id: string,
  taken: readonly string[],
): string | null {
  if (id === '') return 'editor.admin.settings.problems.idRequired';
  if (list === 'codeLanguages') {
    if (id.length > CODE_LANGUAGE_MAX || !CODE_LANGUAGE.test(id)) {
      return 'editor.admin.settings.problems.codeLanguageId';
    }
  } else if (id.length > KEY_MAX || !CONFIG_KEY.test(id)) {
    return 'editor.admin.settings.problems.key';
  }
  if (list === 'textAttributes' && id === 'empty') {
    return 'editor.admin.settings.problems.reserved';
  }
  // The picker matches code languages whatever their case.
  const same = (t: string) =>
    list === 'codeLanguages' ? t.toLowerCase() === id.toLowerCase() : t === id;
  if (taken.some(same)) return 'editor.admin.settings.problems.taken';
  return null;
}

/** Why a label cannot be used (a translation key), or null. */
export function labelProblem(label: string): string | null {
  if (label.trim() === '')
    return 'editor.admin.settings.problems.labelRequired';
  if (label.length > LABEL_MAX)
    return 'editor.admin.settings.problems.labelLong';
  return null;
}

/** Why a language tag cannot be added (a translation key), or null. */
export function languageProblem(
  tag: string,
  config: ProjectConfig,
): string | null {
  if (tag === '') return 'editor.admin.settings.problems.languageRequired';
  if (!LANGUAGE_TAG.test(tag))
    return 'editor.admin.settings.problems.languageTag';
  const known = [config.languages.source, ...config.languages.targets];
  if (known.some((l) => l.toLowerCase() === tag.toLowerCase())) {
    return 'editor.admin.settings.problems.languageTaken';
  }
  return null;
}

/**
 * Whether `config` is one the API would store, by the content model's own schema: the problem's
 * path and message (for developers), or null. The forms keep to it; this is the last guard.
 */
export function configProblem(config: ProjectConfig): string | null {
  const result = StrictProjectConfig.safeParse(config);
  if (result.success) return null;
  const issue = result.error.issues[0];
  return issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid';
}

// --- Changes. Each returns a new configuration and leaves the one given alone. ---

export function setOptions(
  config: ProjectConfig,
  key: OptionListKey,
  options: readonly ConfigOption[],
): ProjectConfig {
  const next = options.map((o) =>
    key === 'moduleTypes'
      ? {
          id: o.id,
          label: o.label,
          restricted: o.restricted ?? false,
          snippet: o.snippet ?? false,
          ...(o.safety && { safety: true }),
        }
      : { id: o.id, label: o.label },
  );
  return { ...config, [key]: next } as ProjectConfig;
}

/** A label in the source language, as the settings name an option (#731). */
export function sourceLabel(
  config: Pick<ProjectConfig, 'languages'>,
  label: LocalizedText,
): string {
  return typeof label === 'string'
    ? label
    : (sourceTextOf(label, config.languages.source) ??
        Object.values(label)[0] ??
        '');
}

export function optionsOf(
  config: ProjectConfig,
  key: OptionListKey,
): readonly ConfigOption[] {
  return config[key];
}

export function setSource(config: ProjectConfig, tag: string): ProjectConfig {
  const { source, targets } = config.languages;
  if (tag === source || !targets.includes(tag)) return config;
  // The old source becomes a target where the new one was: nothing is taken away.
  return {
    ...config,
    languages: {
      ...config.languages,
      source: tag,
      targets: targets.map((t) => (t === tag ? source : t)),
    },
  };
}

export function setTargets(
  config: ProjectConfig,
  targets: readonly string[],
): ProjectConfig {
  const { source, direction } = config.languages;
  // A language taken away takes its direction with it (#458).
  const kept = new Set([source, ...targets]);
  const directions = Object.entries(direction ?? {}).filter(([tag]) =>
    kept.has(tag),
  );
  return {
    ...config,
    languages: {
      source,
      targets: [...targets],
      ...(directions.length > 0 && {
        direction: Object.fromEntries(directions),
      }),
    },
  };
}

export function setFacets(
  config: ProjectConfig,
  facets: readonly ProjectConfig['facets'][number][],
): ProjectConfig {
  const next: ProjectConfig = {
    ...config,
    facets: facets.map((f) => ({ ...f, values: [...f.values] })),
  };
  // Without `release.productFacet` the first facet names the releases' products: a new first
  // facet would silently change what releases are cut for, so the old one is named instead.
  const product = productFacet(config);
  if (
    config.release?.productFacet === undefined &&
    product !== undefined &&
    next.facets[0]?.id !== product.id &&
    next.facets.some((f) => f.id === product.id)
  ) {
    return {
      ...next,
      release: { ...config.release, productFacet: product.id },
    };
  }
  return next;
}

/** Whether a facet names the products releases are cut for (it cannot be removed). */
export function isProductFacet(
  config: ProjectConfig,
  facetId: string,
): boolean {
  return productFacet(config)?.id === facetId;
}

export function setVariantAttributes(
  config: ProjectConfig,
  attributes: readonly VariantAttribute[],
): ProjectConfig {
  return { ...config, variantAttributes: [...attributes] };
}

/** One output label of one language; empty: back to the shipped default. */
export function setOutputLabel(
  config: ProjectConfig,
  lang: string,
  key: string,
  value: string,
): ProjectConfig {
  const set: Record<string, string | undefined> = {
    ...(config.outputLabels[lang] ?? {}),
  };
  const text = value.trim();
  if (text === '') delete set[key];
  else set[key] = text;
  const labels: Record<string, Record<string, string | undefined>> = {
    ...config.outputLabels,
  };
  if (Object.values(set).some((v) => v !== undefined)) labels[lang] = set;
  else delete labels[lang];
  return { ...config, outputLabels: labels } as ProjectConfig;
}

export function setMaxHeadingLevel(
  config: ProjectConfig,
  level: number,
): ProjectConfig {
  return { ...config, maxHeadingLevel: level };
}

// --- The manufacturer (#395). ---

/** The longest line of the manufacturer's details, and the most address lines (the schema's). */
export const MANUFACTURER_LINE_MAX = 200;
export const MANUFACTURER_ADDRESS_LINES = 10;

/** The manufacturer's details as the settings form holds them: text, the address one line per row. */
export interface ManufacturerForm {
  readonly name: string;
  readonly address: string;
  readonly contact: string;
  readonly website: string;
}

/** The configuration's manufacturer details as the form shows them; all empty for none. */
export function manufacturerForm(config: ProjectConfig): ManufacturerForm {
  const m = config.manufacturer;
  return {
    name: m?.name ?? '',
    address: (m?.address ?? []).join('\n'),
    contact: m?.contact ?? '',
    website: m?.website ?? '',
  };
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
const addressLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map(oneLine)
    .filter((line) => line !== '');

/**
 * Why the form's details cannot be saved (a translation key), or null: a name is needed once
 * anything is filled in, each line keeps to `MANUFACTURER_LINE_MAX`, the address to
 * `MANUFACTURER_ADDRESS_LINES` lines, the website is an absolute `https:`, `http:` or `mailto:`
 * address (`LinkHref`).
 */
export function manufacturerProblem(form: ManufacturerForm): string | null {
  const name = oneLine(form.name);
  const address = addressLines(form.address);
  const contact = oneLine(form.contact);
  const website = form.website.trim();
  const any = name || address.length > 0 || contact || website;
  if (any && !name) return 'editor.admin.settings.manufacturer.problems.name';
  if (
    [name, contact, ...address].some((l) => l.length > MANUFACTURER_LINE_MAX)
  ) {
    return 'editor.admin.settings.manufacturer.problems.tooLong';
  }
  if (address.length > MANUFACTURER_ADDRESS_LINES) {
    return 'editor.admin.settings.manufacturer.problems.address';
  }
  if (website && !isLink(website)) {
    return 'editor.admin.settings.manufacturer.problems.website';
  }
  return null;
}

/** An absolute `https:`/`http:` address with a host, or a `mailto:` one, as `LinkHref` takes it. */
function isLink(href: string): boolean {
  if (href.length > 2000 || /[\s[\]|\\\p{Cc}\p{Cf}]/u.test(href)) return false;
  if (/^mailto:\S+$/i.test(href)) return true;
  if (!/^https?:\/\/[^/]/i.test(href)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** The configuration with the form's details (none when the form is empty); check it first. */
export function setManufacturer(
  config: ProjectConfig,
  form: ManufacturerForm,
): ProjectConfig {
  const next = { ...config };
  const name = oneLine(form.name);
  if (!name) {
    delete next.manufacturer;
    return next;
  }
  const contact = oneLine(form.contact);
  const website = form.website.trim();
  next.manufacturer = {
    name,
    address: addressLines(form.address),
    ...(contact && { contact }),
    ...(website && { website }),
  };
  return next;
}

/** The configuration with the manufacturer check on or off (`release.checkManufacturer`). */
export function setCheckManufacturer(
  config: ProjectConfig,
  on: boolean,
): ProjectConfig {
  const release = { ...config.release };
  if (on) release.checkManufacturer = true;
  else delete release.checkManufacturer;
  const next = { ...config };
  if (Object.keys(release).length > 0) next.release = release;
  else delete next.release;
  return next;
}

// --- Usage. ---

/** A configured value as the usage counts name it (`GET /config/usages`). */
export interface ValueRef {
  readonly kind: ConfigUsageKind;
  readonly valueId: string;
  readonly parentId?: string | undefined;
}

export const usageKey = ({ kind, valueId, parentId }: ValueRef): string =>
  parentId === undefined
    ? `${kind}/${valueId}`
    : `${kind}/${parentId}/${valueId}`;

/** How much content names a value: modules (by ID) and manuals. */
export interface UsageCount {
  readonly modules: number;
  readonly manuals: number;
}

/** The content browser's filter showing the modules that use a value, when it has one. */
export function contentFilter(ref: ValueRef): Record<string, string> | null {
  switch (ref.kind) {
    case 'language':
      return { lang: ref.valueId };
    case 'moduleType':
      return { type: ref.valueId };
    case 'audience':
      return { audience: ref.valueId };
    case 'facetValue':
      return ref.parentId === undefined
        ? null
        : { facet: `${ref.parentId}:${ref.valueId}` };
    default:
      return null;
  }
}

/** Where content uses what a refused change takes away: one `config-in-use` error each. */
export interface UsagePlace {
  readonly subject:
    | {
        readonly type: 'module';
        readonly lang: string;
        readonly moduleId: string;
      }
    | { readonly type: 'manual'; readonly manualId: string }
    | { readonly type: 'term'; readonly termId: string };
  /** The validation code (`unknown-audience`, …). */
  readonly issue: string;
  /** The block it is in, when it is in one. */
  readonly at?: string | undefined;
  /** Its title, where the place is known by one (the Variants tab's usage list); else its ID shows. */
  readonly title?: string | undefined;
}

/** The places a `config-in-use` refusal lists (its error objects' `meta`). */
export function usagePlaces(
  errors: readonly { code?: string; meta?: Record<string, unknown> | null }[],
): UsagePlace[] {
  const places: UsagePlace[] = [];
  for (const error of errors) {
    if (error.code !== 'config-in-use' || !error.meta) continue;
    const subject = error.meta['subject'] as
      Record<string, unknown> | undefined;
    const issue = error.meta['issue'];
    const at = error.meta['at'];
    if (!subject || typeof issue !== 'string') continue;
    const place = (s: UsagePlace['subject']): UsagePlace => ({
      subject: s,
      issue,
      ...(typeof at === 'string' && { at }),
    });
    if (
      subject['type'] === 'module' &&
      typeof subject['lang'] === 'string' &&
      typeof subject['moduleId'] === 'string'
    ) {
      places.push(
        place({
          type: 'module',
          lang: subject['lang'],
          moduleId: subject['moduleId'],
        }),
      );
    } else if (
      subject['type'] === 'manual' &&
      typeof subject['manualId'] === 'string'
    ) {
      places.push(place({ type: 'manual', manualId: subject['manualId'] }));
    } else if (
      subject['type'] === 'term' &&
      typeof subject['termId'] === 'string'
    ) {
      places.push(place({ type: 'term', termId: subject['termId'] }));
    }
  }
  return places;
}

/** The text naming what a usage check found (a translation key per validation code). */
export const ISSUE_TEXTS: Readonly<Record<string, string>> = {
  'unknown-module-type': 'editor.admin.settings.inUse.issues.moduleType',
  'unknown-audience': 'editor.admin.settings.inUse.issues.audience',
  'unknown-language': 'editor.admin.settings.inUse.issues.language',
  'unknown-facet': 'editor.admin.settings.inUse.issues.facet',
  'unknown-facet-value': 'editor.admin.settings.inUse.issues.facetValue',
  'unknown-safety-symbol': 'editor.admin.settings.inUse.issues.safetySymbol',
  'unknown-text-attribute': 'editor.admin.settings.inUse.issues.textAttribute',
  'unknown-variant-attribute':
    'editor.admin.settings.inUse.issues.variantAttribute',
  'unknown-variant-value': 'editor.admin.settings.inUse.issues.variantValue',
  'version-compare-on-enum': 'editor.admin.settings.inUse.issues.variantKind',
  'invalid-version-value': 'editor.admin.settings.inUse.issues.variantKind',
};
