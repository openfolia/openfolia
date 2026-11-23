import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { TranslationJob, TranslationJobUnit } from './translation-job.js';

/** A block of a module, in one target language, sent to a translation provider. */
export interface UnitAtProvider {
  readonly lang: string;
  readonly moduleId: string;
  readonly blockId: string;
}

/** A job as `create` takes it: its counts come from its units. */
export type NewTranslationJob = Omit<
  TranslationJob,
  'counts' | 'perLanguage' | 'state'
>;

/** Languages, or `'all'` of them. */
export type Languages = readonly string[] | 'all';

/**
 * Which jobs a reader may see (`seesJob`), worked out from their roles by
 * `jobReaders`.
 */
export interface TranslationJobFilter {
  /** The reader: they always see the jobs they made. */
  readonly reader: { readonly kind: 'user' | 'service'; readonly id: string };
  /**
   * The languages they manage translations into in roles whose scope
   * restricts nothing but languages (`translation.manage`).
   */
  readonly managed: Languages;
  /** The same for reading content (`content.read`). */
  readonly readable: Languages;
  /** The same for reading drafts (`content.read.draft`). */
  readonly draftReadable: Languages;
  /** Whether they read drafts (`content.read.draft`, in any scope). */
  readonly drafts: boolean;
}

const within = (languages: Languages, lang: string) =>
  languages === 'all' || languages.includes(lang);

/**
 * Whether a reader (`filter`) may see `job`: one exported from a commit
 * that was not released only with `content.read.draft`, and then their
 * own, or one whose every target language they manage and whose source
 * and target languages they read, each in roles that restrict nothing
 * else, so neither the job's subject (module IDs) nor its counts tell them
 * of content outside their scope.
 */
export function seesJob(
  filter: TranslationJobFilter,
  job: Pick<
    TranslationJob,
    'released' | 'createdBy' | 'languages' | 'sourceLang'
  >,
): boolean {
  if (!job.released && !filter.drafts) return false;
  if (
    job.createdBy.kind === filter.reader.kind &&
    job.createdBy.id === filter.reader.id
  ) {
    return true;
  }
  // A draft's content is read through the scope of `content.read.draft`.
  const readable = job.released ? filter.readable : filter.draftReadable;
  return (
    within(readable, job.sourceLang) &&
    job.languages.every(
      (lang) => within(filter.managed, lang) && within(readable, lang),
    )
  );
}

/**
 * Port: the translation jobs (Postgres, #50): what has been exported to a
 * provider. A job is `sent` with its units open (`at-provider`) until the
 * import (#51) or cancelling closes them. A unit (language, module,
 * block) is open in at most one job at a time.
 */
export abstract class TranslationJobs {
  /**
   * The units of every open job (exported, neither imported nor
   * cancelled), in `lang` when given.
   */
  abstract unitsAtProvider(filter: {
    readonly lang?: string | undefined;
  }): Promise<readonly UnitAtProvider[]>;

  /**
   * Records `job` as `sent` with its `units` open, inside `tx`. False,
   * having written nothing of the units it could (the caller rolls back),
   * when one of them is open in another job already (an export made at
   * the same time).
   */
  abstract create(
    tx: Transaction,
    job: NewTranslationJob,
    units: readonly TranslationJobUnit[],
  ): Promise<boolean>;

  /** The job `id`; undefined for none (or a malformed ID). */
  abstract find(id: string): Promise<TranslationJob | undefined>;

  /** One page of the jobs `filter` sees (`seesJob`), newest first. */
  abstract list(
    filter: TranslationJobFilter,
    page: PageRequest,
  ): Promise<Paginated<TranslationJob>>;

  /** The units of job `id` in `lang`, in the order they were exported. */
  abstract unitsOf(id: string, lang: string): Promise<TranslationJobUnit[]>;

  /**
   * Cancels job `id` inside `tx`, closing its units; false when it is not
   * `sent` (returned or cancelled already, or gone).
   */
  abstract cancel(tx: Transaction, id: string): Promise<boolean>;

  /**
   * Closes the `units` of job `id` that an import brought back (#51),
   * inside `tx`: they are no longer `at-provider`. Once none of its units
   * is open, a `sent` job becomes `returned`. A cancelled job, and units it
   * does not hold, are left as they are. Returns the job's state after.
   */
  abstract returnUnits(
    tx: Transaction,
    id: string,
    units: readonly Pick<UnitAtProvider, 'lang' | 'moduleId' | 'blockId'>[],
  ): Promise<TranslationJob['state'] | undefined>;
}
