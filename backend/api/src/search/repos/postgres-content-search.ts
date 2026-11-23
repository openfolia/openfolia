import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../base/core/paging.js';
import { Recent } from '../../base/core/recent.js';
import {
  filtersModules,
  foldKeyword,
} from '../../content/core/module-filter.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { ConcurrencyLimit } from '../../base/core/concurrency-limit.js';
import { TimedOutError, UnavailableError } from '../../base/core/errors.js';
import {
  type Database,
  type Drizzle,
  isTimedOut,
  reason,
} from '../../database/database.js';
import type { JobQueue } from '../../jobs/core/job-queue.js';
import {
  ContentSearch,
  type MatchRange,
  type AskedSearchFilter,
  type SearchFilter,
  type SearchHit,
} from '../core/content-search.js';
import { type Embedder, MAX_EMBED_TEXT_LENGTH } from '../core/embedder.js';
import {
  EMBED_SEARCH_TEXTS,
  EMBED_SEARCH_TEXTS_KEY,
} from '../core/search-texts.js';
import type {
  SearchIndexSweep,
  SearchSweepReport,
} from '../core/search-index-sweep.js';
import {
  hitFor,
  Limit,
  queryWords,
  rank as rankByWords,
  type Ranked,
} from './in-memory-content-search.js';
import {
  buildEntries,
  byTitle,
  excerptAround,
  foldText,
  filterHits,
  hitWith,
  indexKey,
  passesFilter,
  type IndexedBlock,
  type IndexedEntry,
  withAudiences,
} from './search-entries.js';
import {
  HEADLINE_OPTIONS,
  highlightRanges,
  queryTokens,
  tsQueryText,
} from './search-query.js';
import {
  KNOWN_CONFIGS,
  SIMPLE_CONFIG,
  textSearchConfig,
} from './text-search-configs.js';

/**
 * How rows are made (`documentKey`, `scopeDigest`): raise it when what is
 * stored for an entry changes, and every entry is indexed again (the old
 * rows are swept with their scopes).
 */
export const INDEX_SCHEME = 1;

/** Each ranked list (full text, typos, meaning) holds at most this many documents. */
export const CANDIDATES = 500;

/** Reciprocal rank fusion's constant: a hit's score is the sum of 1 / (K + its rank) over the lists it is in. */
const RRF_K = 60;

/** How close a query has to be to a title's or keyword's words to be a typo of them (`pg_trgm`'s word similarity). */
export const TYPO_SIMILARITY = 0.45;

/** The most one statement of a search may take: a query that would take longer fails rather than holding a connection. */
export const STATEMENT_TIMEOUT_MS = 5_000;

/** How long a search past `CCMS_SEARCH_CONCURRENCY` waits for its turn, at most, before 503 `search-busy`. */
export const SEARCH_WAIT_MS = 2_000;

/** How many searches may wait for their turn, per search running at once; past it, 503 `search-busy` at once. */
export const WAITING_PER_SEARCH = 4;

/** Recent searches whose fused hits are kept per index, for paging. */
const RANKINGS_PER_INDEX = 8;

/** Query vectors kept, by query text. */
const QUERY_VECTORS_KEPT = 256;

/** Scopes whose last `used_at` move this server remembers; past this many, it starts over. */
const TOUCHED_KEPT = 10_000;

/** After writing this many new documents at once, the search tables' statistics are made again (`analyze`), so the planner does not plan for empty tables. */
const ANALYZE_AFTER = 1_000;

/** How long semantic search stays off after pgvector could not be prepared, before it is tried again. */
const VECTOR_RETRY_MS = 10 * 60 * 1000;

/** How often, at most, a search that finds text not yet embedded asks for the embedding job again. */
const EMBED_NUDGE_MS = 5 * 60 * 1000;

/** Entries written per statement while indexing. */
const ENTRIES_PER_STATEMENT = 200;

/** Member sets written per statement while writing a scope. */
const SETS_PER_STATEMENT = 64;

/** How often writing a scope looks again for member sets other servers wrote at the same time, at most, before it fails. */
const SET_ROUNDS = 4;

/** The most member sets one scope is cut into (#643). */
export const MAX_MEMBER_SETS = 1_024;

/** The sweep's grace periods by default, in days (`CCMS_SEARCH_SWEEP_AFTER_DAYS`, `CCMS_SEARCH_MODEL_KEPT_DAYS`). */
const SWEEP_AFTER_DAYS = 7;
const MODEL_KEPT_DAYS = 7;

/**
 * One sweep's bounds (#540): rows per statement, the most scopes and
 * members (documents named by the member sets dropped, #643) it drops,
 * and how long it starts new statements for; each
 * statement within `SWEEP_STATEMENT_MS`, waiting for a lock at most
 * `SWEEP_LOCK_MS`. What is left is the next run's.
 */
export const SWEEP_BATCH = 1_000;
export const SWEEP_SCOPES = 200;
export const SWEEP_MEMBER_ROWS = 1_000_000;
export const SWEEP_RUN_MS = 60_000;
const SWEEP_STATEMENT_MS = 30_000;
const SWEEP_LOCK_MS = 5_000;
/** Rows a window of a walk looks at (texts unmarked, embeddings without text), and embeddings of an old model dropped per statement. */
export const SWEEP_EMBEDDINGS = 10_000;
/** Windows of each walk per run, at most. */
export const SWEEP_WINDOWS = 10;

/** A ranking made while its view's text is being embedded serves that search's later pages this long (they agree). */
const UNSETTLED_KEPT_MS = 60_000;

/** How often a scope's `used_at` is moved on, at most. */
const TOUCH_EVERY_MS = 60 * 60 * 1000;

/** What one search's index is: the entries the reader may read at the commit, by row key, and their scope's digest. */
interface IndexView {
  readonly entries: readonly IndexedEntry[];
  readonly byKey: ReadonlyMap<string, IndexedEntry>;
  readonly keyOf: ReadonlyMap<IndexedEntry, string>;
  readonly configOf: ReadonlyMap<IndexedEntry, string>;
  readonly configs: readonly string[];
  readonly scope: string;
  /**
   * Fused hits of recent searches on it, for paging: for good once its
   * hits can no longer change, i.e. without semantic search, or once all
   * of its text is embedded (`embedded`); before that, for the later
   * pages of a search only, for `UNSETTLED_KEPT_MS`.
   */
  readonly rankings: Recent<KeptRanking>;
  /** Whether every part of it has an embedding of the embedder's model (once true, for good). */
  embedded: boolean;
}

/** A kept ranking, and until when it may be used (`Infinity` once its hits can no longer change). */
interface KeptRanking {
  readonly fused: readonly Fused[];
  readonly until: number;
}

/** Where in a document a list found it: a part (`ord` 0 the head, then its blocks and questions). */
interface Part {
  readonly ord: number;
  readonly kind: 'head' | 'text' | 'question';
}

/** A document found by one or more lists, and how. */
interface Fused {
  readonly entry: IndexedEntry;
  readonly score: number;
  readonly matchedOn: Exclude<SearchHit['matchedOn'], 'filter'>;
  /** The part the excerpt comes from. */
  readonly part: Part;
  /** Whether the excerpt shows where the full text matched (`ts_headline`). */
  readonly lexical: boolean;
  /** The word list's match, when the excerpt comes from it (where the query's words are, as `InMemoryContentSearch` shows them). */
  readonly words?: Ranked;
  /** Its place in the order: `MATCH_ORDER` of what matched, or `TYPO_TIER` when only a typo did. */
  readonly tier: number;
}

/** pgvector: being prepared, ready (and whether it scans iteratively, pgvector 0.8), or off until `retryAt`. */
type VectorState =
  | { state: 'preparing'; done: Promise<void> }
  | { state: 'ready'; iterative: boolean }
  | { state: 'off'; retryAt: number };

/** A search's fused hits, and whether they are all it can find (meaning included, when it runs). */
interface Ranking {
  readonly fused: Fused[];
  readonly complete: boolean;
}

/** Lower is better: the order of `matchedOn` among hits that score the same. */
const MATCH_ORDER: Readonly<Record<Fused['matchedOn'], number>> = {
  title: 0,
  keyword: 1,
  question: 2,
  text: 3,
  meaning: 5,
};

/** Where a hit only a typo list found goes: after every word match, before meaning alone. */
const TYPO_TIER = 4;

export interface PostgresContentSearchOptions {
  /** How many indexes (commit and reading key) are kept in memory (`CCMS_SEARCH_INDEXES`). */
  readonly indexesKept: number;
  /** The least cosine similarity, 0 to 1, of a hit by meaning alone (`CCMS_EMBEDDER_MIN_SIMILARITY`). */
  readonly minSimilarity: number;
  /** The most time one search's statements may take together, in ms (`CCMS_SEARCH_TIMEOUT_MS`, #539). */
  readonly timeoutMs: number;
  /** Searches this server runs in the database at once (`CCMS_SEARCH_CONCURRENCY`, #539). */
  readonly concurrency: number;
  /** The clock the time budget is counted on (tests). */
  readonly now?: () => number;
  /** The sweep's grace period, in days (`CCMS_SEARCH_SWEEP_AFTER_DAYS`, default 7). */
  readonly sweepAfterDays?: number;
  /** Days a model no server has configured keeps its embeddings (`CCMS_SEARCH_MODEL_KEPT_DAYS`, default 7). */
  readonly modelKeptDays?: number;
}

/**
 * A search's time in the database (#539): `ms` for all of its statements
 * together, counted from the first. Before each statement, `next()` says
 * how long that one may take (what is left, at most
 * `STATEMENT_TIMEOUT_MS`), or throws `TimedOutError` once nothing is left,
 * so no query, however it is built, holds a connection much past the
 * budget: Postgres cuts a statement off at the time left, and none starts
 * after it.
 */
export class SearchBudget {
  #endsAt: number | undefined;

  constructor(
    private readonly ms: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The milliseconds the next statement may take, at least 1. */
  next(): number {
    const now = this.now();
    this.#endsAt ??= now + this.ms;
    const left = this.#endsAt - now;
    if (left <= 0) {
      throw new TimedOutError({
        cause: new Error(`The search took longer than ${this.ms} ms.`),
      });
    }
    return Math.max(1, Math.min(STATEMENT_TIMEOUT_MS, Math.ceil(left)));
  }
}

/**
 * The search in Postgres (#54): full text with each language's stemmer,
 * typos in titles and keywords (`pg_trgm`), and, with an `Embedder`,
 * meaning (pgvector), fused by reciprocal rank.
 *
 * **Rows by content.** Each entry a reader may read (`buildEntries`,
 * shared with `InMemoryContentSearch`) is a row keyed by the hash of its
 * content (`search_documents`, `search_blocks`), so an unchanged module
 * is the same row at every commit and is indexed once: a new commit
 * indexes only what changed. **Scope.** Which rows a reader may find is
 * written once per commit and reading key (`search_scopes`, as shared
 * `search_member_sets`, #643), from `ReadableContent`, never decided in SQL;
 * every query joins it first, and every row a query answers is checked
 * again against the reader's entries and the filters, so nothing outside
 * the scope is ranked, counted or returned. **Cost.** A search's
 * statements share one time budget (`SearchBudget`, `timeoutMs`), each
 * also cut off after `STATEMENT_TIMEOUT_MS`; at most `concurrency`
 * searches run in the database at once, others wait up to
 * `SEARCH_WAIT_MS` (503 `search-busy` past it); the query is at most
 * `MAX_QUERY_TOKENS` words of letters and digits, passed as parameters,
 * and only words of `MIN_PREFIX_LENGTH` or more are prefixes; each list is
 * capped at `CANDIDATES`.
 */
@Injectable()
export class PostgresContentSearch
  extends ContentSearch
  implements SearchIndexSweep
{
  private readonly logger = new Logger(PostgresContentSearch.name);
  readonly #views: Recent<IndexView>;
  readonly #builds = new Limit(2);
  readonly #touched = new Map<string, number>();
  /** Scopes being written, so concurrent searches of one write it once. */
  readonly #ensuring = new Map<string, Promise<boolean>>();
  readonly #queryVectors = new Recent<number[]>(QUERY_VECTORS_KEPT);
  #configs: Promise<ReadonlySet<string>> | undefined;
  #vector: VectorState | undefined;
  /** Where the sweep's look for member sets no scope names goes on from (an ID). */
  #setsAfter = '0';
  /** Where the sweep's look for embeddings without their text goes on from. */
  #orphansAfter: { model: string; hash: string } | undefined;
  /**
   * Where the sweep's look for unmarked texts no part uses goes on from:
   * a random hash in each process, so servers restarted more often than a
   * whole walk takes still reach every text in time.
   */
  #unmarkedAfter = randomBytes(32).toString('hex');
  /** When this server last recorded its model as in use. */
  #modelTouchedAt = 0;
  #lastNudge = 0;
  readonly #running: ConcurrencyLimit;
  /** Query embeddings asked for at once, server-wide; past it a search goes on without meaning. */
  readonly #embedding: ConcurrencyLimit;
  readonly #now: () => number;

  constructor(
    private readonly database: Database,
    private readonly embedder: Embedder,
    private readonly jobs: JobQueue | undefined,
    private readonly options: PostgresContentSearchOptions,
  ) {
    super();
    this.#views = new Recent<IndexView>(options.indexesKept);
    this.#now = options.now ?? Date.now;
    this.#embedding = new ConcurrencyLimit(
      options.concurrency,
      SEARCH_WAIT_MS,
      options.concurrency * WAITING_PER_SEARCH,
      () => new Error('Too many query embeddings at once.'),
    );
    this.#running = new ConcurrencyLimit(
      options.concurrency,
      SEARCH_WAIT_MS,
      options.concurrency * WAITING_PER_SEARCH,
      () =>
        new UnavailableError(
          'search-busy',
          'Too many searches at once on this server; try again.',
          1,
        ),
    );
  }

  async search(
    content: ReadableContent,
    query: string | undefined,
    asked: AskedSearchFilter,
    page: PageRequest,
  ): Promise<Paginated<SearchHit>> {
    const filter = await withAudiences(asked, content);
    // Control characters match nothing, and Postgres refuses U+0000 in a text parameter.
    if (query !== undefined) query = query.replace(/\p{Cc}/gu, ' ');
    const tokens = queryTokens(query ?? '');
    const words = queryWords(query ?? '');
    if (query === undefined ? !filtersModules(filter) : words.length === 0) {
      return { items: [], total: 0 };
    }
    const view = await this.#view(content);
    // Its scope may be gone since (swept, or `index-rebuild` emptied the
    // index): written again, documents and all, before anything is asked.
    if (
      await this.#ensure(view.scope, view.entries, view.keyOf, view.configOf)
    ) {
      // Written again: its text may be new to the embedder (swept with its
      // embeddings), so nothing kept of it holds any more.
      view.embedded = false;
      view.rankings.clear();
    }
    if (query === undefined) {
      const { items, total } = paginate(filterHits(view.entries, filter), page);
      return {
        items: items.map((entry) =>
          hitWith(entry, { excerpt: entry.title, matches: [] }, 'filter'),
        ),
        total,
      };
    }
    const text = query.trim();
    // The query's vector before a slot is taken: the embedder holds no
    // connection (its own timeout bounds it, the per-reader rate its
    // calls), so a slow embedder never keeps others from the database.
    // (None for a kept ranking; should it be dropped meanwhile, the search
    // goes on without meaning and keeps nothing: `complete` is false.)
    const semantic = tokens.length > 0 && (await this.semantic());
    const ranked =
      (await keptRanking(
        view,
        rankingKey(text, filter, semantic),
        page.number,
      )) !== undefined;
    const vector =
      semantic && !ranked ? await this.#queryVector(text) : undefined;
    // The scope is written by then (shared by its readers, bounded by its
    // own limit): only what a query costs is limited here.
    return this.#running.run(async () => {
      const budget = new SearchBudget(this.options.timeoutMs, this.#now);
      const fused = await this.#ranking(
        view,
        text,
        tokens,
        words,
        filter,
        budget,
        { semantic, vector },
        page.number,
      );
      const { items, total } = paginate(fused, page);
      return {
        items: await this.#hits(items, tokens, words, view, budget),
        total,
      };
    });
  }

  /**
   * The fused hits of a query: from the view's recent rankings once they
   * can no longer change (`#settled`); before that, a later page from the
   * ranking its first page made (for `UNSETTLED_KEPT_MS`, so the pages
   * neither overlap nor miss a hit) and a first page ranked afresh (so
   * what the job embedded is found at once). A ranking is kept only when
   * complete (meaning included, when semantic search runs).
   */
  async #ranking(
    view: IndexView,
    query: string,
    tokens: readonly string[],
    words: readonly string[],
    filter: SearchFilter,
    budget: SearchBudget,
    asked: { semantic: boolean; vector: number[] | undefined },
    pageNumber: number,
  ): Promise<readonly Fused[]> {
    const key = rankingKey(query, filter, asked.semantic);
    const kept = await keptRanking(view, key, pageNumber);
    if (kept) return kept;
    const settled = await this.#settled(view, budget);
    const { fused, complete } = await this.#rank(
      view,
      tokens,
      words,
      filter,
      budget,
      asked,
    );
    if (complete) {
      view.rankings.set(key, {
        fused,
        until: settled ? Infinity : Date.now() + UNSETTLED_KEPT_MS,
      });
    }
    return fused;
  }

  /**
   * Whether semantic search runs: an embedder, and pgvector ready in the
   * database. The first ask prepares it (the extension, then the model's
   * index in the background); a failure turns it off for
   * `VECTOR_RETRY_MS`, then it is tried again.
   */
  async semantic(): Promise<boolean> {
    if (this.embedder.model === undefined) return false;
    const now = this.#vector;
    if (
      now === undefined ||
      (now.state === 'off' && Date.now() >= now.retryAt)
    ) {
      const done = this.#prepareVector().then((state) => {
        this.#vector = state;
      });
      this.#vector = { state: 'preparing', done };
    }
    const current = this.#vector;
    if (current?.state === 'preparing') await current.done;
    const ready = this.#vector?.state === 'ready';
    // On every role, hourly: a server using its model keeps its embeddings.
    if (ready && Date.now() - this.#modelTouchedAt > TOUCH_EVERY_MS) {
      this.#modelTouchedAt = Date.now();
      this.#touchModel().catch((error: unknown) => {
        // Tried again by the next search.
        this.#modelTouchedAt = 0;
        this.logger.warn(
          `Could not record the embedding model in use: ${reason(error)}.`,
        );
      });
    }
    return ready;
  }

  /**
   * Whether a view's hits for a query are the same every time now: no
   * semantic search, or every part of it embedded. Until then each search
   * ranks afresh, so text the job embeds meanwhile is found by meaning.
   */
  async #settled(view: IndexView, budget: SearchBudget): Promise<boolean> {
    if (view.embedded || !(await this.semantic())) return true;
    const pending = await this.#bounded(budget, async (tx) => {
      const { rows } = await tx.execute<{ pending: boolean }>(sql`
        select exists (
          select 1 from ${scopeDocuments(view.scope)}
          join search_blocks b on b.doc_key = d.key
          where not exists (
            select 1 from search_embeddings e
            where e.model = ${this.embedder.model} and e.text_hash = b.text_hash)
        ) as pending`);
      return rows[0]?.pending !== false;
    });
    if (pending) {
      // Text the job did not get to (it gave up, or the text came while it
      // finished): ask for it again, now and then.
      if (Date.now() - this.#lastNudge > EMBED_NUDGE_MS) {
        this.#lastNudge = Date.now();
        void this.#enqueueEmbedding();
      }
      return false;
    }
    // Nothing pending is also what an emptied scope says: only trust it
    // while the scope is there.
    const there = await this.#bounded(budget, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from search_scopes where digest = ${view.scope}`,
      ),
    );
    view.embedded = there.rows[0]?.n === 1;
    return view.embedded;
  }

  /** The reader's index: their entries at the commit, indexed and scoped in the database. */
  #view(content: ReadableContent): Promise<IndexView> {
    return this.#views.get(indexKey(content), () =>
      this.#builds.run(async () => {
        const [entries, available] = await Promise.all([
          buildEntries(content),
          this.#availableConfigs(),
        ]);
        const byKey = new Map<string, IndexedEntry>();
        const keyOf = new Map<IndexedEntry, string>();
        const configOf = new Map<IndexedEntry, string>();
        for (const entry of entries) {
          const config =
            entry.type === 'manual'
              ? SIMPLE_CONFIG
              : textSearchConfig(entry.lang, available);
          const key = documentKey(config, entry.contentHash);
          byKey.set(key, entry);
          keyOf.set(entry, key);
          configOf.set(entry, config);
        }
        const scope = scopeDigest(content);
        await this.#ensure(scope, entries, keyOf, configOf);
        return {
          entries,
          byKey,
          keyOf,
          configOf,
          configs: [...new Set(configOf.values())].sort(),
          scope,
          rankings: new Recent<KeptRanking>(RANKINGS_PER_INDEX),
          embedded: false,
        };
      }),
    );
  }

  /**
   * Writes the documents the database lacks and the scope, once (concurrent
   * searches of one scope share the writing); moves an old scope's
   * `used_at` on. Says whether it wrote the scope (it was not there).
   */
  #ensure(
    scope: string,
    entries: readonly IndexedEntry[],
    keyOf: ReadonlyMap<IndexedEntry, string>,
    configOf: ReadonlyMap<IndexedEntry, string>,
  ): Promise<boolean> {
    const running = this.#ensuring.get(scope);
    if (running) return running;
    const done = this.#ensureNow(scope, entries, keyOf, configOf).finally(() =>
      this.#ensuring.delete(scope),
    );
    this.#ensuring.set(scope, done);
    return done;
  }

  async #ensureNow(
    scope: string,
    entries: readonly IndexedEntry[],
    keyOf: ReadonlyMap<IndexedEntry, string>,
    configOf: ReadonlyMap<IndexedEntry, string>,
  ): Promise<boolean> {
    const db = this.database.db;
    const { rows } = await db.execute<{ fresh: boolean }>(sql`
      select used_at > now() - interval '1 hour' as fresh
      from search_scopes where digest = ${scope}`);
    const found = rows[0];
    if (found) {
      const last = this.#touched.get(scope) ?? 0;
      if (found.fresh || Date.now() - last <= TOUCH_EVERY_MS) return false;
      if (this.#touched.size >= TOUCHED_KEPT) this.#touched.clear();
      this.#touched.set(scope, Date.now());
      // Waits for a sweep dropping it; then it is gone, and written again.
      const { rows: moved } = await db.execute<{ digest: string }>(
        sql`update search_scopes set used_at = now() where digest = ${scope} returning digest`,
      );
      if (moved.length > 0) return false;
    }
    const keys = [...new Set(keyOf.values())];
    let written = await this.#writeMissing(entries, keys, keyOf, configOf);
    const sets = memberSets(keys);
    const byKey = new Map<string, IndexedEntry>();
    for (const entry of entries) byKey.set(keyOf.get(entry) as string, entry);
    await db.transaction(async (tx) => {
      const { rows: made } = await tx.execute<{ digest: string }>(sql`
        insert into search_scopes (digest, sets) values (${scope}, '{}')
        on conflict do nothing returning digest`);
      // Another server made it meanwhile (its transaction committed first).
      if (made.length === 0) return;
      /** Each set's ID, by its hash. */
      const ids = new Map<string, string>();
      for (let round = 0; ; round++) {
        let pending = sets.filter((set) => !ids.has(set.hash));
        if (pending.length === 0) break;
        if (round === SET_ROUNDS) {
          throw new Error('The member sets of a search scope kept changing.');
        }
        // The sets there already, locked until the scope names them, so the
        // sweep (which skips locked rows) cannot drop one now; one it was
        // dropping is waited for, then written again below.
        for (const [hash, id] of await lockSets(
          tx,
          pending.map((set) => set.hash),
        )) {
          ids.set(hash, id);
        }
        pending = pending.filter((set) => !ids.has(set.hash));
        if (pending.length === 0) break;
        // The new ones: their documents locked until the sets name them
        // (one the sweep dropped since they were written is written again),
        // then the sets. One another server wrote meanwhile (it committed
        // first) is not written again: it is locked in the next round.
        const documents = await this.#lockDocuments(
          tx,
          pending.flatMap((set) => set.keys),
          byKey,
          keyOf,
          configOf,
        );
        written += documents.written;
        for (let i = 0; i < pending.length; i += SETS_PER_STATEMENT) {
          const rows = pending.slice(i, i + SETS_PER_STATEMENT).map((set) => ({
            hash: set.hash,
            docs: set.keys.map((key) => documents.ids.get(key) as string),
          }));
          const { rows: inserted } = await tx.execute<{
            id: string;
            hash: string;
          }>(sql`
            insert into search_member_sets (hash, docs)
            select x.hash, array(select d::bigint from jsonb_array_elements_text(x.docs) as d)
            from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(hash text, docs jsonb)
            order by x.hash
            on conflict (hash) do nothing
            returning id::text as id, hash`);
          for (const { id, hash } of inserted) ids.set(hash, id);
        }
      }
      await tx.execute(sql`
        update search_scopes
        set sets = array(select s::bigint from jsonb_array_elements_text(${JSON.stringify(sets.map((set) => ids.get(set.hash)))}::jsonb) as s)
        where digest = ${scope}`);
    });
    if (written > 0) void this.#enqueueEmbedding();
    return true;
  }

  /**
   * Writes the entries whose documents the database lacks (it is asked
   * every time: `index-rebuild` or a sweep may have emptied it), and says
   * how many.
   */
  async #writeMissing(
    entries: readonly IndexedEntry[],
    keys: readonly string[],
    keyOf: ReadonlyMap<IndexedEntry, string>,
    configOf: ReadonlyMap<IndexedEntry, string>,
  ): Promise<number> {
    const db = this.database.db;
    const present = new Set<string>();
    for (let i = 0; i < keys.length; i += 5_000) {
      const { rows: there } = await db.execute<{ key: string }>(sql`
        select key from search_documents
        where key in (select jsonb_array_elements_text(${JSON.stringify(keys.slice(i, i + 5_000))}::jsonb))`);
      for (const { key } of there) present.add(key);
    }
    const missing = entries.filter(
      (entry) => !present.has(keyOf.get(entry) as string),
    );
    for (let i = 0; i < missing.length; i += ENTRIES_PER_STATEMENT) {
      await this.#insert(
        db,
        missing.slice(i, i + ENTRIES_PER_STATEMENT),
        keyOf,
        configOf,
      );
    }
    if (missing.length >= ANALYZE_AFTER) {
      await db.execute(
        sql`analyze search_documents, search_blocks, search_member_sets`,
      );
    }
    return missing.length;
  }

  /**
   * The IDs of the documents `keys` names, each locked (`for key share`)
   * until the transaction ends, so the sweep cannot drop one meanwhile;
   * one it dropped since `#writeMissing` is written again (counted in
   * `written`).
   */
  async #lockDocuments(
    tx: Drizzle,
    keys: readonly string[],
    byKey: ReadonlyMap<string, IndexedEntry>,
    keyOf: ReadonlyMap<IndexedEntry, string>,
    configOf: ReadonlyMap<IndexedEntry, string>,
  ): Promise<{ ids: Map<string, string>; written: number }> {
    const ids = new Map<string, string>();
    const lock = async (wanted: readonly string[]) => {
      for (let i = 0; i < wanted.length; i += 5_000) {
        const { rows } = await tx.execute<{ key: string; id: string }>(sql`
          select key, id::text as id from search_documents
          where key in (select jsonb_array_elements_text(${JSON.stringify(wanted.slice(i, i + 5_000))}::jsonb))
          order by key
          for key share`);
        for (const { key, id } of rows) ids.set(key, id);
      }
    };
    await lock(keys);
    // In key order, as every writer inserts them.
    const missing = keys.filter((key) => !ids.has(key)).sort();
    for (let i = 0; i < missing.length; i += ENTRIES_PER_STATEMENT) {
      await this.#insert(
        tx,
        missing
          .slice(i, i + ENTRIES_PER_STATEMENT)
          .map((key) => byKey.get(key) as IndexedEntry),
        keyOf,
        configOf,
      );
    }
    if (missing.length > 0) await lock(missing);
    if (ids.size < keys.length) {
      throw new Error('A document of a search scope could not be written.');
    }
    return { ids, written: missing.length };
  }

  /** Writes `entries` (documents the database lacks): their documents, parts and texts to embed. */
  async #insert(
    db: Drizzle,
    entries: readonly IndexedEntry[],
    keyOf: ReadonlyMap<IndexedEntry, string>,
    configOf: ReadonlyMap<IndexedEntry, string>,
  ): Promise<void> {
    const documents: Record<string, unknown>[] = [];
    const parts: Record<string, unknown>[] = [];
    const texts = new Map<string, string>();
    for (const entry of entries) {
      const key = keyOf.get(entry) as string;
      const config = configOf.get(entry) as string;
      const keywords = entry.keywordsFolded.join(', ');
      documents.push({
        key,
        config,
        kind: entry.type,
        lang: entry.lang ?? null,
        module_type: entry.meta?.type ?? null,
        audience: entry.meta?.audience ?? null,
        facets: entry.meta?.facets ?? null,
        keyword_set: [...entry.keywordSet],
        title: entry.titleFolded,
        keywords,
      });
      const head = `${entry.title}\n${entry.keywords.join(', ')}`;
      partsOf(entry).forEach((part, ord) => {
        const embedded = cutText(
          part.block ? `${head}\n${part.block.text}` : head,
          MAX_EMBED_TEXT_LENGTH,
        );
        const hash = sha256(embedded);
        texts.set(hash, embedded);
        parts.push({
          doc_key: key,
          ord,
          block_id: part.block?.id || null,
          kind: part.kind,
          config,
          title: entry.titleFolded,
          keywords,
          text: part.block?.folded ?? '',
          text_hash: hash,
        });
      });
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into search_documents (key, config, kind, lang, module_type, audience, facets,
          keyword_set, title_folded, keywords_folded, title_tsv, head_tsv)
        select x.key, x.config, x.kind, x.lang, x.module_type, x.audience, x.facets,
          array(select jsonb_array_elements_text(x.keyword_set)), x.title, x.keywords,
          to_tsvector(x.config::regconfig, x.title),
          setweight(to_tsvector(x.config::regconfig, x.title), 'A')
            || setweight(to_tsvector(x.config::regconfig, x.keywords), 'B')
        from jsonb_to_recordset(${jsonText(documents)}::jsonb) as x(key text, config text,
          kind text, lang text, module_type text, audience text, facets jsonb, keyword_set jsonb,
          title text, keywords text)
        on conflict do nothing`);
      await tx.execute(sql`
        insert into search_blocks (doc_key, ord, block_id, kind, tsv, text_hash)
        select x.doc_key, x.ord, x.block_id, x.kind,
          setweight(to_tsvector(x.config::regconfig, x.title), 'A')
            || setweight(to_tsvector(x.config::regconfig, x.keywords), 'B')
            || setweight(to_tsvector(x.config::regconfig, x.text),
              case x.kind when 'question' then 'C' else 'D' end::"char"),
          x.text_hash
        from jsonb_to_recordset(${jsonText(parts)}::jsonb) as x(doc_key text, ord int,
          block_id text, kind text, config text, title text, keywords text, text text,
          text_hash text)
        on conflict do nothing`);
      // A text the sweep marked unused is in use again: unmarked. (The
      // upsert locks every text it meets, so a sweep deleting a marked one
      // waits, then finds it unmarked and keeps it; in hash order within a
      // statement, so two such statements do not wait for each other in a
      // cycle.)
      await tx.execute(sql`
        insert into search_texts (hash, text)
        select x.hash, x.text
        from jsonb_to_recordset(${jsonText([...texts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([hash, text]) => ({ hash, text })))}::jsonb)
          as x(hash text, text text)
        on conflict (hash) do update set unused_since = null
          where search_texts.unused_since is not null`);
    });
  }

  /** Enqueues the embedding of new text, when there is an embedder; a failure is logged, never the search's. */
  async #enqueueEmbedding(): Promise<void> {
    if (this.embedder.model === undefined || !this.jobs) return;
    try {
      await this.jobs.enqueue(
        EMBED_SEARCH_TEXTS,
        {},
        { key: EMBED_SEARCH_TEXTS_KEY },
      );
    } catch (error) {
      this.logger.warn(
        `Could not enqueue the embedding of new search text: ${(error as Error).name}.`,
      );
    }
  }

  /**
   * Drops what nothing uses any more (#540), bounded per run (rows per
   * statement, scopes and members, windows, `SWEEP_RUN_MS`), each
   * statement in a transaction of its own within `SWEEP_STATEMENT_MS` and
   * `SWEEP_LOCK_MS`, every batch selected first (by an index) and then
   * worked on by key, so no plan grows with stale statistics:
   *
   * 1. scopes unused for the grace period, one at a time (locked, so a
   *    search touching it waits, then writes it again), each followed by
   *    the member sets no scope names any more; then windows of sets, for
   *    one left unnamed otherwise;
   * 2. documents no member set names that are as old, with their parts (rows a
   *    scope being written holds are skipped, and each is checked again
   *    once locked); then, after that commits, the texts only they used
   *    are marked unused;
   * 3. a window of unmarked texts no part uses, marked: whatever left one
   *    so (two sweeps dropping documents that share it at the same
   *    moment, a text locked while it was checked), this walk reaches it;
   * 4. texts unused for the grace period, and their embeddings of every
   *    model: a batch of marked texts, locked, then only those checked
   *    against the parts (one used again is unmarked; indexing a marked
   *    text unmarks it too, waiting for the lock);
   * 5. a window of embeddings whose text is gone;
   * 6. the embeddings of a model no server has configured for its grace
   *    period (logged), then the model's vector index.
   *
   * Marking never waits for a row lock (`skip locked`: a text locked is
   * being indexed, so it is in use). A step that fails is logged and the
   * next one runs; the next run goes on. Never rejects.
   */
  async sweep(): Promise<SearchSweepReport> {
    const started = Date.now();
    const timeLeft = () => Date.now() - started < SWEEP_RUN_MS;
    const grace = `${this.options.sweepAfterDays ?? SWEEP_AFTER_DAYS} days`;
    const report: Omit<SearchSweepReport, 'complete' | 'failed' | 'ms'> & {
      droppedModels: string[];
    } = {
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
    };
    let failed = false;
    /** Runs a step; says whether it left work for the next run (a failure does). */
    const step = async (
      name: string,
      work: () => Promise<boolean>,
    ): Promise<boolean> => {
      try {
        return await work();
      } catch (error) {
        failed = true;
        this.logger.warn(
          `The search index sweep's ${name} step stopped: ${reason(error)}.`,
        );
        return true;
      }
    };
    const left = [
      await step('model', async () => {
        await this.#touchModel();
        return false;
      }),
      await step('scope', () => this.#sweepScopes(report, grace, timeLeft)),
      await step('document', () =>
        this.#sweepDocuments(report, grace, timeLeft),
      ),
      await step('unused text', async () => {
        await this.#markUnusedWindows(report, timeLeft);
        return false;
      }),
      await step('text', () => this.#sweepTexts(report, grace, timeLeft)),
      await step('orphan embedding', async () => {
        await this.#sweepOrphans(report, timeLeft);
        return false;
      }),
      await step('model embedding', () => this.#sweepModels(report, timeLeft)),
    ];
    return {
      ...report,
      complete: !left.includes(true),
      failed,
      ms: Date.now() - started,
    };
  }

  /**
   * Step 1: old scopes, one per transaction, each followed by the member
   * sets no scope names any more; then windows of member sets, by ID, those
   * no scope names dropped (`#setsAfter` goes on from the last): one a scope
   * being written held when its scope went, or left by a run cut off.
   * Says whether some are left.
   */
  async #sweepScopes(
    report: { scopes: number; memberSets: number; scopeMembers: number },
    grace: string,
    timeLeft: () => boolean,
  ): Promise<boolean> {
    const bounded = () =>
      report.scopes >= SWEEP_SCOPES ||
      report.scopeMembers >= SWEEP_MEMBER_ROWS ||
      !timeLeft();
    for (;;) {
      if (bounded()) return true;
      const sets = await this.#sweepStep(async (tx) => {
        const { rows } = await tx.execute<{ digest: string }>(sql`
          select digest from search_scopes
          where used_at < now() - ${grace}::interval
          order by used_at limit 1
          for update skip locked`);
        const digest = rows[0]?.digest;
        if (digest === undefined) return undefined;
        const { rows: gone } = await tx.execute<{ sets: string[] }>(sql`
          delete from search_scopes where digest = ${digest}
          returning sets::text[] as sets`);
        return gone[0]?.sets ?? [];
      });
      if (sets === undefined) break;
      report.scopes++;
      // Committed, so the check of each set sees the scope gone. Its own
      // sets go whatever the count bounds say (they are at most one
      // scope's), within the run's time; what is left is the walk's.
      if (!(await this.#dropSets(report, sets, () => !timeLeft()))) {
        return true;
      }
    }
    for (let window = 0; window < SWEEP_WINDOWS; window++) {
      if (bounded()) return true;
      const after = this.#setsAfter;
      // The window by key alone (the primary key), then checked by key.
      const { rows } = await this.#sweepStep((tx) =>
        tx.execute<{ id: string }>(sql`
          select id::text as id from search_member_sets
          where id > ${after}::bigint
          order by id limit ${SWEEP_EMBEDDINGS}`),
      );
      if (
        !(await this.#dropSets(
          report,
          rows.map((row) => row.id),
          bounded,
        ))
      ) {
        return true;
      }
      this.#setsAfter =
        rows.length < SWEEP_EMBEDDINGS ? '0' : (rows.at(-1)?.id ?? '0');
      if (this.#setsAfter === '0' && after === '0') break;
    }
    return false;
  }

  /**
   * Drops those of the member sets `ids` no scope names, a batch per
   * transaction: locked first (one a scope being written holds is
   * skipped), then checked again by a new statement (a scope written since
   * names it now) and deleted. Stops between batches once `bounded` says
   * so (what is left is a later window's); says whether it got through.
   */
  async #dropSets(
    report: { memberSets: number; scopeMembers: number },
    ids: readonly string[],
    bounded: () => boolean,
  ): Promise<boolean> {
    for (let i = 0; i < ids.length; i += SWEEP_BATCH) {
      if (bounded()) return false;
      const batch = JSON.stringify(ids.slice(i, i + SWEEP_BATCH));
      const dropped = await this.#sweepStep(async (tx) => {
        const { rows: locked } = await tx.execute<{ id: string }>(sql`
          select ms.id::text as id from search_member_sets ms
          where ms.id in (select x::bigint from jsonb_array_elements_text(${batch}::jsonb) as x)
            and not exists (select 1 from search_scopes s where s.sets @> array[ms.id])
          order by ms.id
          for update of ms skip locked`);
        if (locked.length === 0) return { sets: 0, members: 0 };
        const { rows } = await tx.execute<{
          sets: number;
          members: number;
        }>(sql`
          with d as (
            delete from search_member_sets ms
            where ms.id in (select x::bigint from jsonb_array_elements_text(${JSON.stringify(locked.map((row) => row.id))}::jsonb) as x)
              and not exists (select 1 from search_scopes s where s.sets @> array[ms.id])
            returning cardinality(ms.docs) as n)
          select count(*)::int as sets, coalesce(sum(n), 0)::int as members from d`);
        return rows[0] ?? { sets: 0, members: 0 };
      });
      report.memberSets += dropped.sets;
      report.scopeMembers += dropped.members;
    }
    return true;
  }

  /** Step 2: documents no member set names, as old, with their parts; then their texts marked. */
  async #sweepDocuments(
    report: { documents: number; textsMarked: number },
    grace: string,
    timeLeft: () => boolean,
  ): Promise<boolean> {
    for (;;) {
      if (!timeLeft()) return true;
      const swept = await this.#sweepStep(async (tx) => {
        const { rows: picked } = await tx.execute<{
          key: string;
          id: string;
        }>(sql`
          select d.key, d.id::text as id from search_documents d
          where d.created_at < now() - ${grace}::interval
            and not exists (select 1 from search_member_sets ms where ms.docs @> array[d.id])
          limit ${SWEEP_BATCH}
          for update of d skip locked`);
        if (picked.length === 0) return { picked: 0, hashes: [] };
        // Once locked, checked again (a new statement sees what committed
        // meanwhile): a set written since names it now.
        const { rows } = await tx.execute<{ key: string }>(sql`
          select k.key from jsonb_to_recordset(${JSON.stringify(picked)}::jsonb) as k(key text, id bigint)
          where not exists (select 1 from search_member_sets ms where ms.docs @> array[k.id])`);
        const keys = JSON.stringify(rows.map((row) => row.key));
        const { rows: parts } = await tx.execute<{ text_hash: string }>(sql`
          delete from search_blocks
          where doc_key in (select jsonb_array_elements_text(${keys}::jsonb))
          returning text_hash`);
        await tx.execute(sql`
          delete from search_documents
          where key in (select jsonb_array_elements_text(${keys}::jsonb))`);
        report.documents += rows.length;
        return {
          picked: picked.length,
          hashes: [...new Set(parts.map((part) => part.text_hash))],
        };
      });
      // Committed, so a later sweep's check sees this delete. (Two sweeps
      // dropping documents that share a text at the same moment may both
      // miss it: the window of step 3 marks it then.)
      report.textsMarked += await this.#markUnused(swept.hashes);
      if (swept.picked < SWEEP_BATCH) return false;
    }
  }

  /**
   * Marks those of `hashes` no part uses (and not marked yet), a batch per
   * transaction, each text locked first and then checked; one locked by
   * another transaction (being indexed) is skipped. Says how many.
   */
  async #markUnused(hashes: readonly string[]): Promise<number> {
    let marked = 0;
    for (let i = 0; i < hashes.length; i += SWEEP_BATCH) {
      const chunk = JSON.stringify(hashes.slice(i, i + SWEEP_BATCH));
      marked += await this.#sweepStep(async (tx) => {
        const { rows: locked } = await tx.execute<{ hash: string }>(sql`
          select hash from search_texts
          where hash in (select jsonb_array_elements_text(${chunk}::jsonb))
            and unused_since is null
          order by hash
          for update skip locked`);
        if (locked.length === 0) return 0;
        const { rows } = await tx.execute<{ n: number }>(sql`
          with m as (
            update search_texts set unused_since = now()
            where hash in (
              select h from jsonb_array_elements_text(${JSON.stringify(locked.map((row) => row.hash))}::jsonb) as h
              where not exists (select 1 from search_blocks b where b.text_hash = h))
            returning 1)
          select count(*)::int as n from m`);
        return rows[0]?.n ?? 0;
      });
    }
    return marked;
  }

  /** Step 3: windows of unmarked texts, by hash, those no part uses marked (`#unmarkedAfter` goes on from the last). */
  async #markUnusedWindows(
    report: { textsMarked: number },
    timeLeft: () => boolean,
  ): Promise<void> {
    for (let window = 0; window < SWEEP_WINDOWS && timeLeft(); window++) {
      const after = this.#unmarkedAfter;
      // The window by key alone (the primary key), then filtered by key.
      const { rows } = await this.#sweepStep((tx) =>
        tx.execute<{ hash: string }>(sql`
          select hash from search_texts
          where hash > ${after}
          order by hash limit ${SWEEP_EMBEDDINGS}`),
      );
      const { rows: unused } = await this.#sweepStep((tx) =>
        tx.execute<{ hash: string }>(sql`
          select t.hash from search_texts t
          where t.hash in (select jsonb_array_elements_text(${JSON.stringify(rows.map((row) => row.hash))}::jsonb))
            and t.unused_since is null
            and not exists (select 1 from search_blocks b where b.text_hash = t.hash)`),
      );
      report.textsMarked += await this.#markUnused(
        unused.map((row) => row.hash),
      );
      // At the end: on from the first in the same run, unless this window
      // started there (then the walk went all the way round).
      this.#unmarkedAfter =
        rows.length < SWEEP_EMBEDDINGS ? '' : (rows.at(-1)?.hash ?? '');
      if (this.#unmarkedAfter === '' && after === '') return;
    }
  }

  /** Step 4: texts unused for the grace period, and their embeddings; says whether some are left. */
  async #sweepTexts(
    report: { texts: number; embeddings: number },
    grace: string,
    timeLeft: () => boolean,
  ): Promise<boolean> {
    for (;;) {
      if (!timeLeft()) return true;
      const swept = await this.#sweepStep(async (tx) => {
        // A batch of marked ones by their index first (so the plan is
        // bounded however stale the statistics), locked.
        const { rows: batch } = await tx.execute<{ hash: string }>(sql`
          select hash from search_texts
          where unused_since < now() - ${grace}::interval
          order by unused_since
          limit ${SWEEP_BATCH}
          for update skip locked`);
        if (batch.length === 0) return { batch: 0, texts: 0, embeddings: 0 };
        const hashes = JSON.stringify(batch.map((row) => row.hash));
        // Of those, one a part uses again is unmarked, the rest deleted.
        const { rows: gone } = await tx.execute<{ hash: string }>(sql`
          with batch as (
            select h as hash, exists (
              select 1 from search_blocks b where b.text_hash = h) as used
            from jsonb_array_elements_text(${hashes}::jsonb) as h),
          kept as (
            update search_texts t set unused_since = null
            from batch x where t.hash = x.hash and x.used
            returning 1)
          delete from search_texts t using batch x
          where t.hash = x.hash and not x.used
          returning t.hash`);
        const { rows: vectors } = await tx.execute<{ n: number }>(sql`
          with v as (
            delete from search_embeddings
            where text_hash in (select jsonb_array_elements_text(${JSON.stringify(gone.map((row) => row.hash))}::jsonb))
            returning 1)
          select count(*)::int as n from v`);
        return {
          batch: batch.length,
          texts: gone.length,
          embeddings: vectors[0]?.n ?? 0,
        };
      });
      report.texts += swept.texts;
      report.embeddings += swept.embeddings;
      if (swept.batch < SWEEP_BATCH) return false;
    }
  }

  /** Step 5: windows of embeddings, by model and hash, those whose text is gone dropped (`#orphansAfter` goes on from the last). */
  async #sweepOrphans(
    report: { orphans: number },
    timeLeft: () => boolean,
  ): Promise<void> {
    for (let window = 0; window < SWEEP_WINDOWS && timeLeft(); window++) {
      const after = this.#orphansAfter ?? { model: '', hash: '' };
      const { rows } = await this.#sweepStep((tx) =>
        tx.execute<{ model: string; text_hash: string }>(sql`
          select model, text_hash from search_embeddings
          where (model, text_hash) > (${after.model}, ${after.hash})
          order by model, text_hash
          limit ${SWEEP_EMBEDDINGS}`),
      );
      const seen = JSON.stringify(
        rows.map((row) => ({ model: row.model, hash: row.text_hash })),
      );
      const { rows: gone } = await this.#sweepStep((tx) =>
        tx.execute<{ n: number }>(sql`
          with orphans as (
            select x.model, x.hash
            from jsonb_to_recordset(${seen}::jsonb) as x(model text, hash text)
            where not exists (select 1 from search_texts t where t.hash = x.hash)),
          d as (
            delete from search_embeddings e
            where (e.model, e.text_hash) in (select model, hash from orphans)
            returning 1)
          select count(*)::int as n from d`),
      );
      report.orphans += gone[0]?.n ?? 0;
      const last = rows.at(-1);
      this.#orphansAfter =
        rows.length < SWEEP_EMBEDDINGS || last === undefined
          ? undefined
          : { model: last.model, hash: last.text_hash };
      if (this.#orphansAfter === undefined) return;
    }
  }

  /** Step 6: the embeddings of models unseen for their grace period, a batch per statement; says whether any are left. */
  async #sweepModels(
    report: { modelEmbeddings: number; droppedModels: string[] },
    timeLeft: () => boolean,
  ): Promise<boolean> {
    const days = this.options.modelKeptDays ?? MODEL_KEPT_DAYS;
    const kept = `${days} days`;
    const { rows: old } = await this.#sweepStep((tx) =>
      tx.execute<{ model: string }>(sql`
        select model from search_embedding_models
        where seen_at < now() - ${kept}::interval
          and model is distinct from ${this.embedder.model ?? null}
        order by model`),
    );
    for (const { model } of old) {
      if (!timeLeft()) return true;
      this.logger.log(
        `Dropping the search embeddings of the model ${model}: no server has had it configured for ${days} days.`,
      );
      for (;;) {
        if (!timeLeft()) return true;
        // Each batch checks again that the model is still unseen: a server
        // configured with it again keeps what is left. The batch first,
        // then deleted by key: a bounded plan whatever the statistics say.
        const n = await this.#sweepStep(async (tx) => {
          const { rows: batch } = await tx.execute<{ text_hash: string }>(sql`
            select text_hash from search_embeddings
            where model = ${model}
              and exists (
                select 1 from search_embedding_models
                where model = ${model} and seen_at < now() - ${kept}::interval)
            limit ${SWEEP_EMBEDDINGS}
            for update skip locked`);
          if (batch.length === 0) return 0;
          await tx.execute(sql`
            delete from search_embeddings
            where model = ${model}
              and text_hash in (select jsonb_array_elements_text(${JSON.stringify(batch.map((row) => row.text_hash))}::jsonb))`);
          return batch.length;
        });
        report.modelEmbeddings += n;
        if (n < SWEEP_EMBEDDINGS) break;
      }
      const { rows: dropped } = await this.#sweepStep((tx) =>
        tx.execute<{ model: string }>(sql`
          delete from search_embedding_models m
          where m.model = ${model} and m.seen_at < now() - ${kept}::interval
            and not exists (select 1 from search_embeddings e where e.model = m.model)
          returning m.model`),
      );
      if (dropped.length === 0) continue;
      report.droppedModels.push(model);
      // Not waited for: a concurrent drop waits for every transaction on
      // the table (an index build, say), and the sweep must not.
      void this.#dropVectorIndex(model);
    }
    return false;
  }

  /** Drops a dropped model's vector index; a failure is logged. */
  async #dropVectorIndex(model: string): Promise<void> {
    try {
      // DDL takes no parameters: the name is hex, made from the model.
      await this.database.db.execute(
        sql.raw(`drop index concurrently if exists ${vectorIndexName(model)}`),
      );
    } catch (error) {
      this.logger.warn(
        `The vector index of a dropped model could not be dropped: ${reason(error)}.`,
      );
    }
  }

  /** A statement of the sweep in a transaction of its own, within its statement and lock timeouts. */
  #sweepStep<T>(work: (tx: Drizzle) => Promise<T>): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('statement_timeout', ${String(SWEEP_STATEMENT_MS)}, true),
          set_config('lock_timeout', ${String(SWEEP_LOCK_MS)}, true)`);
      return work(tx);
    });
  }

  /** Records that this server has its model configured, so the sweep keeps its embeddings. */
  async #touchModel(): Promise<void> {
    const model = this.embedder.model;
    if (model === undefined) return;
    await this.database.db.execute(sql`
      insert into search_embedding_models (model) values (${model})
      on conflict (model) do update set seen_at = now()`);
    this.#modelTouchedAt = Date.now();
  }

  /** The text search configurations the database has, of those `textSearchConfig` names. */
  #availableConfigs(): Promise<ReadonlySet<string>> {
    this.#configs ??= (async () => {
      const { rows } = await this.database.db.execute<{ cfgname: string }>(
        sql`select cfgname from pg_ts_config`,
      );
      return new Set(
        rows
          .map((row) => row.cfgname)
          .filter((name) => KNOWN_CONFIGS.has(name)),
      );
    })();
    this.#configs.catch(() => (this.#configs = undefined));
    return this.#configs;
  }

  /**
   * Creates pgvector (another server creating it at once is fine), then
   * the model's HNSW index in the background: until it is there, the
   * meaning list scans. Off (logged) when the database has no pgvector.
   */
  async #prepareVector(): Promise<VectorState> {
    const db = this.database.db;
    try {
      try {
        await db.execute(sql`create extension if not exists vector`);
      } catch (error) {
        // Created by another server at the same time: there now.
        if (!(await this.#hasVector())) throw error;
      }
      const { rows } = await db.execute<{ v: string }>(
        sql`select extversion as v from pg_extension where extname = 'vector'`,
      );
      const [major = 0, minor = 0] = (rows[0]?.v ?? '0').split('.').map(Number);
      try {
        await this.#touchModel();
      } catch (error) {
        this.logger.warn(
          `Could not record the embedding model in use: ${(error as Error).name}.`,
        );
      }
      void this.#buildVectorIndex();
      return { state: 'ready', iterative: major > 0 || minor >= 8 };
    } catch (error) {
      this.logger.error(
        `Semantic search is off for now: the database has no pgvector (the vector extension) or refused to create it (${(error as Error).message}); trying again in ${VECTOR_RETRY_MS / 60_000} minutes. See deploy/README.md, "Semantic search".`,
      );
      return { state: 'off', retryAt: Date.now() + VECTOR_RETRY_MS };
    }
  }

  async #hasVector(): Promise<boolean> {
    const { rows } = await this.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_extension where extname = 'vector'`,
    );
    return rows[0]?.n === 1;
  }

  /**
   * The model's HNSW index (partial, by model), built `concurrently`, so
   * the embedding job's inserts never wait for it (#540); one an earlier
   * build left invalid (cut off, the server stopped) is dropped and built
   * again, unless a build of it is running. A failure is logged, and the
   * meaning list scans.
   */
  async #buildVectorIndex(): Promise<void> {
    const model = this.embedder.model as string;
    const dimensions = vectorDimensions(this.embedder.dimensions);
    const index = vectorIndexName(model);
    const db = this.database.db;
    try {
      const { rows } = await db.execute<{ valid: boolean; building: boolean }>(
        sql`
          select i.indisvalid as valid, exists (
            select 1 from pg_stat_progress_create_index p where p.index_relid = c.oid
          ) as building
          from pg_class c join pg_index i on i.indexrelid = c.oid
          where c.relname = ${index}`,
      );
      const found = rows[0];
      if (found?.valid || found?.building) return;
      // DDL takes no parameters: the model is a quoted literal, the rest digits and hex.
      if (found)
        await db.execute(sql.raw(`drop index concurrently if exists ${index}`));
      await db.execute(
        sql.raw(
          `create index concurrently if not exists ${index} on search_embeddings using hnsw ` +
            `((embedding::vector(${dimensions})) vector_cosine_ops) ` +
            `where model = ${quoteLiteral(model)}`,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `The vector index for semantic search could not be made, so its searches scan: ${(error as Error).message}.`,
      );
    }
  }

  /** The query's vector, or undefined without semantic search or when the embedder fails (logged; the search goes on without it). */
  async #queryVector(query: string): Promise<number[] | undefined> {
    if (!(await this.semantic())) return undefined;
    try {
      return await this.#queryVectors.get(query, async () => {
        const [vector] = await this.#embedding.run(() =>
          this.embedder.embed(
            [query.slice(0, MAX_EMBED_TEXT_LENGTH)],
            AbortSignal.timeout(
              Math.min(STATEMENT_TIMEOUT_MS, this.options.timeoutMs),
            ),
          ),
        );
        if (!vector) throw new Error('No vector.');
        return vector;
      });
    } catch (error) {
      this.logger.warn(
        `Searching without meaning: the query could not be embedded (${(error as Error).message}).`,
      );
      return undefined;
    }
  }

  /** Every document the lists find, fused, best first. */
  async #rank(
    view: IndexView,
    tokens: readonly string[],
    words: readonly string[],
    filter: SearchFilter,
    budget: SearchBudget,
    { semantic, vector }: { semantic: boolean; vector: number[] | undefined },
  ): Promise<Ranking> {
    // Every word anywhere in a field, as the in-memory search finds it:
    // partial words (`gerät` in `Ladegerät`), stop words, symbols.
    const byWords = rankByWords(view.entries, words, filter);
    if (tokens.length === 0) {
      return { fused: fuse(view, filter, byWords, NO_LISTS), complete: true };
    }
    const iterative = this.#vector?.state === 'ready' && this.#vector.iterative;
    const where = filterSql(filter);
    const tsQuery = tsQueryText(tokens);
    const whole = words.join(' ');
    const lists = await this.#bounded(budget, async (tx, step) => {
      await tx.execute(
        sql`select set_config('pg_trgm.word_similarity_threshold', ${String(TYPO_SIMILARITY)}, true)`,
      );
      // One statement per configuration: a tsquery from a join (all
      // configurations in one statement) loses the index on `b.tsv` (#539).
      const lexical: LexicalRow[] = [];
      for (const [i, config] of view.configs.entries()) {
        if (i > 0) await step();
        lexical.push(
          ...(await fullText(tx, view.scope, config, tsQuery, whole, where)),
        );
      }
      const typos = await typoList(tx, step, view.scope, tokens, whole, where);
      const meaning = vector
        ? await meaningList(
            tx,
            step,
            view.scope,
            this.embedder,
            vector,
            this.options.minSimilarity,
            where,
            iterative,
          )
        : [];
      return { lexical, typos, meaning };
    });
    return {
      fused: fuse(view, filter, byWords, lists),
      complete: !semantic || vector !== undefined,
    };
  }

  /**
   * A transaction of the search within its budget: `step()` before each
   * statement after the first sets how long it may take (`SearchBudget`),
   * or refuses it once the budget is spent. A statement cut off, or a
   * budget spent, is a 503 `database-timeout`.
   */
  async #bounded<T>(
    budget: SearchBudget,
    work: (tx: Drizzle, step: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.db.transaction(async (tx) => {
        const step = async () => {
          await tx.execute(
            sql`select set_config('statement_timeout', ${String(budget.next())}, true)`,
          );
        };
        await step();
        return work(tx, step);
      });
    } catch (error) {
      if (isTimedOut(error)) throw new TimedOutError({ cause: error });
      throw error;
    }
  }

  /** The hits of a page, with their excerpts: where the query's words are, for a full-text match. */
  async #hits(
    items: readonly Fused[],
    tokens: readonly string[],
    words: readonly string[],
    view: IndexView,
    budget: SearchBudget,
  ): Promise<SearchHit[]> {
    const sources = items.map((item) => excerptSource(item));
    const marked = items.flatMap((item, i) =>
      item.lexical
        ? (sources[i]?.texts ?? []).map((text, j) => ({
            i,
            j,
            config: view.configOf.get(item.entry) as string,
            text,
          }))
        : [],
    );
    const headlines = new Map<string, string>();
    if (marked.length > 0) {
      const { rows } = await this.#bounded(budget, (tx) =>
        tx.execute<{
          i: number;
          j: number;
          h: string;
        }>(sql`
        select x.i, x.j, ts_headline(x.config::regconfig, x.text,
          to_tsquery(x.config::regconfig, ${tsQueryText(tokens)}), ${HEADLINE_OPTIONS}) as h
        from jsonb_to_recordset(${jsonText(
          marked.map(({ i, j, config, text }) => ({
            i,
            j,
            config,
            text: foldText(text),
          })),
        )}::jsonb) as x(i int, j int, config text, text text)`),
      );
      for (const row of rows) headlines.set(`${row.i}/${row.j}`, row.h);
    }
    return items.map((item, i) => {
      if (item.words) return hitFor(item.words, words);
      const source = sources[i] as ExcerptSource;
      const ranges = source.texts.map((text, j) => {
        const headline = headlines.get(`${i}/${j}`);
        return headline === undefined ? [] : highlightRanges(text, headline);
      });
      const blockId =
        item.part.kind === 'head' || item.entry.type === 'term'
          ? undefined
          : blockOf(item.entry, item.part.ord)?.id;
      return hitWith(
        item.entry,
        source.join(ranges),
        item.matchedOn,
        blockId === '' ? undefined : blockId,
      );
    });
  }
}

/** What a view keeps a query's ranking under. */
/**
 * A kept ranking's key: the query, the filters, and whether meaning was
 * asked, so a ranking made while pgvector was off is not used once it is on.
 */
const rankingKey = (
  query: string,
  filter: SearchFilter,
  semantic: boolean,
): string => JSON.stringify([query, filter, semantic]);

/**
 * The view's kept ranking for `key` if it may be used for this page: a
 * settled one always, an unsettled one for a later page while it lasts.
 */
async function keptRanking(
  view: IndexView,
  key: string,
  pageNumber: number,
): Promise<readonly Fused[] | undefined> {
  const kept = await view.rankings.peek(key);
  if (!kept) return undefined;
  if (kept.until === Infinity) return kept.fused;
  return pageNumber > 1 && kept.until > Date.now() ? kept.fused : undefined;
}

/** No full-text, typo or meaning rows: a query without letters or digits. */
const NO_LISTS = { lexical: [], typos: [], meaning: [] } as const;

/**
 * A full-text row: the document, its best part, and how well it matched:
 * every word in the title, the title the query itself or starting with it,
 * every word in the title and keywords, a keyword the query itself, then
 * the part's rank (`ts_rank_cd`, shorter parts first).
 */
type LexicalRow = {
  readonly key: string;
  readonly ord: number;
  readonly kind: Part['kind'];
  readonly in_title: boolean;
  readonly exact: boolean;
  readonly starts: boolean;
  readonly in_head: boolean;
  readonly keyword_exact: boolean;
  readonly rank: number;
};

/** The full-text list of one configuration's documents: each document once, at its best part. */
async function fullText(
  tx: Drizzle,
  scope: string,
  config: string,
  tsQuery: string,
  whole: string,
  where: SQL,
): Promise<LexicalRow[]> {
  const { rows } = await tx.execute<LexicalRow>(sql`
    with q as (select to_tsquery(${config}::regconfig, ${tsQuery}) as q),
    found as (
      select distinct on (d.key) d.key, d.title_folded, b.ord, b.kind,
        d.title_tsv @@ q.q as in_title,
        d.title_folded = ${whole} as exact,
        starts_with(d.title_folded, ${whole}) as starts,
        d.head_tsv @@ q.q as in_head,
        ${whole} = any(d.keyword_set) as keyword_exact,
        ts_rank_cd(b.tsv, q.q, 1) as rank
      from q, ${scopeDocuments(scope)}
      join search_blocks b on b.doc_key = d.key
      where d.config = ${config} and b.tsv @@ q.q and ${where}
      order by d.key, (b.kind = 'head') desc, rank desc, b.ord
    )
    select key, ord, kind, in_title, exact, starts, in_head, keyword_exact,
      round(rank::numeric, 6)::float8 as rank
    from found
    order by in_title desc, exact desc, starts desc, in_head desc, keyword_exact desc,
      (kind = 'question') desc, rank desc, title_folded, key
    limit ${CANDIDATES}`);
  return rows.map((row) => ({ ...row, rank: Number(row.rank) }));
}

/** How close the query's words are to the title's and to the keywords' words. */
type TypoRow = {
  readonly key: string;
  readonly title: number;
  readonly keywords: number;
  readonly exact: boolean;
  readonly starts: boolean;
};

/** Tokens shorter than this are left to the other lists: their trigrams tell little. */
const MIN_TYPO_TOKEN = 3;

/**
 * The documents whose title, or whose keywords, hold a word close to each
 * of the query's (`pg_trgm`), closest first (on average over the words).
 */
async function typoList(
  tx: Drizzle,
  step: () => Promise<void>,
  scope: string,
  tokens: readonly string[],
  whole: string,
  where: SQL,
): Promise<TypoRow[]> {
  const words = tokens.filter((token) => token.length >= MIN_TYPO_TOKEN);
  if (words.length === 0) return [];
  await step();
  const all = (column: SQL) =>
    sql.join(
      words.map((word) => sql`${word} <% ${column}`),
      sql` and `,
    );
  const mean = (column: SQL) =>
    sql`(${sql.join(
      words.map((word) => sql`word_similarity(${word}, ${column})`),
      sql` + `,
    )}) / ${words.length}`;
  const title = sql`d.title_folded`;
  const keywords = sql`d.keywords_folded`;
  const { rows } = await tx.execute<TypoRow>(sql`
    with found as (
      select d.key, d.title_folded,
        round((case when ${all(title)} then ${mean(title)} else 0 end)::numeric, 6)::float8 as title,
        round((case when ${all(keywords)} then ${mean(keywords)} else 0 end)::numeric, 6)::float8 as keywords,
        d.title_folded = ${whole} as exact,
        starts_with(d.title_folded, ${whole}) as starts
      from ${scopeDocuments(scope)}
      where ${where} and ((${all(title)}) or (${all(keywords)}))
    )
    select key, title, keywords, exact, starts from found
    order by greatest(title, keywords) desc, exact desc, starts desc, title_folded, key
    limit ${CANDIDATES}`);
  return rows.map((row) => ({
    ...row,
    title: Number(row.title),
    keywords: Number(row.keywords),
  }));
}

/** A meaning row: a part close to the query's meaning. */
type MeaningRow = {
  readonly key: string;
  readonly ord: number;
  readonly kind: Part['kind'];
  readonly similarity: number;
};

/** The parts nearest the query's vector, at least `minSimilarity` close, best first. */
async function meaningList(
  tx: Drizzle,
  step: () => Promise<void>,
  scope: string,
  embedder: Embedder,
  vector: readonly number[],
  minSimilarity: number,
  where: SQL,
  iterative: boolean,
): Promise<MeaningRow[]> {
  const dimensions = vectorDimensions(embedder.dimensions);
  if (vector.length !== dimensions || !vector.every(Number.isFinite)) return [];
  const literal = `[${vector.join(',')}]`;
  const type = sql.raw(`vector(${dimensions})`);
  // pgvector 0.8 scans the index on past rows the scope or the filters
  // leave out; before it, a scan of the index may stop short (fewer hits).
  await tx.execute(sql`select set_config('hnsw.ef_search', '200', true)`);
  if (iterative) {
    await tx.execute(
      sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
    );
  }
  await step();
  const { rows } = await tx.execute<MeaningRow>(sql`
    select b.doc_key as key, b.ord, b.kind,
      (1 - (e.embedding::${type} <=> ${literal}::${type}))::float8 as similarity
    from ${scopeDocuments(scope)}
    join search_blocks b on b.doc_key = d.key
    join search_embeddings e on e.model = ${embedder.model} and e.text_hash = b.text_hash
    where ${where}
      and (e.embedding::${type} <=> ${literal}::${type}) <= ${1 - minSimilarity}
    order by e.embedding::${type} <=> ${literal}::${type}, b.doc_key, b.ord
    limit ${CANDIDATES * 4}`);
  return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
}

/**
 * Ranks counted densely: rows that match equally well (the same `tie`)
 * share one, so a list never orders what it cannot tell apart, and the
 * tie-breaks of the fused list (title, then type, language and ID) decide.
 */
function denseRanks<T>(rows: readonly T[], tie: (row: T) => string): number[] {
  let rank = 0;
  let last: string | undefined;
  return rows.map((row) => {
    const key = tie(row);
    if (key !== last) {
      rank++;
      last = key;
    }
    return rank;
  });
}

/**
 * The lists fused by reciprocal rank, each document once: rows of
 * documents outside the reader's entries, or that the filter does not let
 * through, are dropped (a second check after the SQL's). Ordered by what
 * matched (title, keyword, question, text, then meaning alone, as the
 * in-memory search orders), then by the fused score, then by title, type,
 * language and ID.
 */
function fuse(
  view: IndexView,
  filter: SearchFilter,
  byWords: readonly Ranked[],
  lists: {
    lexical: readonly LexicalRow[];
    typos: readonly TypoRow[];
    meaning: readonly MeaningRow[];
  },
): Fused[] {
  const modulesOnly = filtersModules(filter);
  const allowed = (key: string): IndexedEntry | undefined => {
    const entry = view.byKey.get(key);
    return entry && passesFilter(entry, filter, modulesOnly)
      ? entry
      : undefined;
  };
  interface Found {
    entry: IndexedEntry;
    score: number;
    matchedOn?: Fused['matchedOn'];
    part?: Part;
    lexical: boolean;
    words?: Ranked | undefined;
    /** Only a typo list found it. */
    typo?: boolean;
  }
  const found = new Map<string, Found>();
  const at = (key: string, entry: IndexedEntry): Found => {
    let one = found.get(key);
    if (!one) {
      one = { entry, score: 0, lexical: false };
      found.set(key, one);
    }
    return one;
  };
  const rrf = (rank: number) => 1 / (RRF_K + rank);

  // Every word in a field (already scoped and filtered: the reader's entries), by tier.
  const wordRanks = denseRanks(byWords, (hit) => String(hit.tier));
  byWords.forEach((hit, i) => {
    const key = view.keyOf.get(hit.entry);
    if (key === undefined) return;
    const one = at(key, hit.entry);
    one.score += rrf(wordRanks[i] as number);
    one.matchedOn = hit.matchedOn as Fused['matchedOn'];
    one.words = hit;
  });

  // Full text, across configurations.
  const lexicalTie = (row: LexicalRow) =>
    [
      row.in_title,
      row.exact,
      row.starts,
      row.in_head,
      row.keyword_exact,
      row.kind === 'question',
    ]
      .map(Number)
      // A title or keyword match ties with its kind: how many words the
      // head has says nothing about which is meant.
      .join('') + `:${row.in_head ? 0 : row.rank}`;
  const lexical = [...lists.lexical].sort((a, b) => {
    const x = lexicalTie(a);
    const y = lexicalTie(b);
    // Flags first (higher first), then the rank (higher first).
    const [xf = '', xr = '0'] = x.split(':');
    const [yf = '', yr = '0'] = y.split(':');
    return yf.localeCompare(xf) || Number(yr) - Number(xr);
  });
  const lexicalRanks = denseRanks(lexical, lexicalTie);
  lexical.forEach((row, i) => {
    const entry = allowed(row.key);
    if (!entry) return;
    const one = at(row.key, entry);
    one.score += rrf(lexicalRanks[i] as number);
    const matchedOn: Fused['matchedOn'] = row.in_title
      ? 'title'
      : row.in_head
        ? 'keyword'
        : row.kind === 'question'
          ? 'question'
          : 'text';
    // The word list's match stands unless this one is a better kind.
    if (
      one.matchedOn !== undefined &&
      MATCH_ORDER[one.matchedOn] <= MATCH_ORDER[matchedOn]
    ) {
      return;
    }
    one.matchedOn = matchedOn;
    one.words = undefined;
    one.lexical = true;
    one.part =
      row.in_head || row.kind === 'head'
        ? { ord: 0, kind: 'head' }
        : { ord: row.ord, kind: row.kind };
  });

  // Typos in titles and keywords.
  const typoTie = (row: TypoRow) =>
    `${Math.max(row.title, row.keywords)}:${Number(row.exact)}${Number(row.starts)}`;
  const typoRanks = denseRanks(lists.typos, typoTie);
  lists.typos.forEach((row, i) => {
    const entry = allowed(row.key);
    if (!entry) return;
    const one = at(row.key, entry);
    one.score += rrf(typoRanks[i] as number);
    if (!one.matchedOn) {
      one.matchedOn = row.title >= row.keywords ? 'title' : 'keyword';
      one.part = { ord: 0, kind: 'head' };
      one.typo = true;
    }
  });

  // Meaning: each document at its closest part.
  const closest: MeaningRow[] = [];
  const seen = new Set<string>();
  for (const row of lists.meaning) {
    if (seen.has(row.key) || !allowed(row.key)) continue;
    seen.add(row.key);
    closest.push(row);
  }
  const meaningRanks = denseRanks(closest, (row) => String(row.similarity));
  closest.forEach((row, i) => {
    const entry = allowed(row.key) as IndexedEntry;
    const one = at(row.key, entry);
    one.score += rrf(meaningRanks[i] as number);
    if (!one.matchedOn) {
      one.matchedOn = 'meaning';
      one.part = { ord: row.ord, kind: row.kind };
    }
  });

  return [...found.values()]
    .map((one): Fused => ({
      entry: one.entry,
      score: one.score,
      matchedOn: one.matchedOn ?? 'meaning',
      part: one.part ?? { ord: 0, kind: 'head' },
      lexical: one.lexical,
      ...(one.words && { words: one.words }),
      tier: one.typo ? TYPO_TIER : MATCH_ORDER[one.matchedOn ?? 'meaning'],
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier || b.score - a.score || byTitle(a.entry, b.entry),
    );
}

/** The filters as a `where` on `search_documents d`, every value a parameter. */
export function filterSql(filter: SearchFilter): SQL {
  const parts: SQL[] = [sql`true`];
  if (filter.resourceType !== undefined) {
    parts.push(sql`d.kind = ${filter.resourceType}`);
  }
  if (filter.lang !== undefined) parts.push(sql`d.lang = ${filter.lang}`);
  if (filtersModules(filter)) {
    parts.push(sql`d.kind = 'module'`);
    if (filter.type !== undefined) {
      parts.push(sql`d.module_type = ${filter.type}`);
    }
    if (filter.audience !== undefined) {
      // The level a module counts as (`countsAsAudience`): none named is the last one.
      const { audience, audiences } = filter;
      parts.push(
        !audiences.includes(audience)
          ? sql`false`
          : audiences.at(-1) === audience
            ? sql`(d.audience = ${audience} or d.audience is null)`
            : sql`d.audience = ${audience}`,
      );
    }
    for (const { id, value } of filter.facets ?? []) {
      parts.push(sql`d.facets @> ${JSON.stringify({ [id]: [value] })}::jsonb`);
    }
    const keywords = (filter.keywords ?? []).map(foldKeyword);
    if (keywords.length > 0) {
      parts.push(
        sql`d.keyword_set @> array(select jsonb_array_elements_text(${JSON.stringify(keywords)}::jsonb))`,
      );
    }
  }
  return sql.join(parts, sql` and `);
}

/** An entry's parts in `ord` order: its head, its blocks, its FAQ questions. */
function partsOf(
  entry: IndexedEntry,
): { kind: Part['kind']; block?: IndexedBlock }[] {
  return [
    { kind: 'head' },
    ...entry.blocks.map((block) => ({ kind: 'text' as const, block })),
    ...entry.questions.map((block) => ({ kind: 'question' as const, block })),
  ];
}

/** The block or question at `ord` (1 and up). */
function blockOf(entry: IndexedEntry, ord: number): IndexedBlock | undefined {
  if (ord <= 0) return undefined;
  return ord <= entry.blocks.length
    ? entry.blocks[ord - 1]
    : entry.questions[ord - 1 - entry.blocks.length];
}

/** The texts a hit's excerpt is made of, and how to join them once their matches are known. */
interface ExcerptSource {
  readonly texts: readonly string[];
  join(ranges: readonly MatchRange[][]): {
    excerpt: string;
    matches: MatchRange[];
  };
}

/**
 * Where a hit's excerpt comes from: its title (a title match or a typo of
 * it), its keywords (those that matched, joined by `, `; all of them for a
 * typo), or its part's text (a text or question match, or the closest
 * part by meaning; the title for a head).
 */
function excerptSource(item: Fused): ExcerptSource {
  const { entry } = item;
  const single = (text: string): ExcerptSource => ({
    texts: [text],
    join: ([ranges]) => excerptAround(text, ranges ?? []),
  });
  if (item.matchedOn === 'keyword' && entry.keywords.length > 0) {
    return {
      texts: entry.keywords,
      join: (ranges) => {
        const kept = entry.keywords
          .map((keyword, i) => ({ keyword, ranges: ranges[i] ?? [] }))
          .filter((k) => !item.lexical || k.ranges.length > 0);
        let at = 0;
        const matches: MatchRange[] = [];
        const parts: string[] = [];
        for (const { keyword, ranges: own } of kept) {
          for (const range of own) {
            matches.push({ start: range.start + at, end: range.end + at });
          }
          parts.push(keyword);
          at += keyword.length + 2;
        }
        return { excerpt: parts.join(', '), matches };
      },
    };
  }
  if (item.part.kind === 'head' || item.matchedOn === 'title') {
    return single(entry.title);
  }
  const block = blockOf(entry, item.part.ord);
  return single(block?.text ?? entry.title);
}

/**
 * Empties the search index (`index-rebuild`): its scopes, documents and
 * parts. The texts and their embeddings stay (by text hash, they are as
 * good as ever), so indexing again embeds only text that is new; every
 * text is marked unused, so what is not indexed again is swept with its
 * embeddings after the grace period (#540). `dropEmbeddings` drops the
 * texts and every embedding too: everything is embedded again.
 */
export async function clearSearchIndex(
  database: Database,
  { dropEmbeddings = false }: { dropEmbeddings?: boolean } = {},
): Promise<void> {
  if (dropEmbeddings) {
    await database.db.execute(
      sql`truncate search_scopes, search_member_sets, search_blocks, search_documents, search_texts, search_embeddings, search_embedding_models`,
    );
    return;
  }
  await database.db.transaction(async (tx) => {
    await tx.execute(
      sql`truncate search_scopes, search_member_sets, search_blocks, search_documents`,
    );
    await tx.execute(
      sql`update search_texts set unused_since = now() where unused_since is null`,
    );
  });
}

/** The name of a model's HNSW index: hex of its name, so never SQL. */
const vectorIndexName = (model: string): string =>
  `search_embeddings_hnsw_${sha256(model).slice(0, 16)}`;

/**
 * A scope's documents cut into member sets (#643): by the hash of each
 * key into `b` buckets, `b` the smallest power of two whose square is at
 * least the number of keys (about √n sets of about √n documents each, at
 * most `MAX_MEMBER_SETS`), so a commit that changes a few modules changes
 * only their buckets' sets and shares the rest with the commit before.
 * Each set is keyed by a hash of the scheme and its sorted keys, which
 * names no reader. Disjoint, together exactly `keys`; sorted by hash.
 */
export function memberSets(
  keys: readonly string[],
): { hash: string; keys: string[] }[] {
  const unique = [...new Set(keys)];
  let buckets = 1;
  while (buckets * buckets < unique.length && buckets < MAX_MEMBER_SETS) {
    buckets *= 2;
  }
  const byBucket = new Map<number, string[]>();
  for (const key of unique) {
    const bucket =
      createHash('sha256').update(key).digest().readUInt32BE(0) % buckets;
    const members = byBucket.get(bucket);
    if (members) members.push(key);
    else byBucket.set(bucket, [key]);
  }
  return [...byBucket.values()]
    .map((members) => {
      members.sort();
      return {
        hash: sha256(`${INDEX_SCHEME}\u0000${members.join('\u0000')}`),
        keys: members,
      };
    })
    .sort((a, b) => (a.hash < b.hash ? -1 : 1));
}

/**
 * The IDs of those of the member sets `hashes` names that are there, each
 * locked (`for key share`) until the transaction ends; one the sweep is
 * dropping is waited for, and then is not there.
 */
async function lockSets(
  tx: Drizzle,
  hashes: readonly string[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 5_000) {
    const { rows } = await tx.execute<{ id: string; hash: string }>(sql`
      select id::text as id, hash from search_member_sets
      where hash in (select jsonb_array_elements_text(${JSON.stringify(hashes.slice(i, i + 5_000))}::jsonb))
      order by hash
      for key share`);
    for (const { id, hash } of rows) ids.set(hash, id);
  }
  return ids;
}

/**
 * The documents of a scope (`d`), what every query joins first: the scope
 * by its digest, its member sets, their documents (#643). Nothing else
 * leads to a document. Each set is looked up by its key (`offset 0` keeps
 * the planner from turning that into a scan of every set, however small
 * the table's statistics say it is).
 */
const scopeDocuments = (scope: string): SQL => sql`(
    select sm.doc_id from search_scopes s
    cross join unnest(s.sets) as ss(set_id)
    cross join lateral (
      select ms.docs from search_member_sets ms where ms.id = ss.set_id
      offset 0
    ) as ms
    cross join unnest(ms.docs) as sm(doc_id)
    where s.digest = ${scope}
  ) as m
  join search_documents d on d.id = m.doc_id`;

/** A document's row key: the scheme, its configuration and its content's hash. */
export const documentKey = (config: string, contentHash: string): string =>
  `${INDEX_SCHEME}:${config}:${contentHash}`;

/** A reader's scope at a commit, as a digest: the scheme, the commit and the reading key. */
export const scopeDigest = (content: ReadableContent): string =>
  sha256(`${INDEX_SCHEME}\u0000${content.commit}\u0000${content.readingKey}`);

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/** A whole number of dimensions pgvector takes, or an error (never SQL). */
function vectorDimensions(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16_000) {
    throw new Error('Not a number of vector dimensions.');
  }
  return dimensions;
}

/** A Postgres string literal (standard strings: a quote doubled). */
function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) throw new Error('Not a model name.');
  return `'${value.replaceAll("'", "''")}'`;
}

/** A text cut to at most `max` UTF-16 units, never inside a character. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * A value as JSON for a `jsonb` parameter: strings made well formed (a
 * lone surrogate becomes U+FFFD) and without U+0000, which `jsonb` text
 * refuses, so no content can make the statement fail.
 */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'string' ? v.toWellFormed().replaceAll('\u0000', '') : v,
  );
}
