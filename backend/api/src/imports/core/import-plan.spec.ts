import { createHash } from 'node:crypto';
import { validateImport } from '@openfolia/content-model';
import { actorWith } from '../../../tests/fakes/actors.js';
import {
  config,
  manifest,
  module,
  readable,
} from '../../../tests/fakes/fake-content.js';
import type { Actor } from '../../access/core/actor.js';
import { batches, decisionsOf, planImport } from './import-plan.js';
import { replayPlan } from './import-pipeline.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const editor = actorWith(['content.edit', 'content.read']);
const settings = {
  maxImageBytes: 1024 * 1024,
  maxAttachmentBytes: 1024 * 1024,
  attachmentTypes: { allow: [], deny: [], open: [] },
} as never;

const moduleJson = (
  id: string,
  lang = 'en',
  blocks: unknown[] = [
    {
      type: 'paragraph',
      id: 'intro',
      content: [{ type: 'text', text: 'Hello.' }],
    },
  ],
) => ({
  schemaVersion: 1,
  id,
  meta: { title: id, type: 'concept', lang, audience: 'public' },
  blocks,
});

function bundle(document: unknown, files: Record<string, Uint8Array> = {}) {
  return {
    files: new Map<string, Uint8Array>([
      ['import.json', Buffer.from(JSON.stringify(document))],
      ...Object.entries(files),
    ]),
  };
}

async function plan(
  document: unknown,
  {
    files = {},
    existing = [] as ReturnType<typeof module>[],
    manuals = [] as ReturnType<typeof manifest>[],
    actor = editor as Actor,
    updateExisting = false,
  } = {},
) {
  const b = bundle(document, files);
  const validation = await validateImport(b, config, {
    existing: {
      modules: new Set(existing.map((m) => m.id)),
      manuals: new Set(manuals.map((m) => m.id)),
      assets: new Set<string>(),
    },
  });
  return {
    bundle: b,
    validation,
    plan: await planImport(b, validation, {
      actor,
      snapshot: readable(
        { config, modules: existing, manifests: manuals },
        actor,
      ),
      config,
      updateExisting,
      settings,
    }),
  };
}

const actions = (report: Awaited<ReturnType<typeof plan>>['plan']['report']) =>
  report.items.map((i) => [
    i.kind,
    i.lang ?? '',
    i.id,
    i.action,
    i.reasons.map((r) => r.code),
  ]);

describe('planImport', () => {
  it('creates new modules (source language first) and manuals', async () => {
    const { plan: p } = await plan({
      formatVersion: 1,
      modules: [moduleJson('b', 'de'), moduleJson('b'), moduleJson('a')],
      manuals: [
        {
          schemaVersion: 1,
          id: 'guide',
          title: 'Guide',
          audience: 'public',
          variants: [{ model: 'small' }],
          entries: [{ module: 'a' }],
        },
      ],
    });
    expect(actions(p.report)).toEqual([
      ['module', 'de', 'b', 'create', []],
      ['module', 'en', 'b', 'create', []],
      ['module', 'en', 'a', 'create', []],
      ['manual', '', 'guide', 'create', []],
    ]);
    expect(p.report.applicable).toBe(true);
    expect(p.report.counts).toMatchObject({ create: 4, skip: 0, refuse: 0 });
    expect(
      p.writes.map((w) =>
        w.subject.type === 'module'
          ? `${w.subject.lang}/${w.subject.moduleId}`
          : w.subject.type,
      ),
    ).toEqual(['en/a', 'en/b', 'de/b', 'manual']);
  });

  it('skips what exists, unless updating existing ones', async () => {
    const document = { formatVersion: 1, modules: [moduleJson('charging')] };
    const existing = [module('charging')];
    const skipped = await plan(document, { existing });
    expect(actions(skipped.plan.report)).toEqual([
      ['module', 'en', 'charging', 'skip', ['exists']],
    ]);
    // Nothing to write: not applicable.
    expect(skipped.plan.report.applicable).toBe(false);
    expect(skipped.plan.report.issues.map((i) => i.code)).toContain(
      'nothing-to-import',
    );
    const updated = await plan(document, { existing, updateExisting: true });
    expect(actions(updated.plan.report)).toEqual([
      ['module', 'en', 'charging', 'update', []],
    ]);
    expect(updated.plan.writes).toHaveLength(1);
  });

  it('skips what the target holds exactly so, even when updating existing ones: unchanged', async () => {
    const stored = module('charging');
    const guide = manifest('guide', ['charging']);
    const same = {
      formatVersion: 1,
      modules: [stored, { ...module('other'), id: 'other' }],
      manuals: [guide],
    };
    const again = await plan(same, {
      existing: [stored],
      manuals: [guide],
      updateExisting: true,
    });
    expect(actions(again.plan.report)).toEqual([
      ['module', 'en', 'charging', 'skip', ['unchanged']],
      ['module', 'en', 'other', 'create', []],
      ['manual', '', 'guide', 'skip', ['unchanged']],
    ]);
    expect(again.plan.writes.map((w) => w.subject.type)).toEqual(['module']);
    // A changed one is updated.
    const changed = await plan(
      { formatVersion: 1, modules: [module('charging', 'en', 'Changed.')] },
      { existing: [stored], updateExisting: true },
    );
    expect(actions(changed.plan.report)).toEqual([
      ['module', 'en', 'charging', 'update', []],
    ]);
    // Without "update existing", it is skipped as before: it exists.
    const kept = await plan(same, { existing: [stored], manuals: [guide] });
    expect(kept.plan.report.items[0]?.reasons.map((r) => r.code)).toEqual([
      'exists',
    ]);
  });

  it('keeps a manual’s committed translation record when updating it (#663)', async () => {
    const translations = {
      de: { sourceCommit: 'a'.repeat(40), blocks: {} },
    };
    const guide = { ...manifest('guide', ['charging']), translations };
    const renamed = { ...manifest('guide', ['charging']), title: 'Renamed' };
    const existing = [module('charging')];
    const updated = await plan(
      { formatVersion: 1, manuals: [renamed] },
      { existing, manuals: [guide], updateExisting: true },
    );
    expect(actions(updated.plan.report)).toEqual([
      ['manual', '', 'guide', 'update', []],
    ]);
    expect(updated.plan.writes[0]?.content).toMatchObject({
      title: 'Renamed',
      translations,
    });
    // The same manual again: unchanged, its record and all.
    const same = await plan(
      { formatVersion: 1, manuals: [manifest('guide', ['charging'])] },
      { existing, manuals: [guide], updateExisting: true },
    );
    expect(actions(same.plan.report)).toEqual([
      ['manual', '', 'guide', 'skip', ['unchanged']],
    ]);
  });

  it('refuses invalid items with the validator’s errors', async () => {
    const broken = {
      ...moduleJson('x'),
      meta: { ...moduleJson('x').meta, type: 'nope' },
    };
    const { plan: p } = await plan({ formatVersion: 1, modules: [broken] });
    expect(p.report.items[0]?.action).toBe('refuse');
    expect(p.report.items[0]?.reasons.map((r) => r.code)).toContain(
      'unknown-module-type',
    );
    expect(p.report.applicable).toBe(false);
    expect(p.writes).toEqual([]);
  });

  it('refuses what the actor may not change: outside-scope', async () => {
    const narrow = actorWith(['content.edit', 'content.read'], {
      languages: ['de'],
    });
    const { plan: p } = await plan(
      { formatVersion: 1, modules: [moduleJson('x'), moduleJson('x', 'de')] },
      { actor: narrow },
    );
    expect(actions(p.report)).toEqual([
      ['module', 'en', 'x', 'refuse', ['outside-scope']],
      ['module', 'de', 'x', 'create', []],
    ]);
  });

  it('uploads a used image, and skips an unused file', async () => {
    const hash = sha(PNG);
    const other = Buffer.from('unused');
    const { plan: p } = await plan(
      {
        formatVersion: 1,
        modules: [
          moduleJson('x', 'en', [
            {
              type: 'image',
              id: 'pic',
              asset: `sha256:${hash}`,
              alt: 'A pixel',
            },
          ]),
        ],
      },
      { files: { [`assets/${hash}`]: PNG, [`assets/${sha(other)}`]: other } },
    );
    const assets = p.report.items.filter((i) => i.kind === 'asset');
    expect(
      assets.map((i) => [
        i.id,
        i.action,
        i.usedAs,
        i.reasons.map((r) => r.code),
      ]),
    ).toEqual(
      expect.arrayContaining([
        [`sha256:${hash}`, 'create', 'image', []],
        [`sha256:${sha(other)}`, 'skip', undefined, ['unused']],
      ]),
    );
    expect(p.uploads.map((u) => [u.sha256, u.kind])).toEqual([[hash, 'image']]);
  });

  it('refuses an image that is no image the upload route takes', async () => {
    const fake = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const hash = sha(fake);
    const { plan: p } = await plan(
      {
        formatVersion: 1,
        modules: [
          moduleJson('x', 'en', [
            {
              type: 'image',
              id: 'pic',
              asset: `sha256:${hash}`,
              alt: 'Vector',
            },
          ]),
        ],
      },
      { files: { [`assets/${hash}`]: fake } },
    );
    const asset = p.report.items.find((i) => i.kind === 'asset');
    expect(asset?.action).toBe('refuse');
    expect(asset?.reasons.map((r) => r.code)).toEqual([
      'unsupported-image-type',
    ]);
    expect(p.report.applicable).toBe(false);
  });

  it('replays the same writes and uploads from its report', async () => {
    const hash = sha(PNG);
    const document = {
      formatVersion: 1,
      modules: [
        moduleJson('x', 'en', [
          { type: 'image', id: 'pic', asset: `sha256:${hash}`, alt: 'A pixel' },
        ]),
        moduleJson('x', 'de'),
      ],
    };
    const { plan: p, bundle: b } = await plan(document, {
      files: { [`assets/${hash}`]: PNG },
    });
    const validation = await validateImport(b, config, {});
    const replayed = replayPlan(b, validation, p.report, 'en');
    expect(replayed.writes.map((w) => w.subject)).toEqual(
      p.writes.map((w) => w.subject),
    );
    expect(replayed.uploads.map((u) => [u.sha256, u.kind])).toEqual(
      p.uploads.map((u) => [u.sha256, u.kind]),
    );
    expect(decisionsOf(p.report)).toEqual([
      'module:en:x:create',
      'module:de:x:create',
      `asset::sha256:${hash}:create`,
    ]);
  });
});

describe('batches', () => {
  const write = (bytes: number) => ({ bytes }) as never;

  it('cuts writes into save points within the file and byte limits', () => {
    const writes = [write(10), write(10), write(10), write(50), write(5)];
    expect(
      batches(writes, { files: 2, bytes: 1000 }).map((b) => b.length),
    ).toEqual([2, 2, 1]);
    expect(
      batches(writes, { files: 10, bytes: 30 }).map((b) => b.length),
    ).toEqual([3, 1, 1]);
    // One larger than the byte limit still goes, alone.
    expect(batches([write(100)], { files: 10, bytes: 30 })).toHaveLength(1);
    expect(batches([], { files: 1, bytes: 1 })).toEqual([]);
  });
});
