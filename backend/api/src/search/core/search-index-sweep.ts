/** What one sweep of the search index removed (#540). */
export interface SearchSweepReport {
  /** Scopes (a commit's index for one reading key) unused for the grace period. */
  readonly scopes: number;
  /** Member sets no scope names any more (#643), and the documents they named (one member each). */
  readonly memberSets: number;
  readonly scopeMembers: number;
  /** Documents no scope names, as old, with their parts. */
  readonly documents: number;
  /** Texts no part uses any more, marked now: deleted once unused for the grace period. */
  readonly textsMarked: number;
  /** Texts unused for the grace period, deleted, and their embeddings of every model. */
  readonly texts: number;
  readonly embeddings: number;
  /** Embeddings whose text was gone (a text swept while it was being embedded). */
  readonly orphans: number;
  /** Embeddings of models no server has configured for their grace period, and the models whose last went. */
  readonly modelEmbeddings: number;
  readonly droppedModels: readonly string[];
  /** False when a run's bounds (rows, time) stopped it, or a step failed: the next run goes on. */
  readonly complete: boolean;
  /** Whether a step failed (logged): the next run comes at the usual time, not sooner. */
  readonly failed: boolean;
  readonly ms: number;
}

/**
 * Port: removes from the search index what nothing uses any more, after a
 * grace period (`CCMS_SEARCH_SWEEP_AFTER_DAYS`, `CCMS_SEARCH_MODEL_KEPT_DAYS`):
 * old scopes, the documents they alone named, the texts those alone used
 * and their embeddings, and the embeddings of models no longer configured.
 * Bounded per run; never rejects (a failure is logged and reported as
 * incomplete). `SearchIndexSweeper` runs it on a timer.
 */
export abstract class SearchIndexSweep {
  abstract sweep(): Promise<SearchSweepReport>;
}

/** Nothing to sweep: the in-memory search keeps nothing in the database. */
export class NoSearchIndexSweep extends SearchIndexSweep {
  sweep(): Promise<SearchSweepReport> {
    return Promise.resolve({
      scopes: 0,
      memberSets: 0,
      scopeMembers: 0,
      documents: 0,
      textsMarked: 0,
      texts: 0,
      embeddings: 0,
      orphans: 0,
      modelEmbeddings: 0,
      droppedModels: [],
      complete: true,
      failed: false,
      ms: 0,
    });
  }
}
