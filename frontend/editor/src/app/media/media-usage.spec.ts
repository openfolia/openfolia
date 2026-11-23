import type { Block } from '@openfolia/content-model/core';

import type { MediaItem } from './media-model';
import { MAX_MODULES, readUsage, type ModuleBlocks } from './media-usage';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const image = (id: string, hash: string, alt: string): Block => ({
  type: 'image',
  id,
  asset: `sha256:${hash}`,
  alt,
});

const item = (
  usedIn: { moduleId: string; lang: string; title: string }[],
  usedInCount = usedIn.length,
): MediaItem => ({
  type: 'Asset',
  id: HASH,
  attributes: {
    reference: `sha256:${HASH}`,
    fileName: null,
    contentType: 'image/png',
    size: 10,
    width: 10,
    height: 10,
    font: null,
  },
  meta: {
    usedIn,
    usedInCount,
    usedInManuals: [],
    languages: [...new Set(usedIn.map((u) => u.lang))].sort(),
    usedAs: ['image'],
    uploaded: false,
    missing: false,
  },
});

describe('readUsage', () => {
  it('finds the blocks per language with their alt text, and another image in a language', async () => {
    const modules: Record<string, ModuleBlocks> = {
      'en/pump': {
        title: 'Pump',
        blocks: [
          {
            type: 'section',
            id: 's1',
            title: [],
            blocks: [image('img1', HASH, 'A pump')],
          } as unknown as Block,
        ],
      },
      'de/pump': {
        title: 'Pumpe',
        blocks: [image('img1', OTHER, 'Eine Pumpe')],
      },
      'fr/pump': { title: 'Pompe', blocks: [image('img1', HASH, 'Une pompe')] },
    };
    const reads: string[] = [];
    const usage = await readUsage(
      item([
        { moduleId: 'pump', lang: 'en', title: 'Pump' },
        { moduleId: 'pump', lang: 'fr', title: 'Pompe' },
      ]),
      ['en', 'de', 'fr', 'it'],
      async (lang, id) => {
        reads.push(`${lang}/${id}`);
        return modules[`${lang}/${id}`] ?? null;
      },
    );
    expect(reads.sort()).toEqual(['de/pump', 'en/pump', 'fr/pump', 'it/pump']);
    expect(usage.more).toBe(0);
    expect(
      usage.rows.map((r) => [r.lang, r.kind, r.blockId, r.alt, r.otherAsset]),
    ).toEqual([
      ['en', 'same', 'img1', 'A pump', null],
      ['de', 'other', 'img1', 'Eine Pumpe', `sha256:${OTHER}`],
      ['fr', 'same', 'img1', 'Une pompe', null],
    ]);
  });

  it('fails when a module cannot be read, so the details offer Retry', async () => {
    await expect(
      readUsage(
        item([{ moduleId: 'pump', lang: 'en', title: 'Pump' }]),
        ['en'],
        () => Promise.reject(new Error('offline')),
      ),
    ).rejects.toThrow('offline');
  });

  it('keeps a module the reader may not see, without its block', async () => {
    const usage = await readUsage(
      item([{ moduleId: 'pump', lang: 'en', title: 'Pump' }]),
      ['en'],
      () => Promise.resolve(null),
    );
    expect(usage.rows).toEqual([
      {
        lang: 'en',
        moduleId: 'pump',
        title: 'Pump',
        blockId: null,
        alt: null,
        kind: 'same',
        otherAsset: null,
      },
    ]);
  });

  it(`reads at most ${MAX_MODULES} modules and says how many more use it`, async () => {
    const uses = Array.from({ length: MAX_MODULES + 2 }, (_, i) => ({
      moduleId: `m${i}`,
      lang: 'en',
      title: `M${i}`,
    }));
    let reads = 0;
    const usage = await readUsage(item(uses, 70), ['en'], async () => {
      reads++;
      return null;
    });
    expect(reads).toBe(MAX_MODULES);
    // The uses of the modules not read, and those beyond the 50 the list names.
    expect(usage.more).toBe(70 - MAX_MODULES);
  });
});
