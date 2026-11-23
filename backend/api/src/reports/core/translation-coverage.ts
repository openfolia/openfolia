import type { PageDesign } from '@openfolia/content-model';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  CONFIG_KEY,
  configTranslationStatus,
} from '../../translations/core/config-translations.js';
import {
  designKey,
  designTranslationStatus,
  manualDesignId,
  readDesign,
} from '../../translations/core/design-translations.js';
import {
  manualKey,
  manualTranslationStatus,
} from '../../translations/core/manual-translations.js';
import { unitsAtProvider } from '../../translations/core/statuses.js';
import {
  closure,
  tally,
  type TranslationReads,
} from '../../translations/core/translation-index.js';
import type { TranslationJobs } from '../../translations/core/translation-jobs.js';
import type {
  TranslationState,
  TranslationStatus,
} from '../../translations/core/translation-status.js';

/** How many modules or blocks stand in each translation state. */
export interface CoverageCounts {
  readonly total: number;
  readonly upToDate: number;
  readonly outdated: number;
  readonly atProvider: number;
  readonly missing: number;
}

/** How far one manual is translated into one target language (FR-19). */
export interface TranslationCoverage {
  readonly manualId: string;
  readonly lang: string;
  /** The manual's title. */
  readonly title: string;
  /** The manual is deprecated (#266). */
  readonly deprecated: boolean;
  /**
   * The modules it includes (also through module references) that the
   * reader sees in the source language and would see a translation of in
   * `lang`, each counted once, by its state in the translation status.
   */
  readonly modules: CoverageCounts;
  /** Those modules' translatable blocks, by their state. */
  readonly blocks: CoverageCounts;
  /**
   * The units of the region text of the page design the manual is laid out with (#656), by
   * their state in `lang` (as `GET /translations/status` lists the design); none for the
   * built-in design or one without region text.
   */
  readonly design: CoverageCounts;
  /**
   * The units of the manual's own text, by their state in `lang`: its title and its groups'
   * titles (#731), its cover images' alternative text (#656).
   */
  readonly cover: CoverageCounts;
  /**
   * The units of the project labels (#731), by their state in `lang`: the same for every manual,
   * whose title page and metadata show them.
   */
  readonly labels: CoverageCounts;
}

/** What to report on; every part given has to hold. */
export interface CoverageFilter {
  /** One manual; one the reader may not see matches nothing. */
  readonly manual?: string | undefined;
  /** One target language; any other matches nothing. */
  readonly lang?: string | undefined;
}

type Counting = { -readonly [K in keyof CoverageCounts]: number };

const NONE: CoverageCounts = {
  total: 0,
  upToDate: 0,
  outdated: 0,
  atProvider: 0,
  missing: 0,
};

const COUNTED: Record<TranslationState, keyof Omit<CoverageCounts, 'total'>> = {
  'up-to-date': 'upToDate',
  outdated: 'outdated',
  'at-provider': 'atProvider',
  missing: 'missing',
};

/**
 * One coverage per manual the reader may see (a manifest that cannot be
 * read is left out) and target language they may read it in
 * (`seesManualIn`), ordered by the manual's title, its ID and the order of
 * the configured target languages. Built from the translation status
 * (`GET /translations/status`): a module counts in a language exactly
 * where the status lists it, so `filter[manual]` and `filter[lang]` there
 * list the modules counted here, and nothing outside the reader's scope is
 * named or counted. Beside them (#656), the units of the manual's page design's region text
 * (designs carry no audience: every reader of the manual reads them), of its own text and
 * (#731) of the project labels, as the status lists them.
 */
export async function translationCoverage(
  snapshot: ReadableContent,
  jobs: TranslationJobs,
  filter: CoverageFilter,
  statusReads: TranslationReads,
): Promise<TranslationCoverage[]> {
  const config = await snapshot.config();
  const languages = config.languages.targets.filter(
    (lang) => filter.lang === undefined || lang === filter.lang,
  );
  if (languages.length === 0) return [];
  const [reads, atProvider] = await Promise.all([
    statusReads.of(snapshot),
    unitsAtProvider(jobs, filter.lang),
  ]);
  const manuals = reads.manuals
    .filter((m) => filter.manual === undefined || m.id === filter.manual)
    .map((m) => ({ ...m, title: m.title ?? m.id }))
    .sort((a, b) => titles.compare(a.title, b.title) || compare(a.id, b.id));
  const source = config.languages.source;
  const covers = new Map(reads.covers.map((c) => [c.id, c]));
  const designs = new Map<string, Promise<PageDesign | undefined>>();
  const designOf = async (manualId: string) => {
    const id = await manualDesignId(snapshot, manualId, config);
    if (id === undefined) return undefined;
    let found = designs.get(id);
    if (!found) {
      found = readDesign(snapshot, id);
      designs.set(id, found);
    }
    return found;
  };
  // The project labels' units per language (#731), the same for every manual.
  const labels = new Map(
    languages.map((lang) => [
      lang,
      unitCounts(
        configTranslationStatus({
          config,
          lang,
          atProvider: atProvider.get(`${lang}/${CONFIG_KEY}`) ?? new Set(),
        }),
      ),
    ]),
  );
  const out: TranslationCoverage[] = [];
  for (const manual of manuals) {
    const included = closure(manual.modules, reads.byId);
    const design = await designOf(manual.id);
    const cover = covers.get(manual.id);
    for (const lang of languages) {
      if (!(await snapshot.seesManualIn(manual.audience, lang))) continue;
      const modules: Counting = { ...NONE };
      const blocks: Counting = { ...NONE };
      for (const moduleId of included) {
        const source = reads.byId.get(moduleId);
        const found = source?.translations.get(lang);
        if (!source || !found) continue;
        const counts = tally(
          source,
          found,
          atProvider.get(`${lang}/${moduleId}`),
        );
        modules.total += 1;
        modules[COUNTED[counts.state]] += 1;
        blocks.total += source.units.length;
        blocks.upToDate += counts.upToDate;
        blocks.outdated += counts.outdated;
        blocks.atProvider += counts.atProvider;
        blocks.missing += counts.missing;
      }
      out.push({
        manualId: manual.id,
        lang,
        title: manual.title,
        deprecated: manual.deprecated !== undefined,
        modules,
        blocks,
        design: unitCounts(
          design &&
            designTranslationStatus({
              design,
              lang,
              source,
              atProvider:
                atProvider.get(`${lang}/${designKey(design.id)}`) ?? new Set(),
            }),
        ),
        cover: unitCounts(
          cover &&
            manualTranslationStatus({
              manualId: manual.id,
              manifest: cover.manifest,
              lang,
              source,
              atProvider:
                atProvider.get(`${lang}/${manualKey(manual.id)}`) ?? new Set(),
            }),
        ),
        labels: labels.get(lang) ?? NONE,
      });
    }
  }
  return out;
}

/** A status's units by their state; none without one. */
function unitCounts(status: TranslationStatus | undefined): CoverageCounts {
  const counts: Counting = { ...NONE };
  for (const { state } of status?.blocks ?? []) {
    counts.total += 1;
    counts[COUNTED[state]] += 1;
  }
  return counts;
}

/** The share of `part` in `counts`, in whole percent rounded down (0 when there is nothing). */
export function percentOf(counts: CoverageCounts, part: number): number {
  return counts.total === 0 ? 0 : Math.floor((part * 100) / counts.total);
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const titles = new Intl.Collator(undefined, { sensitivity: 'base' });
