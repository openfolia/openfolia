import { Injectable } from '@nestjs/common';
import {
  manifestUnits,
  type Manifest,
  type ModuleMeta,
  textIn,
} from '@openfolia/content-model';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import { Recent } from '../../base/core/recent.js';
import { foldText } from '../../content/core/module-filter.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { IndexedModule } from '../../modules/core/module-index.js';
import {
  ReadableModuleIndex,
  type ReadableIndex,
} from '../../modules/core/readable-module-index.js';
import {
  inFolder,
  unitsAtProvider,
  type TranslationStatusFilter,
} from './statuses.js';
import {
  CONFIG_KEY,
  configMatches,
  configTranslationStatus,
} from './config-translations.js';
import {
  designKey,
  designTranslationStatus,
  manualDesignId,
  readableDesigns,
} from './design-translations.js';
import {
  manualKey,
  manualTranslationStatus,
  readManifest,
  seesManualTranslation,
} from './manual-translations.js';
import type { TranslationJobs } from './translation-jobs.js';
import type {
  BlockStatus,
  TranslationState,
  TranslationStatus,
} from './translation-status.js';

/**
 * A translation as one reader finds it: no file they see (`missing`), or a
 * file with what its record says. `outdated` undefined: every unit is (no
 * record, one that cannot be read, or a file that cannot be read).
 */
export type TargetReads =
  | { readonly translated: false }
  | {
      readonly translated: true;
      readonly outdated: ReadonlySet<string> | undefined;
      readonly sourceCommit: string | null;
    };

/** A source module as one reader sees it, with its translations they would see, by language. */
export interface SourceReads {
  readonly id: string;
  /** The source title. */
  readonly title: string;
  /** `title` folded for `filter[q]`. */
  readonly folded: string;
  readonly meta: Pick<ModuleMeta, 'type' | 'facets'>;
  /** The modules its reference blocks name. */
  readonly refs: readonly string[];
  /** Its translatable units, by block ID in document order. */
  readonly units: readonly string[];
  readonly translations: ReadonlyMap<string, TargetReads>;
}

/** What a commit holds for one reader, for the translation status and the coverage report. */
export interface CommitReads {
  /** Ordered by title (case and accents aside), then module ID. */
  readonly sources: readonly SourceReads[];
  readonly byId: ReadonlyMap<string, SourceReads>;
  /** The manifests the reader may see that can be read (`ReadableIndex.manuals`). */
  readonly manuals: ReadableIndex['manuals'];
  /**
   * The manuals among them with cover image alternative text to translate (#656), as the reader
   * reads their manifests, ordered by title (case and accents aside), then ID.
   */
  readonly covers: readonly ManualReads[];
}

/** A manual with translatable text of its own (#656), as one reader reads its manifest. */
export interface ManualReads {
  readonly id: string;
  readonly title: string;
  /** `title` folded for `filter[q]`. */
  readonly folded: string;
  readonly manifest: Manifest;
}

/** How many pairs of commit and reading key are kept. */
export const READS_KEPT = 32;

/** How a module's units stand in one language. */
export interface UnitTally {
  readonly state: TranslationState;
  readonly upToDate: number;
  readonly outdated: number;
  readonly missing: number;
  readonly atProvider: number;
}

const titles = new Intl.Collator(undefined, { sensitivity: 'base' });
const ids = new Intl.Collator();

/**
 * The translation status from the module index (#480), as one reader
 * sees it: per commit, each source-language file's units and each
 * translation's record compared with them are in the index
 * (`IndexedModule.units`, `.translation`), so no file is read here. Who
 * sees what is decided as `ReadableContent` decides it: the source modules
 * the reader sees (`ReadableModuleIndex`), a translation file they see, or,
 * where they see none, whether they would see one (`judgeIndexed`, as
 * `wouldSee`). Kept per commit and reading key; only the jobs
 * (`at-provider`) are asked on every request.
 */
@Injectable()
export class TranslationReads {
  readonly #recent = new Recent<CommitReads>(READS_KEPT);

  constructor(private readonly index: ReadableModuleIndex) {}

  of(snapshot: ReadableContent): Promise<CommitReads> {
    return this.#recent.get(`${snapshot.commit}|${snapshot.readingKey}`, () =>
      this.#read(snapshot),
    );
  }

  async #read(snapshot: ReadableContent): Promise<CommitReads> {
    const [view, judge, config] = await Promise.all([
      this.index.of(snapshot),
      snapshot.judgeIndexed(snapshot.commit),
      snapshot.config(),
    ]);
    const { source, targets } = config.languages;
    const seen = new Map<string, IndexedModule>();
    for (const m of view.modules) seen.set(`${m.lang}/${m.id}`, m);
    const sources: SourceReads[] = [];
    for (const m of view.modules) {
      if (m.lang !== source || !m.meta) continue;
      const translations = new Map<string, TargetReads>();
      for (const lang of targets) {
        const file = seen.get(`${lang}/${m.id}`);
        if (file) {
          const record = file.meta ? file.translation : undefined;
          translations.set(lang, {
            translated: true,
            outdated: record && new Set(record.outdated),
            sourceCommit: record?.sourceCommit ?? null,
          });
        } else if (judge.module({ lang, meta: m.meta })) {
          // No file they see: one they would see is missing.
          translations.set(lang, { translated: false });
        }
      }
      sources.push({
        id: m.id,
        title: m.meta.title,
        folded: foldText(m.meta.title),
        meta: { type: m.meta.type, facets: m.meta.facets },
        refs: m.refs,
        units: m.units ?? [],
        translations,
      });
    }
    sources.sort(
      (a, b) => titles.compare(a.title, b.title) || ids.compare(a.id, b.id),
    );
    const covers: ManualReads[] = [];
    for (const m of view.manuals) {
      const manifest = await readManifest(snapshot, m.id);
      if (!manifest || manifestUnits(manifest, source).length === 0) continue;
      // Listed without a language (#731): the title in the source language.
      const title = textIn(manifest.title, source, source);
      covers.push({
        id: m.id,
        title,
        folded: foldText(title),
        manifest,
      });
    }
    covers.sort(
      (a, b) => titles.compare(a.title, b.title) || ids.compare(a.id, b.id),
    );
    return {
      sources,
      byId: new Map(sources.map((s) => [s.id, s])),
      manuals: view.manuals,
      covers,
    };
  }
}

/**
 * How `source`'s units stand in a language (`translationStatus`, without
 * listing them): a unit at a provider is `at-provider`; otherwise, without
 * a file `missing`, with one `outdated` or `up-to-date` by the record.
 */
export function tally(
  source: SourceReads,
  target: TargetReads,
  atProvider: ReadonlySet<string> | undefined,
): UnitTally {
  const total = source.units.length;
  let upToDate = 0;
  let outdated = 0;
  let missing = 0;
  let sent = 0;
  if (!atProvider || atProvider.size === 0) {
    if (!target.translated) missing = total;
    else if (target.outdated === undefined) outdated = total;
    else {
      outdated = target.outdated.size;
      upToDate = total - outdated;
    }
  } else {
    for (const unit of source.units) {
      const state = unitState(unit, target, atProvider);
      if (state === 'at-provider') sent++;
      else if (state === 'missing') missing++;
      else if (state === 'outdated') outdated++;
      else upToDate++;
    }
  }
  const due = outdated + missing;
  const state: TranslationState =
    !target.translated && (due > 0 || sent === 0)
      ? 'missing'
      : due > 0
        ? 'outdated'
        : sent > 0
          ? 'at-provider'
          : 'up-to-date';
  return { state, upToDate, outdated, missing, atProvider: sent };
}

function unitState(
  unit: string,
  target: TargetReads,
  atProvider: ReadonlySet<string> | undefined,
): TranslationState {
  if (atProvider?.has(unit)) return 'at-provider';
  if (!target.translated) return 'missing';
  return target.outdated === undefined || target.outdated.has(unit)
    ? 'outdated'
    : 'up-to-date';
}

/** The full status of `source` in `lang`, each unit listed. */
export function statusFrom(
  source: SourceReads,
  lang: string,
  target: TargetReads,
  atProvider: ReadonlySet<string> | undefined,
): TranslationStatus {
  const counts = tally(source, target, atProvider);
  const blocks: BlockStatus[] = source.units.map((blockId) => ({
    blockId,
    state: unitState(blockId, target, atProvider),
  }));
  return {
    kind: 'module',
    moduleId: source.id,
    lang,
    title: source.title,
    state: counts.state,
    blocks,
    outdatedBlocks: counts.outdated + counts.missing,
    atProviderBlocks: counts.atProvider,
    sourceCommit: target.translated ? target.sourceCommit : null,
  };
}

/**
 * The IDs of the modules a manual includes and those their module
 * references lead to, through the source modules the reader sees
 * (`manualModules`, from the index); none for a manual they may not see
 * or that cannot be read.
 */
export function includedIn(reads: CommitReads, manualId: string): Set<string> {
  const manual = reads.manuals.find((m) => m.id === manualId);
  return manual ? closure(manual.modules, reads.byId) : new Set();
}

/** `named` and what their module references lead to, through `sources`. */
export function closure(
  named: readonly string[],
  sources: ReadonlyMap<string, SourceReads>,
): Set<string> {
  const found = new Set<string>();
  const pending = [...named];
  for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
    if (found.has(id)) continue;
    found.add(id);
    for (const ref of sources.get(id)?.refs ?? []) pending.push(ref);
  }
  return found;
}

/**
 * What a page of statuses counts: `status`, one per status; or `row` (#689), one per row of the
 * module × language matrix (a module, a page design's region text, a manual's own text or the
 * configuration's labels), each
 * with every status it has, however many languages that is.
 */
export type StatusPaging = 'status' | 'row';

/**
 * One page of the statuses: first the configuration's labels (#731) per target language
 * (`configTranslationStatus`; every reader of the commit reads them in every language; none
 * without a label); then a page design's region text (#568) per design and target
 * language (`designTranslationStatus`; designs carry no audience, so every reader of the
 * commit reads each one in every language; one without region text has no row), ordered by
 * the design's name and ID; then a manual's cover image alternative text (#656) per manual
 * and target language the reader reads it in (`seesManualTranslation`; one without such text
 * has no row), ordered by title and ID; then one per source module (in the source language, as
 * the reader sees it) and target language the reader would see a translation in, ordered by the
 * source title, the module ID and the order of the configured target languages. Filtered before
 * paging: `filter.manual` keeps the labels (its title page shows them), the manual's design, its
 * own text and the modules it includes, `filter.folder` (a folder of modules) keeps no labels, no
 * design and no manual, `filter.kind` one kind. Source files
 * that cannot be read are left out. A manual the reader may not see (or that does not exist)
 * matches nothing. `filter.modules` (#694) keeps only those modules: no labels, no design and no
 * manual.
 * Only the page's units are listed. Paged `by` status, or by row (`StatusPaging`).
 */
export async function listTranslationStatuses(
  snapshot: ReadableContent,
  jobs: TranslationJobs,
  filter: TranslationStatusFilter,
  page: PageRequest,
  reads: TranslationReads,
  by: StatusPaging = 'status',
): Promise<Paginated<TranslationStatus>> {
  const config = await snapshot.config();
  const languages = config.languages.targets.filter(
    (lang) => filter.lang === undefined || lang === filter.lang,
  );
  if (languages.length === 0) return { items: [], total: 0 };
  const [all, atProvider] = await Promise.all([
    reads.of(snapshot),
    unitsAtProvider(jobs, filter.lang),
  ]);
  const included =
    filter.manual === undefined ? undefined : includedIn(all, filter.manual);
  const q = filter.q === undefined ? undefined : foldText(filter.q);
  const start = (page.number - 1) * page.size;
  const items: TranslationStatus[] = [];
  // Statuses, or rows (#689): a row's statuses come one after another, so a new row key starts
  // the next row, and a page holds `page.size` rows with every status each has.
  let total = 0;
  let row: string | undefined;
  const take = (key: string, status: () => TranslationStatus) => {
    if (by === 'row') {
      if (key !== row) {
        row = key;
        total++;
      }
      const index = total - 1;
      if (index >= start && index < start + page.size) items.push(status());
      return;
    }
    if (total >= start && items.length < page.size) items.push(status());
    total++;
  };
  // A folder or a list of modules (#694) names modules only: no labels, no design, no manual.
  const modulesOnly =
    filter.folder !== undefined || filter.modules !== undefined;
  // A manual the reader may not see (or that is not there) keeps no labels either.
  const manualSeen =
    filter.manual === undefined ||
    all.manuals.some((m) => m.id === filter.manual);
  if (
    (filter.kind === undefined || filter.kind === 'config') &&
    !modulesOnly &&
    manualSeen &&
    (q === undefined || configMatches(q))
  ) {
    for (const lang of languages) {
      const status = configTranslationStatus({
        config,
        lang,
        atProvider: atProvider.get(`${lang}/${CONFIG_KEY}`) ?? new Set(),
      });
      if (!status || (filter.state && status.state !== filter.state)) {
        continue;
      }
      take('config', () => status);
    }
  }
  if ((filter.kind === undefined || filter.kind === 'design') && !modulesOnly) {
    const manualDesign =
      filter.manual === undefined
        ? undefined
        : await manualDesignId(snapshot, filter.manual, config);
    for (const design of await readableDesigns(snapshot)) {
      if (filter.manual !== undefined && design.id !== manualDesign) continue;
      if (
        q !== undefined &&
        !design.id.includes(q) &&
        !foldText(design.name).includes(q)
      ) {
        continue;
      }
      for (const lang of languages) {
        const status = designTranslationStatus({
          design,
          lang,
          source: config.languages.source,
          atProvider:
            atProvider.get(`${lang}/${designKey(design.id)}`) ?? new Set(),
        });
        if (!status || (filter.state && status.state !== filter.state)) {
          continue;
        }
        take(`designs/${design.id}`, () => status);
      }
    }
  }
  if ((filter.kind === undefined || filter.kind === 'manual') && !modulesOnly) {
    for (const manual of all.covers) {
      if (filter.manual !== undefined && manual.id !== filter.manual) continue;
      if (
        q !== undefined &&
        !manual.id.includes(q) &&
        !manual.folded.includes(q)
      ) {
        continue;
      }
      for (const lang of languages) {
        if (!(await seesManualTranslation(snapshot, manual.manifest, lang))) {
          continue;
        }
        const status = manualTranslationStatus({
          manualId: manual.id,
          manifest: manual.manifest,
          lang,
          source: config.languages.source,
          atProvider:
            atProvider.get(`${lang}/${manualKey(manual.id)}`) ?? new Set(),
        });
        if (!status || (filter.state && status.state !== filter.state)) {
          continue;
        }
        take(`manuals/${manual.id}`, () => status);
      }
    }
  }
  if (
    filter.kind === 'design' ||
    filter.kind === 'manual' ||
    filter.kind === 'config' ||
    included?.size === 0
  ) {
    return { items, total };
  }
  for (const source of all.sources) {
    if (
      (included !== undefined && !included.has(source.id)) ||
      (filter.modules !== undefined && !filter.modules.has(source.id)) ||
      !inFolder(source.meta, filter.folder, config) ||
      (q !== undefined && !source.id.includes(q) && !source.folded.includes(q))
    ) {
      continue;
    }
    for (const lang of languages) {
      const target = source.translations.get(lang);
      if (!target) continue;
      const sent = atProvider.get(`${lang}/${source.id}`);
      if (filter.state && tally(source, target, sent).state !== filter.state) {
        continue;
      }
      take(source.id, () => statusFrom(source, lang, target, sent));
    }
  }
  return { items, total };
}
