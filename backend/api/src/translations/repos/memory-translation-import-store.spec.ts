import {
  newTranslationImportId,
  TRANSLATION_IMPORT_TTL_MS,
  type TranslationImport,
} from '../core/translation-import.js';
import {
  MAX_IMPORTS_PER_ACTOR,
  MAX_STORED_CHARACTERS,
  MAX_STORED_IMPORTS,
  MemoryTranslationImportStore,
} from './memory-translation-import-store.js';

let clock = Date.parse('2026-05-01T10:00:00Z');
const now = () => clock;

const stored = (by = 'sample-translator', xliff = '<xliff/>') => {
  const createdAt = new Date(clock);
  clock += 1;
  const record: TranslationImport = {
    id: newTranslationImportId(clock),
    jobId: 'job',
    languages: ['de'],
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    state: 'validated',
    createdBy: { kind: 'user', id: by },
    createdAt,
    expiresAt: new Date(createdAt.getTime() + TRANSLATION_IMPORT_TTL_MS),
    counts: {
      units: 0,
      ok: 0,
      'source-changed': 0,
      'broken-markup': 0,
      'unknown-block': 0,
      'unknown-module': 0,
      'outside-scope': 0,
    },
    modules: [],
  };
  return { import: record, documents: [{ xliff }] };
};

describe('MemoryTranslationImportStore', () => {
  it('keeps an import an hour', async () => {
    const store = new MemoryTranslationImportStore(now);
    const one = stored();
    expect(await store.add(one)).toBe(true);
    expect((await store.find(one.import.id))?.import.id).toBe(one.import.id);
    clock += TRANSLATION_IMPORT_TTL_MS;
    expect(await store.find(one.import.id)).toBeUndefined();
  });

  it('keeps a few per person, replacing their oldest, and refuses once full', async () => {
    const store = new MemoryTranslationImportStore(now);
    const mine = Array.from({ length: MAX_IMPORTS_PER_ACTOR + 1 }, () =>
      stored(),
    );
    for (const s of mine) expect(await store.add(s)).toBe(true);
    expect(await store.find(mine[0]!.import.id)).toBeUndefined();
    expect(await store.find(mine.at(-1)!.import.id)).toBeDefined();
    for (let i = 0; store.size < MAX_STORED_IMPORTS; i++) {
      expect(await store.add(stored(`person-${i}`))).toBe(true);
    }
    expect(await store.add(stored('one-more'))).toBe(false);
    // Refused, it removed nothing of theirs.
    expect(await store.add(stored('person-0'))).toBe(false);
    expect(store.size).toBe(MAX_STORED_IMPORTS);
    // Their own next one still fits: it replaces their oldest.
    expect(await store.add(stored())).toBe(true);
  });

  it('keeps no more characters of documents than its budget, and drops an applied one’s', async () => {
    const store = new MemoryTranslationImportStore(now);
    const half = 'x'.repeat(MAX_STORED_CHARACTERS / 2);
    const first = stored('a', half);
    expect(await store.add(first)).toBe(true);
    expect(await store.add(stored('b', half))).toBe(true);
    expect(await store.add(stored('c', 'y'))).toBe(false);
    await store.claim(first.import.id);
    const applied = await store.settle(first.import.id, {
      changeSetId: 'cs',
      commit: null,
      counts: first.import.counts,
      modules: [],
    });
    expect(applied?.state).toBe('applied');
    expect((await store.find(first.import.id))?.documents).toEqual([]);
    expect(await store.add(stored('c', 'y'))).toBe(true);
  });

  it('claims once, and settles applied or back to validated', async () => {
    const store = new MemoryTranslationImportStore(now);
    const one = stored();
    await store.add(one);
    const claimed = await store.claim(one.import.id);
    expect(claimed?.import.state).toBe('applying');
    expect(await store.claim(one.import.id)).toBeUndefined();
    // Being applied: never replaced, and kept past the hour.
    for (let i = 0; i < MAX_IMPORTS_PER_ACTOR; i++) await store.add(stored());
    expect((await store.find(one.import.id))?.import.state).toBe('applying');
    await store.settle(one.import.id, undefined);
    expect((await store.find(one.import.id))?.import.state).toBe('validated');
    const late = stored('late');
    await store.add(late);
    await store.claim(late.import.id);
    clock += TRANSLATION_IMPORT_TTL_MS;
    expect((await store.find(late.import.id))?.import.state).toBe('applying');
    // Back to validated after its hour: gone.
    await store.settle(late.import.id, undefined);
    expect(await store.find(late.import.id)).toBeUndefined();
    const again = stored();
    await store.add(again);
    await store.claim(again.import.id);
    await store.settle(again.import.id, {
      changeSetId: 'cs',
      commit: 'b'.repeat(40),
      counts: again.import.counts,
      modules: [],
    });
    const applied = (await store.find(again.import.id))?.import;
    expect(applied).toMatchObject({ state: 'applied', changeSetId: 'cs' });
    expect(applied?.expiresAt.getTime()).toBe(
      clock + TRANSLATION_IMPORT_TTL_MS,
    );
  });
});
