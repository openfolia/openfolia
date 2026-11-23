import type { ConfigLabelsIn } from '@openfolia/content-model/core';
import type { ContentStatus, TranslationState } from '@openfolia/ui/badges';

import type { Item, Query, Schema } from '../api';
import {
  BADGE_STATE,
  type ApiTranslationState,
} from '../translations/badge-state';
import {
  idParam,
  intParam,
  listParam,
  oneOfParam,
  textParam,
  type QueryValues,
} from '../view-state';
import {
  cleanKeyword,
  KEYWORD_MAX_LENGTH,
  KEYWORDS_MAX,
} from './keyword-field.component';

export type ModuleSummary = Item<'/module-summaries'>;
/** The project's configuration as `GET /config` gives it: a label may be one per language. */
export type StoredConfig = Schema<'ProjectConfig'>;
/**
 * The configuration as a screen shows it (#731): every label one text, in the interface language
 * (`labelsInUi`). Screens that only show labels read this; the project settings edit the stored one.
 */
export type ProjectConfig = ConfigLabelsIn<StoredConfig>;
export type ChangeSetState = Schema<'ChangeSetAttributes'>['state'];

/** The filters of the content browser; undefined is "All". */
export interface BrowserFilters {
  readonly lang?: string | undefined;
  readonly type?: string | undefined;
  readonly audience?: string | undefined;
  /** A value of a configured facet (product line, region, …). */
  readonly facet?: { readonly id: string; readonly value: string } | undefined;
  /** `released`: as on the released branch; `changed`: added or edited in the change set. */
  readonly status?: 'released' | 'changed' | undefined;
  /** Exact keywords (case aside); a module has to have every one. */
  readonly keywords?: readonly string[] | undefined;
  readonly q?: string | undefined;
  /**
   * What is hidden unless asked for: deprecated modules (#266) and deleted ones (#320), the
   * modules deleted on the branch shown, each opening its history.
   */
  readonly show?: readonly Shown[] | undefined;
}

/** What the browser hides unless asked for (`?show=`). */
export const SHOWN = ['deprecated', 'deleted'] as const;
export type Shown = (typeof SHOWN)[number];
const isShown = (v: string): v is Shown =>
  (SHOWN as readonly string[]).includes(v);

export const PAGE_SIZES: readonly number[] = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;

/** A configured key (module type, audience, facet and its values), as the content model has it. */
const CONFIG_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const FACET = /^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/;
const LANG = /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** A keyword as stored (`cleanKeyword`), within the content model's limits. */
const isKeyword = (value: string): boolean =>
  value.length > 0 &&
  value.length <= KEYWORD_MAX_LENGTH &&
  cleanKeyword(value) === value &&
  /^[^,\p{Cc}]+$/u.test(value);

/**
 * The content browser's view state in the address (`injectQueryState`):
 * `?type=procedure&lang=de&keyword=maintenance&q=battery&page=2`. The group on the left is
 * `type` with `facet` (`<facet>:<value>`); `keyword` repeats.
 */
export const BROWSER_PARAMS = {
  q: textParam({ max: 200 }),
  type: idParam(CONFIG_KEY),
  facet: idParam(FACET),
  lang: idParam(LANG),
  audience: idParam(CONFIG_KEY),
  status: oneOfParam(['released', 'changed'] as const),
  keyword: listParam(isKeyword, { max: KEYWORDS_MAX }),
  show: listParam(isShown, { max: SHOWN.length }),
  page: intParam(1),
  size: intParam(DEFAULT_PAGE_SIZE, { only: PAGE_SIZES }),
};
export type BrowserValues = QueryValues<typeof BROWSER_PARAMS>;

/** The filters the address's values stand for. */
export function filtersOf(values: BrowserValues): BrowserFilters {
  const [id = '', value = ''] = values.facet?.split(':') ?? [];
  return {
    lang: values.lang,
    type: values.type,
    audience: values.audience,
    facet: values.facet ? { id, value } : undefined,
    status: values.status,
    keywords: values.keyword.length > 0 ? values.keyword : undefined,
    q: values.q || undefined,
    show: values.show.length > 0 ? values.show.filter(isShown) : undefined,
  };
}

/** The address's values for a change of filters (only those named). */
export function valuesOf(
  change: Partial<BrowserFilters>,
): Partial<BrowserValues> {
  const out: { -readonly [K in keyof BrowserValues]?: BrowserValues[K] } = {};
  if ('lang' in change) out.lang = change.lang;
  if ('type' in change) out.type = change.type;
  if ('audience' in change) out.audience = change.audience;
  if ('facet' in change) {
    out.facet = change.facet
      ? `${change.facet.id}:${change.facet.value}`
      : undefined;
  }
  if ('status' in change) out.status = change.status;
  if ('keywords' in change) out.keyword = change.keywords ?? [];
  if ('q' in change) out.q = change.q ?? '';
  if ('show' in change) out.show = change.show ?? [];
  return out;
}

/**
 * The filters the configuration does not know (a stale or edited link): each to be dropped, as
 * the value that clears it; empty when every filter is known.
 */
export function unknownFilters(
  filters: BrowserFilters,
  config: ProjectConfig,
): Partial<BrowserFilters> {
  const out: { -readonly [K in keyof BrowserFilters]?: BrowserFilters[K] } = {};
  const has = (options: readonly { id: string }[], id: string) =>
    options.some((o) => o.id === id);
  if (filters.type && !has(config.moduleTypes, filters.type)) {
    out.type = undefined;
  }
  if (filters.audience && !has(config.audiences, filters.audience)) {
    out.audience = undefined;
  }
  if (filters.lang && !languagesOf(config).includes(filters.lang)) {
    out.lang = undefined;
  }
  const facet = filters.facet;
  if (
    facet &&
    !config.facets.some((f) => f.id === facet.id && has(f.values, facet.value))
  ) {
    out.facet = undefined;
  }
  return out;
}

/** The `GET /module-summaries` query for the filters and page. */
export function summaryQuery(
  filters: BrowserFilters,
  page: { number: number; size: number },
): Query<'/module-summaries'> {
  const q = filters.q?.trim();
  return {
    'page[number]': page.number,
    'page[size]': page.size,
    ...(filters.lang ? { 'filter[lang]': filters.lang } : {}),
    ...(filters.type ? { 'filter[type]': filters.type } : {}),
    ...(filters.audience ? { 'filter[audience]': filters.audience } : {}),
    ...(filters.facet
      ? { 'filter[facet]': `${filters.facet.id}:${filters.facet.value}` }
      : {}),
    ...(filters.keywords?.length
      ? { 'filter[keyword]': [...filters.keywords] }
      : {}),
    ...(filters.status
      ? { 'filter[changed]': filters.status === 'changed' ? 'true' : 'false' }
      : {}),
    ...(q ? { 'filter[q]': q.slice(0, 200) } : {}),
    // Deprecated modules are left out unless asked for (#266).
    ...(filters.show?.includes('deprecated')
      ? {}
      : { 'filter[deprecated]': 'false' as const }),
    // Deleted ones too (#320): asked for, they join the list.
    ...(filters.show?.includes('deleted')
      ? { 'filter[status]': 'any' as const }
      : {}),
  };
}

/**
 * A module's status: unchanged from the released branch is Released; a module the change set
 * added or edited has the change set's state (Draft, In review, Approved).
 */
export function statusOf(
  changed: boolean,
  changeSet: ChangeSetState | undefined,
): ContentStatus {
  if (!changed || changeSet === undefined) return 'released';
  if (changeSet === 'in-review') return 'in-review';
  if (changeSet === 'approved') return 'approved';
  return 'draft';
}

/** Every configured language: the source first, then the targets. */
export function languagesOf(config: ProjectConfig): string[] {
  const { source, targets } = config.languages;
  return [source, ...targets.filter((t) => t !== source)];
}

/** The translation states of a page's modules (`GET /translations/status`), by module ID, then language. */
export type TranslationStates = ReadonlyMap<
  string,
  ReadonlyMap<string, ApiTranslationState>
>;

/** The states of a page of translation statuses (#694), by module ID and language. */
export function statesOf(
  statuses: readonly {
    readonly attributes: {
      readonly moduleId?: string | undefined;
      readonly lang: string;
      readonly state: ApiTranslationState;
    };
  }[],
): TranslationStates {
  const states = new Map<string, Map<string, ApiTranslationState>>();
  for (const { attributes: a } of statuses) {
    if (a.moduleId === undefined) continue;
    const of = states.get(a.moduleId) ?? new Map<string, ApiTranslationState>();
    of.set(a.lang, a.state);
    states.set(a.moduleId, of);
  }
  return states;
}

/**
 * Per configured language (and any other the module exists in), its translation's state. The
 * source language is up to date where the module exists in it. A target language takes its state
 * from the translation status (`states`, #694): outdated, at the agency, up to date, or not
 * translated. Where the status says nothing (the reader may not read it, it could not be read,
 * or they would see no translation in that language), a version that exists is only
 * `translated`, and one that does not is not translated.
 */
export function translationsOf(
  summary: ModuleSummary,
  config: ProjectConfig,
  states?: TranslationStates,
): { lang: string; state: TranslationState }[] {
  const has = new Set(summary.attributes.languages);
  const configured = languagesOf(config);
  const extra = summary.attributes.languages.filter(
    (l) => !configured.includes(l),
  );
  const known = states?.get(summary.id);
  return [...configured, ...extra].map((lang) => {
    const state = known?.get(lang);
    if (lang !== config.languages.source && state !== undefined) {
      return { lang, state: BADGE_STATE[state] };
    }
    return {
      lang,
      state: !has.has(lang)
        ? 'not-translated'
        : lang === config.languages.source
          ? 'up-to-date'
          : 'translated',
    };
  });
}

/**
 * The label of the audience level a module without an audience counts as: the last, most
 * restricted one (the content model's rule in `resolveManual`, which fails closed; #693).
 */
export function unsetAudienceLevel(
  config: Pick<ProjectConfig, 'audiences'> | null | undefined,
): string {
  return config?.audiences.at(-1)?.label ?? '';
}

/** A configured option's label, else its ID (content configuration is data, not UI text). */
export function labelOf(
  options: readonly { id: string; label: string }[],
  id: string | undefined,
): string {
  if (id === undefined) return '';
  return options.find((o) => o.id === id)?.label ?? id;
}

/**
 * What the module's variant blocks are conditioned on, as labels: `model=large` becomes the
 * value's label ("Large"); a version condition (`software>=2.3`) shows as it is.
 */
export function variantLabels(
  variants: readonly string[],
  config: ProjectConfig,
): string[] {
  return variants.map((v) => {
    const match = /^([a-z][a-z0-9-]*)=(.+)$/.exec(v);
    if (!match) return v;
    const [, attr, value] = match;
    const attribute = config.variantAttributes.find((a) => a.id === attr);
    return attribute?.kind === 'enum'
      ? labelOf(attribute.values, value)
      : (value ?? v);
  });
}

/** One entry of the group tree: a module type, or a facet value under it. */
export interface GroupNode {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly facet?: { readonly id: string; readonly value: string };
  readonly children: readonly GroupNode[];
}

/**
 * The browser's tree. Modules have no folders in the repository, so it groups by module type,
 * then by the values of the first configured facet (the product line, say).
 */
export function groupTree(config: ProjectConfig): GroupNode[] {
  const facet = config.facets[0];
  return config.moduleTypes.map((type) => ({
    key: type.id,
    label: type.label,
    type: type.id,
    children: (facet?.values ?? []).map((value) => ({
      key: `${type.id}/${value.id}`,
      label: value.label,
      type: type.id,
      facet: { id: facet?.id ?? '', value: value.id },
      children: [],
    })),
  }));
}

/** A language's name in the interface language ("Deutsch" in German), else its tag. */
export function languageName(locale: string, lang: string): string {
  try {
    return (
      new Intl.DisplayNames([locale], { type: 'language' }).of(lang) ?? lang
    );
  } catch {
    return lang;
  }
}
