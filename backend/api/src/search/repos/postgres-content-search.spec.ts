import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import { actorWith, READER } from '../../../tests/fakes/actors.js';
import { ConceptEmbedder } from '../../../tests/fakes/concept-embedder.js';
import {
  FakeSnapshot,
  module,
  readable,
} from '../../../tests/fakes/fake-content.js';
import { FakeJobQueue } from '../../../tests/fakes/fake-job-queue.js';
import { contentSearchContract } from '../../../tests/content-search-contract.js';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { TimedOutError, UnavailableError } from '../../base/core/errors.js';
import { EmbedSearchTextsAction } from '../core/actions/embed-search-texts.action.js';
import { type Embedder, MAX_EMBED_TEXT_LENGTH } from '../core/embedder.js';
import { EMBED_SEARCH_TEXTS } from '../core/search-texts.js';
import { DrizzleSearchTextStore } from './drizzle-search-text-store.js';
import { NoEmbedder } from './no-embedder.js';
import {
  clearSearchIndex,
  cutText,
  jsonText,
  MAX_MEMBER_SETS,
  memberSets,
  PostgresContentSearch,
  type PostgresContentSearchOptions,
  SearchBudget,
  scopeDigest,
  STATEMENT_TIMEOUT_MS,
  SWEEP_SCOPES,
} from './postgres-content-search.js';

const KEPT = 4;

/** The concept embedder under another model's name: a model change. */
class OtherConceptEmbedder extends ConceptEmbedder {
  override readonly model = 'other-concepts@7';
}
/**
 * A clock that never moves: a search's time budget is never spent, however
 * slow the machine (#604). A test of the budget passes its own `now`.
 */
const STOPPED = (): number => 0;

let database: PgliteDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(() => database?.close());

const make = (
  embedder: Embedder = new NoEmbedder(),
  jobs?: FakeJobQueue,
  options: Partial<PostgresContentSearchOptions> = {},
  db: PgliteDatabase = database,
): PostgresContentSearch =>
  new PostgresContentSearch(db, embedder, jobs, {
    indexesKept: KEPT,
    minSimilarity: 0.5,
    timeoutMs: 5_000,
    concurrency: 4,
    now: STOPPED,
    ...options,
  });

contentSearchContract('PostgresContentSearch', () => make(), KEPT);

const text = (id: string, title: string, body: string, lang = 'en'): Module => {
  const base = module(id, lang, body);
  return { ...base, meta: { ...base.meta, title } };
};
const ALL = { number: 1, size: 100 };

const count = async (table: string): Promise<number> => {
  const { rows } = await database.db.execute<{ n: number }>(
    sql.raw(`select count(*)::int as n from ${table}`),
  );
  return rows[0]?.n ?? 0;
};

describe('PostgresContentSearch: words, word forms and typos', () => {
  it('finds other word forms of the language, and shows where they are', async () => {
    const content = readable({
      modules: [
        text('a', 'Pump', 'The pump starts automatically.'),
        text('b', 'Spare parts', 'Two batteries are included.'),
        text('c', 'Wartung', 'Die Prüfung dauert eine Stunde.', 'de'),
      ],
    });
    const search = make();
    const starting = await search.search(content, 'starting', {}, ALL);
    expect(starting.items).toEqual([
      expect.objectContaining({
        id: 'en/a',
        matchedOn: 'text',
        blockId: 'p',
        excerpt: 'The pump starts automatically.',
        matches: [{ start: 9, end: 15 }],
      }),
    ]);
    expect(
      (await search.search(content, 'battery', {}, ALL)).items.map((h) => h.id),
    ).toEqual(['en/b']);
    // German, stemmed as German: "Prüfung" for "Prüfungen".
    expect(
      (
        await search.search(content, 'Prüfungen', { lang: 'de' }, ALL)
      ).items.map((h) => [
        h.id,
        h.excerpt.slice(h.matches[0]?.start, h.matches[0]?.end),
      ]),
    ).toEqual([['de/c', 'Prüfung']]);
  });

  it('finds a title or keyword with a typo in it', async () => {
    const content = readable({
      modules: [
        text('a', 'Machine maintenance', 'Check it weekly.'),
        {
          ...text('b', 'Other', 'x'),
          meta: { ...text('b', 'Other', 'x').meta, keywords: ['calibration'] },
        },
        text('c', 'Unrelated', 'Nothing here.'),
      ],
    });
    const search = make();
    expect(
      (await search.search(content, 'machnie', {}, ALL)).items.map((h) => [
        h.id,
        h.matchedOn,
        h.excerpt,
      ]),
    ).toEqual([['en/a', 'title', 'Machine maintenance']]);
    expect(
      (await search.search(content, 'calibraton', {}, ALL)).items.map((h) => [
        h.id,
        h.matchedOn,
      ]),
    ).toEqual([['en/b', 'keyword']]);
  });

  it('takes control characters in a query as spaces', async () => {
    const content = readable({ modules: [text('nul', 'Zebra', 'Crossing.')] });
    const found = await make().search(
      content,
      'zeb\u0000ra\u0007 crossing',
      {},
      ALL,
    );
    expect(found.total).toBe(0);
    expect(
      (await make().search(content, 'zebra\u0000', {}, ALL)).items.map(
        (h) => h.id,
      ),
    ).toEqual(['en/nul']);
  });

  it('takes any query text as words, never as SQL or tsquery syntax', async () => {
    const content = readable({
      modules: [text('a', 'Pump', "O'Brien's pump: start & stop!")],
    });
    const search = make();
    for (const query of [
      "'); drop table search_documents; --",
      "a & b | !c :* ( ' \\",
      'start & stop',
      "o'brien",
      '%_*',
    ]) {
      await expect(search.search(content, query, {}, ALL)).resolves.toEqual(
        expect.objectContaining({ total: expect.any(Number) }),
      );
    }
    expect(await count('search_documents')).toBeGreaterThan(0);
    expect(
      (await search.search(content, 'start & stop', {}, ALL)).items.map(
        (h) => h.id,
      ),
    ).toEqual(['en/a']);
  });
});

describe('PostgresContentSearch: order', () => {
  it('puts a match only by typo after every word match', async () => {
    const content = readable({
      modules: [
        text('rotor', 'Rotor', 'Spins.'),
        text('drive', 'Drive unit', 'The motor starts slowly.'),
      ],
    });
    const found = await make().search(content, 'motor', {}, ALL);
    expect(found.items.map((h) => [h.id, h.matchedOn])).toEqual([
      ['en/drive', 'text'],
      ['en/rotor', 'title'],
    ]);
  });
});

describe('PostgresContentSearch: the index', () => {
  it('indexes a commit once, and on a later commit only the modules that changed', async () => {
    const before = await count('search_documents');
    const one = new FakeSnapshot({
      modules: [text('a', 'Alpha', 'First.'), text('b', 'Beta', 'Second.')],
    });
    const two = new FakeSnapshot({
      modules: [
        text('a', 'Alpha', 'First.'),
        text('b', 'Beta', 'Second, changed.'),
      ],
    });
    const search = make();
    await search.search(readable(one), 'alpha', {}, ALL);
    expect(await count('search_documents')).toBe(before + 2);
    // Another reader of the same commit, with another scope: no new document.
    await search.search(
      readable(one, actorWith(['content.read'], { languages: ['en'] })),
      'alpha',
      {},
      ALL,
    );
    expect(await count('search_documents')).toBe(before + 2);
    await search.search(readable(two), 'changed', {}, ALL);
    // Only the changed module is a new document.
    expect(await count('search_documents')).toBe(before + 3);
    // A new server (nothing known in memory) finds them in the database.
    await make().search(readable(two), 'changed', {}, ALL);
    expect(await count('search_documents')).toBe(before + 3);
  });

  it('indexes again what `index-rebuild` emptied, under a server that knew it', async () => {
    const snapshot = new FakeSnapshot({
      modules: [text('a', 'Gamma', 'Third.')],
    });
    const content = readable(snapshot);
    const search = make();
    expect((await search.search(content, 'gamma', {}, ALL)).total).toBe(1);
    await clearSearchIndex(database);
    expect(await count('search_documents')).toBe(0);
    // The same scope, and another reader's new scope of the same documents.
    expect((await search.search(content, 'third', {}, ALL)).total).toBe(1);
    await clearSearchIndex(database);
    const other = readable(
      snapshot,
      actorWith(['content.read'], { languages: ['en'] }),
    );
    expect((await search.search(other, 'third', {}, ALL)).total).toBe(1);
    expect(await count('search_documents')).toBe(1);
  });

  it('indexes any text: a character cut at the embedding limit, a lone surrogate, a NUL', async () => {
    const long = `${'a'.repeat(MAX_EMBED_TEXT_LENGTH - 'Odd\n\n'.length - 1)}😀 tail`;
    const content = readable({
      modules: [
        text('long', 'Odd', long),
        text('broken', 'Broken \ud800 title', 'Nul \u0000 here, zebra.'),
      ],
    });
    const found = await make().search(content, 'zebra', {}, ALL);
    expect(found.items.map((h) => h.id)).toEqual(['en/broken']);
    expect((await make().search(content, 'odd', {}, ALL)).total).toBe(1);
    expect(cutText('ab😀', 3)).toBe('ab');
    expect(cutText('ab😀', 4)).toBe('ab😀');
    expect(JSON.parse(jsonText({ t: 'a\ud800\u0000b' }))).toEqual({
      t: 'a\ufffdb',
    });
  });

  it('keeps each commit to what its readers may read, as rows that name no reader', async () => {
    const snapshot = new FakeSnapshot({
      modules: [text('open', 'Open', 'x')],
    });
    await make().search(readable(snapshot), 'open', {}, ALL);
    const { rows } = await database.db.execute<{ digest: string }>(
      sql`select digest from search_scopes`,
    );
    for (const { digest } of rows) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PostgresContentSearch: member sets (#643)', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(() => db?.close());

  const rows = async (query: string): Promise<number> => {
    const { rows } = await db.db.execute<{ n: number }>(
      sql.raw(`select count(*)::int as n from (${query}) q`),
    );
    return rows[0]?.n ?? 0;
  };
  /** The document keys a scope leads to, as every query reaches them. */
  const documentsOf = async (digest: string): Promise<string[]> => {
    const { rows } = await db.db.execute<{ key: string }>(sql`
      select d.key from search_scopes s
      cross join unnest(s.sets) as ss(set_id)
      join search_member_sets ms on ms.id = ss.set_id
      cross join unnest(ms.docs) as sm(doc_id)
      join search_documents d on d.id = sm.doc_id
      where s.digest = ${digest} order by d.key`);
    return rows.map((row) => row.key);
  };
  const modules = (n: number, changed?: number) =>
    Array.from({ length: n }, (_, i) =>
      text(
        `m${i}`,
        `Module ${i}`,
        i === changed ? 'Changed text.' : `Text ${i}.`,
      ),
    );

  it('cuts a scope into disjoint sets of about the square root of its size', () => {
    const keys = Array.from({ length: 1_000 }, (_, i) => `1:english:${i}`);
    const sets = memberSets([...keys, ...keys.slice(0, 10)]);
    // 32 buckets (32² ≥ 1,000), each about 31 documents.
    expect(sets.length).toBeLessThanOrEqual(32);
    expect(sets.length).toBeGreaterThan(24);
    const all = sets.flatMap((set) => set.keys);
    expect(all.length).toBe(1_000);
    expect(new Set(all)).toEqual(new Set(keys));
    for (const set of sets) expect(set.hash).toMatch(/^[0-9a-f]{64}$/);
    // The same keys in another order: the same sets.
    expect(memberSets([...keys].reverse())).toEqual(sets);
    // A key replaced: the sets of its bucket and of the new key's change, the rest stay.
    const changed = memberSets([...keys.slice(1), '1:english:new']);
    const before = new Set(sets.map((set) => set.hash));
    const fresh = changed.filter((set) => !before.has(set.hash)).length;
    expect(fresh).toBeGreaterThanOrEqual(1);
    expect(fresh).toBeLessThanOrEqual(2);
    expect(memberSets([]).length).toBe(0);
    expect(memberSets(['a']).length).toBe(1);
    const huge = Array.from({ length: 2_000_000 }, (_, i) => String(i));
    expect(memberSets(huge).length).toBe(MAX_MEMBER_SETS);
  });

  /** The IDs of a scope's member sets. */
  const setsOf = async (digest: string): Promise<string[]> => {
    const { rows } = await db.db.execute<{ id: string }>(sql`
      select unnest(sets)::text as id from search_scopes where digest = ${digest}`);
    return rows.map((row) => row.id);
  };

  it('shares the sets of a commit with the next, but those of the modules it changed', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    const one = readable(new FakeSnapshot({ modules: modules(60) }));
    const two = readable(new FakeSnapshot({ modules: modules(60, 7) }));
    await search.search(one, 'module', {}, ALL);
    // 60 documents: 8 buckets (8² ≥ 60), a set each.
    const first = await setsOf(scopeDigest(one));
    expect(first).toHaveLength(8);
    expect(await rows('select 1 from search_member_sets')).toBe(8);
    await search.search(two, 'changed', {}, ALL);
    // One module changed: the sets of its old and its new key's buckets
    // are new (one or two), the others shared.
    const second = await setsOf(scopeDigest(two));
    const fresh = second.filter((id) => !first.includes(id));
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.length).toBeLessThanOrEqual(2);
    expect(await rows('select 1 from search_member_sets')).toBe(
      8 + fresh.length,
    );
    expect(await documentsOf(scopeDigest(two))).toHaveLength(60);
    expect((await search.search(two, 'changed', {}, ALL)).total).toBe(1);
    expect((await search.search(one, 'changed', {}, ALL)).total).toBe(0);
  });

  it('gives two readers of one commit with different visibility different scopes', async () => {
    const snapshot = new FakeSnapshot({
      modules: [
        text('pump', 'Pump', 'The pump starts.'),
        text('pumpe', 'Pumpe', 'Die Pumpe startet.', 'de'),
      ],
    });
    const wide = readable(snapshot);
    const narrow = readable(
      snapshot,
      actorWith(['content.read'], { languages: ['en'] }),
    );
    const search = make(new NoEmbedder(), undefined, {}, db);
    expect(
      (await search.search(wide, 'pump', {}, ALL)).items.map((h) => h.id),
    ).toEqual(['en/pump', 'de/pumpe']);
    expect(
      (await search.search(narrow, 'pump', {}, ALL)).items.map((h) => h.id),
    ).toEqual(['en/pump']);
    expect(scopeDigest(wide)).not.toBe(scopeDigest(narrow));
    const ofWide = await documentsOf(scopeDigest(wide));
    const ofNarrow = await documentsOf(scopeDigest(narrow));
    expect(ofWide).toHaveLength(2);
    expect(ofNarrow).toHaveLength(1);
    expect(ofWide).toEqual(expect.arrayContaining(ofNarrow));
    // The narrow reader's scope leads to no set naming the German module.
    const { rows: german } = await db.db.execute<{ id: string }>(
      sql`select id::text as id from search_documents where lang = 'de'`,
    );
    expect(
      await rows(
        `select 1 from search_scopes s join search_member_sets ms on ms.id = any(s.sets)
         where s.digest = '${scopeDigest(narrow)}' and ${german[0]?.id}::bigint = any(ms.docs)`,
      ),
    ).toBe(0);
  });

  it('drops an old scope with the sets only it named, keeps the shared ones, then the documents', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    const one = readable(new FakeSnapshot({ modules: modules(60) }));
    const two = readable(new FakeSnapshot({ modules: modules(60, 7) }));
    await search.search(one, 'module', {}, ALL);
    await search.search(two, 'module', {}, ALL);
    await db.db.execute(sql`
      update search_scopes set used_at = used_at - interval '8 days'
      where digest = ${scopeDigest(one)}`);
    await db.db.execute(
      sql`update search_documents set created_at = created_at - interval '8 days'`,
    );
    const kept = await setsOf(scopeDigest(two));
    const onlyOne = (await setsOf(scopeDigest(one))).filter(
      (id) => !kept.includes(id),
    );
    const report = await search.sweep();
    expect(report).toMatchObject({
      scopes: 1,
      memberSets: onlyOne.length,
      documents: 1,
      complete: true,
    });
    expect(report.scopeMembers).toBeGreaterThan(0);
    expect(await rows('select 1 from search_member_sets')).toBe(kept.length);
    expect(await documentsOf(scopeDigest(two))).toHaveLength(60);
    expect((await search.search(two, 'module', {}, ALL)).total).toBe(60);
  });

  it('drops a set no scope names, wherever it came from', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    await search.search(
      readable(new FakeSnapshot({ modules: modules(3) })),
      'module',
      {},
      ALL,
    );
    const sets = await rows('select 1 from search_member_sets');
    await db.db.execute(
      sql`insert into search_member_sets (hash, docs) values (${'e'.repeat(64)}, '{1}')`,
    );
    expect(await search.sweep()).toMatchObject({ memberSets: 1, scopes: 0 });
    expect(await rows('select 1 from search_member_sets')).toBe(sets);
  });

  it('drops at most SWEEP_SCOPES scopes per run, and the rest on the next', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    await db.db.execute(sql`
      insert into search_scopes (digest, sets, used_at)
      select encode(sha256(i::text::bytea), 'hex'), '{}', now() - interval '8 days'
      from generate_series(1, ${SWEEP_SCOPES + 5}) as i`);
    expect(await search.sweep()).toMatchObject({
      scopes: SWEEP_SCOPES,
      complete: false,
    });
    expect(await search.sweep()).toMatchObject({ scopes: 5, complete: true });
  });

  it('drops the sets of the scope that reached the bound in the same run', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    await search.search(
      readable(new FakeSnapshot({ modules: modules(10) })),
      'module',
      {},
      ALL,
    );
    await db.db.execute(sql`
      insert into search_scopes (digest, sets, used_at)
      select encode(sha256(i::text::bytea), 'hex'), '{}', now() - interval '8 days'
      from generate_series(1, ${SWEEP_SCOPES - 1}) as i`);
    // The searched scope is past the grace period too, and sorts last: the
    // 200th dropped, the one that reaches the bound.
    await db.db.execute(sql`
      update search_scopes set used_at = now() - interval '7 days 23 hours'
      where cardinality(sets) > 0`);
    expect(await search.sweep()).toMatchObject({
      scopes: SWEEP_SCOPES,
      complete: false,
      scopeMembers: 10,
    });
    expect(await rows('select 1 from search_member_sets')).toBe(0);
  });

  it('writes the sets of a scope again when the sweep dropped them and the server knew the scope', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    const content = readable(new FakeSnapshot({ modules: modules(10) }));
    await search.search(content, 'module', {}, ALL);
    // As a sweep leaves it: the scope gone, its sets and documents too.
    await db.db.execute(sql`delete from search_scopes`);
    await db.db.execute(sql`delete from search_member_sets`);
    await db.db.execute(sql`delete from search_documents`);
    expect((await search.search(content, 'module', {}, ALL)).total).toBe(10);
    expect(await documentsOf(scopeDigest(content))).toHaveLength(10);
  });
});

describe('PostgresContentSearch: meaning', () => {
  const snapshot = async (modules: Module[]) =>
    new FakeSnapshot({
      modules,
      config: {
        ...(await new FakeSnapshot().config()),
        audiences: [
          { id: 'public', label: 'Public' },
          { id: 'internal', label: 'Internal' },
        ],
      },
    });
  const fault = text(
    'fault',
    'Fault: drive does not power up',
    'Check the fuse first.',
  );
  const cleaning = text('cleaning', 'Cleaning', 'Wipe the housing.');
  const hidden = {
    ...text('hidden', 'Internal: motor will not boot', 'Reset the board.'),
  };
  hidden.meta = { ...hidden.meta, audience: 'internal' };

  it('finds a paraphrase by meaning once its text is embedded, scoped like the rest', async () => {
    const embedder = new ConceptEmbedder();
    const jobs = new FakeJobQueue();
    const search = make(embedder, jobs);
    const content = await snapshot([fault, cleaning, hidden]);
    // Before the embedding job ran: nothing by meaning, and the job is asked for.
    expect(
      (await search.search(readable(content), "Machine won't start", {}, ALL))
        .items,
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(jobs.jobs.map((job) => job.queue)).toContain(
        EMBED_SEARCH_TEXTS.name,
      ),
    );
    const embed = new EmbedSearchTextsAction(
      embedder,
      new DrizzleSearchTextStore(database),
    );
    expect(
      await embed.handle({ signal: new AbortController().signal }),
    ).toBeGreaterThan(0);
    // Embedded once: nothing more to do.
    expect(await embed.handle({ signal: new AbortController().signal })).toBe(
      0,
    );
    const found = await make(embedder).search(
      readable(content),
      "Machine won't start",
      {},
      ALL,
    );
    expect(found.items).toContainEqual(
      expect.objectContaining({
        id: 'en/fault',
        matchedOn: 'meaning',
        matches: [],
      }),
    );
    expect(found.items.map((h) => h.id)).not.toContain('en/cleaning');
    // A reader who may not see the internal module is never told of it.
    const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
    const scoped = await make(embedder).search(
      readable(content, publicOnly),
      "Machine won't start",
      {},
      ALL,
    );
    expect(scoped.items.map((h) => h.id)).toEqual(['en/fault']);
    expect(scoped.total).toBe(1);
    const wide = await make(embedder).search(
      readable(content, READER),
      "Machine won't start",
      {},
      ALL,
    );
    expect(wide.items.map((h) => h.id).sort()).toEqual([
      'en/fault',
      'en/hidden',
    ]);
  });

  it('keeps no ranking made while the embedder was down, and asks again for text not embedded', async () => {
    const embedder = new ConceptEmbedder();
    const content = readable(await snapshot([fault, cleaning]));
    await make(embedder).search(content, 'x', {}, ALL);
    await new EmbedSearchTextsAction(
      embedder,
      new DrizzleSearchTextStore(database),
    ).handle({ signal: new AbortController().signal });
    const search = make(embedder);
    embedder.fail = true;
    expect(
      (await search.search(content, "Machine won't start", {}, ALL)).items,
    ).toEqual([]);
    embedder.fail = false;
    expect(
      (await search.search(content, "Machine won't start", {}, ALL)).items,
    ).toContainEqual(
      expect.objectContaining({ id: 'en/fault', matchedOn: 'meaning' }),
    );

    // Text the job never got to: a search asks for the job again.
    const jobs = new FakeJobQueue();
    const late = readable(
      await snapshot([text('late', 'Late', 'Added after the job ran.')]),
    );
    const asker = make(embedder, jobs);
    await asker.search(late, 'late', {}, ALL);
    await vi.waitFor(() => expect(jobs.jobs.length).toBeGreaterThan(0));
    jobs.jobs.length = 0;
    await make(embedder, jobs).search(late, 'late', {}, ALL);
    await vi.waitFor(() =>
      expect(jobs.jobs.map((job) => job.queue)).toContain(
        EMBED_SEARCH_TEXTS.name,
      ),
    );
  });

  it('searches by words alone when the embedder fails', async () => {
    const embedder = new ConceptEmbedder();
    embedder.fail = true;
    const content = readable(await snapshot([fault, cleaning]));
    const found = await make(embedder).search(content, 'fuse', {}, ALL);
    expect(found.items.map((h) => [h.id, h.matchedOn])).toEqual([
      ['en/fault', 'text'],
    ]);
  });
});

describe('PostgresContentSearch: the sweep (#540)', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(() => db?.close());

  /** Moves `column` of the rows `where` picks a week and a day into the past. */
  const age = (table: string, column: string, where = 'true') =>
    db.db.execute(
      sql.raw(
        `update ${table} set ${column} = ${column} - interval '8 days' where ${where}`,
      ),
    );
  const rows = async (query: string): Promise<number> => {
    const { rows } = await db.db.execute<{ n: number }>(
      sql.raw(`select count(*)::int as n from (${query}) q`),
    );
    return rows[0]?.n ?? 0;
  };
  const embed = (embedder: Embedder) =>
    new EmbedSearchTextsAction(embedder, new DrizzleSearchTextStore(db)).handle(
      { signal: new AbortController().signal },
    );

  const kept = text('kept', 'Kept', 'Stays in the manual.');
  const draft = text(
    'draft',
    'Secret draft',
    'Unreleased wording about the motor.',
  );
  const draftTexts =
    "select hash from search_texts where text like '%Unreleased%'";
  /** Indexes and embeds a commit with the draft, then the commit after it was deleted; returns both and the draft's text hashes. */
  const deleteDraft = async (
    search: PostgresContentSearch,
    embedder: Embedder,
  ) => {
    const withDraft = readable(new FakeSnapshot({ modules: [kept, draft] }));
    const without = readable(new FakeSnapshot({ modules: [kept] }));
    await search.search(withDraft, 'motor', {}, ALL);
    await embed(embedder);
    const { rows: hashes } = await db.db.execute<{ hash: string }>(
      sql.raw(draftTexts),
    );
    expect(hashes.length).toBeGreaterThan(0);
    // The draft is deleted: its author searches the commit after.
    await search.search(without, 'kept', {}, ALL);
    // A week on: the old commit's scope is unused, the documents old.
    await age(
      'search_scopes',
      'used_at',
      `digest = '${scopeDigest(withDraft)}'`,
    );
    await age('search_documents', 'created_at');
    return { without, hashes: hashes.map((h) => `'${h.hash}'`).join(', ') };
  };

  it('leaves no text and no embedding of a deleted draft once its scope and documents are swept', async () => {
    const embedder = new ConceptEmbedder();
    const search = make(embedder, undefined, {}, db);
    const { without, hashes } = await deleteDraft(search, embedder);
    expect(
      await rows(
        `select 1 from search_embeddings where text_hash in (${hashes})`,
      ),
    ).toBeGreaterThan(0);

    await search.sweep();
    expect(
      await rows(
        "select 1 from search_documents where title_folded like '%secret%'",
      ),
    ).toBe(0);
    // Its text waits out the grace period, then goes with its embeddings.
    await age('search_texts', 'unused_since', 'unused_since is not null');
    await search.sweep();
    expect(await rows(draftTexts)).toBe(0);
    expect(
      await rows(
        `select 1 from search_embeddings where text_hash in (${hashes})`,
      ),
    ).toBe(0);
    // What the current commit uses is all there, embeddings included.
    expect((await search.search(without, 'kept', {}, ALL)).total).toBe(1);
    expect(
      await rows(
        "select 1 from search_texts t join search_embeddings e on e.text_hash = t.hash where t.text like '%Stays%'",
      ),
    ).toBeGreaterThan(0);
  });

  it('drops the embeddings of a model no longer configured, and sends no unused text to the new one', async () => {
    const old = new ConceptEmbedder();
    const { without } = await deleteDraft(make(old, undefined, {}, db), old);
    await make(old, undefined, {}, db).sweep();

    // The model changes: only text still in use is sent to it.
    const next = new OtherConceptEmbedder();
    const search = make(next, undefined, {}, db);
    await search.search(without, 'kept', {}, ALL);
    expect(await embed(next)).toBeGreaterThan(0);
    const sent = next.asked.flat();
    expect(sent.some((t) => t.includes('Stays'))).toBe(true);
    expect(sent.some((t) => t.includes('Unreleased'))).toBe(false);

    // Within the grace period the old model's embeddings stay; after it, they go.
    await search.sweep();
    const ofOld = `select 1 from search_embeddings where model = '${old.model}'`;
    expect(await rows(ofOld)).toBeGreaterThan(0);
    await age('search_embedding_models', 'seen_at', `model = '${old.model}'`);
    await search.sweep();
    expect(await rows(ofOld)).toBe(0);
    expect(
      await rows(
        `select 1 from search_embeddings where model = '${next.model}'`,
      ),
    ).toBeGreaterThan(0);
  });

  it('writes a scope the sweep dropped again, for a server that still knew it', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    const content = readable(new FakeSnapshot({ modules: [kept] }));
    expect((await search.search(content, 'kept', {}, ALL)).total).toBe(1);
    await age('search_scopes', 'used_at');
    await age('search_documents', 'created_at');
    const report = await search.sweep();
    expect(report).toMatchObject({ scopes: 1, documents: 1, complete: true });
    expect(report.scopeMembers).toBeGreaterThan(0);
    expect((await search.search(content, 'manual', {}, ALL)).total).toBe(1);
    expect(await rows('select 1 from search_scopes')).toBe(1);
    // Within the grace period nothing goes.
    expect(await search.sweep()).toMatchObject({
      scopes: 0,
      documents: 0,
      texts: 0,
    });
  });

  it('keeps a text marked unused that a document uses again, and unmarks it', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    await search.search(
      readable(new FakeSnapshot({ modules: [kept] })),
      'kept',
      {},
      ALL,
    );
    const texts = await rows('select 1 from search_texts');
    // As a sweep racing the indexing of the same text could leave it.
    await db.db.execute(
      sql`update search_texts set unused_since = now() - interval '8 days'`,
    );
    expect(await search.sweep()).toMatchObject({ texts: 0 });
    expect(
      await rows('select 1 from search_texts where unused_since is null'),
    ).toBe(texts);
  });

  it('marks a text no part uses that nothing marked, then drops it after the grace period', async () => {
    const search = make(new NoEmbedder(), undefined, {}, db);
    // As two sweeps dropping documents that share it at once could leave it.
    await db.db.execute(
      sql`insert into search_texts (hash, text) values (${'e'.repeat(64)}, 'left over')`,
    );
    expect((await search.sweep()).textsMarked).toBe(1);
    await age('search_texts', 'unused_since', 'unused_since is not null');
    expect(await search.sweep()).toMatchObject({ texts: 1 });
    expect(
      await rows("select 1 from search_texts where text = 'left over'"),
    ).toBe(0);
  });

  it('goes on with the other steps when one fails, and says so', async () => {
    const search = make(new ConceptEmbedder(), undefined, {}, db);
    await db.db.execute(
      sql`insert into search_texts (hash, text) values (${'e'.repeat(64)}, 'left over')`,
    );
    // The model steps fail: their table is gone.
    await db.db.execute(sql.raw('drop table search_embedding_models'));
    expect(await search.sweep()).toMatchObject({
      textsMarked: 1,
      complete: false,
      failed: true,
    });
  });

  it('drops embeddings whose text is gone, and keeps the rest', async () => {
    const embedder = new ConceptEmbedder();
    const search = make(embedder, undefined, {}, db);
    await search.search(
      readable(new FakeSnapshot({ modules: [kept] })),
      'kept',
      {},
      ALL,
    );
    await embed(embedder);
    const before = await rows('select 1 from search_embeddings');
    await db.db.execute(sql`
      insert into search_embeddings (model, text_hash, embedding)
      values (${embedder.model}, ${'f'.repeat(64)}, array[1, 0, 0, 0, 0, 0, 0]::real[])`);
    expect(await search.sweep()).toMatchObject({ orphans: 1 });
    expect(await rows('select 1 from search_embeddings')).toBe(before);
  });

  it('keeps the texts and embeddings through `index-rebuild`, unused until indexed again; `dropEmbeddings` drops them', async () => {
    const embedder = new ConceptEmbedder();
    const content = readable(new FakeSnapshot({ modules: [kept, draft] }));
    await make(embedder, undefined, {}, db).search(content, 'kept', {}, ALL);
    await embed(embedder);
    const texts = await rows('select 1 from search_texts');
    const embeddings = await rows('select 1 from search_embeddings');
    await clearSearchIndex(db);
    expect(
      await rows('select 1 from search_texts where unused_since is not null'),
    ).toBe(texts);
    expect(await rows('select 1 from search_embeddings')).toBe(embeddings);
    // Indexed again: in use, and nothing to embed.
    const again = readable(new FakeSnapshot({ modules: [kept] }));
    await make(embedder, undefined, {}, db).search(again, 'kept', {}, ALL);
    expect(
      await rows(
        "select 1 from search_texts where unused_since is null and text like '%Stays%'",
      ),
    ).toBeGreaterThan(0);
    expect(await embed(embedder)).toBe(0);
    await clearSearchIndex(db, { dropEmbeddings: true });
    expect(await rows('select 1 from search_texts')).toBe(0);
    expect(await rows('select 1 from search_embeddings')).toBe(0);
    expect(await rows('select 1 from search_embedding_models')).toBe(0);
  });

  it("builds the model's vector index concurrently, and again when a build left it invalid", async () => {
    const embedder = new ConceptEmbedder();
    const valid = () =>
      rows(
        "select 1 from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname like 'search_embeddings_hnsw_%' and i.indisvalid",
      );
    expect(await make(embedder, undefined, {}, db).semantic()).toBe(true);
    await vi.waitFor(async () => expect(await valid()).toBe(1));
    // As a build cut off leaves it.
    await db.db.execute(
      sql.raw(
        "update pg_index set indisvalid = false where indexrelid in (select oid from pg_class where relname like 'search_embeddings_hnsw_%')",
      ),
    );
    expect(await valid()).toBe(0);
    expect(await make(embedder, undefined, {}, db).semantic()).toBe(true);
    await vi.waitFor(async () => expect(await valid()).toBe(1));
  });

  it('keeps the pages of one search together while its text is being embedded', async () => {
    const embedder = new ConceptEmbedder();
    const search = make(embedder, undefined, {}, db);
    const content = readable(
      new FakeSnapshot({
        modules: [
          text('a', 'Fault one', 'The drive does not power up.'),
          text('b', 'Fault two', 'The unit will not boot.'),
        ],
      }),
    );
    const first = await search.search(
      content,
      'fault',
      {},
      { number: 1, size: 1 },
    );
    expect(first.total).toBe(2);
    // Embedded meanwhile: the next page comes from the same ranking (not
    // ranked again), so the pages neither overlap nor miss one.
    await embed(embedder);
    const transactions = vi.spyOn(db.db, 'transaction');
    const second = await search.search(
      content,
      'fault',
      {},
      { number: 2, size: 1 },
    );
    // At most the excerpts': no check of what is embedded, no ranking.
    expect(transactions.mock.calls.length).toBeLessThanOrEqual(1);
    transactions.mockRestore();
    expect(second.total).toBe(2);
    expect([...first.items, ...second.items].map((h) => h.id).sort()).toEqual([
      'en/a',
      'en/b',
    ]);
  });
});

describe('SearchBudget (#539)', () => {
  it('counts from the first statement and gives each the time left, at most the statement timeout', () => {
    let now = 1_000;
    const budget = new SearchBudget(8_000, () => now);
    now = 5_000;
    expect(budget.next()).toBe(STATEMENT_TIMEOUT_MS);
    now = 9_500;
    expect(budget.next()).toBe(3_500);
    now = 12_999.5;
    expect(budget.next()).toBe(1);
    now = 13_000;
    expect(() => budget.next()).toThrow(TimedOutError);
  });
});

describe('PostgresContentSearch: limits (#539)', () => {
  const content = () =>
    readable({
      modules: [
        text('a', 'Pump', 'The pump starts automatically.'),
        text('b', 'Valve', 'Replace the valve yearly.'),
      ],
    });

  it('stops a search whose statements together take longer than its budget: 503 database-timeout', async () => {
    // A clock that jumps past the budget between two statements.
    let calls = 0;
    const search = make(new NoEmbedder(), undefined, {
      timeoutMs: 1_000,
      now: () => calls++ * 2_000,
    });
    const refused = await search
      .search(content(), 'pump starts', {}, ALL)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TimedOutError);
    expect(refused).toMatchObject({
      code: 'database-timeout',
      retryAfterSeconds: 1,
    });
    // The same search within its budget (the default clock never moves).
    const found = await make().search(content(), 'pump starts', {}, ALL);
    expect(found.items.map((h) => h.id)).toEqual(['en/a']);
  });

  describe('on a slow database', () => {
    let slow: PgliteDatabase;
    beforeAll(async () => {
      slow = await createTestDatabase();
    });
    afterAll(() => slow?.close());

    /** Every read of a scope's member sets sleeps `seconds` once per statement, from now on. */
    const slowDown = async (seconds: number) => {
      await slow.db.execute(
        sql.raw(
          'alter table search_member_sets rename to search_member_sets_real',
        ),
      );
      await slow.db.execute(
        sql.raw(`create view search_member_sets as select * from search_member_sets_real
          where (select pg_sleep(${seconds})::text) is not null`),
      );
    };
    const speedUp = async () => {
      await slow.db.execute(sql.raw('drop view search_member_sets'));
      await slow.db.execute(
        sql.raw(
          'alter table search_member_sets_real rename to search_member_sets',
        ),
      );
    };

    it('answers a slow query with 503 database-timeout once the budget is spent', async () => {
      // The budget counts real time only for the slow search: indexing
      // first, on a stopped clock, never spends it however loaded the
      // machine is (#604).
      let clock = STOPPED;
      const search = make(
        new NoEmbedder(),
        undefined,
        { timeoutMs: 200, now: () => clock() },
        slow,
      );
      const readable = content();
      // Indexed first, at full speed.
      await search.search(readable, 'valve', {}, ALL);
      await slowDown(0.3);
      clock = () => performance.now();
      try {
        const started = performance.now();
        const refused = await search
          .search(readable, 'pump starts', {}, ALL)
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(TimedOutError);
        // PGlite ignores statement_timeout, so the first slow statement
        // runs out; none starts after it. (Postgres cuts it off at the
        // budget: tests/search-budget-postgres.e2e.spec.ts.)
        expect(performance.now() - started).toBeLessThan(3_000);
      } finally {
        await speedUp();
      }
    });

    it('runs at most `concurrency` searches at once; more wait, then 503 search-busy', async () => {
      const search = make(
        new NoEmbedder(),
        undefined,
        { concurrency: 1 },
        slow,
      );
      const readable = content();
      await search.search(readable, 'valve', {}, ALL);
      await slowDown(0.2);
      try {
        // One runs, four wait (WAITING_PER_SEARCH), the rest are refused at once.
        const answers = await Promise.all(
          Array.from({ length: 8 }, () =>
            search
              .search(readable, 'pump', {}, ALL)
              .then((page) => page.items.map((h) => h.id))
              .catch((error: unknown) => error),
          ),
        );
        expect(answers[0]).toEqual(['en/a']);
        const busy = answers.filter(
          (answer) =>
            answer instanceof UnavailableError && answer.code === 'search-busy',
        );
        expect(busy.length).toBeGreaterThanOrEqual(3);
        for (const answer of answers) {
          if (Array.isArray(answer)) expect(answer).toEqual(['en/a']);
          else expect(answer).toMatchObject({ code: 'search-busy' });
        }
      } finally {
        await speedUp();
      }
    });
  });
});
