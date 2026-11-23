import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import {
  addSampleNoticeLeaflet,
  addSampleSafetyLeaflet,
  SAMPLE_LEAFLET_DESIGN_ID,
  SAMPLE_NOTICE_LEAFLET_ID,
} from '@openfolia/content-repo/testing';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import {
  ManualDocument,
  ResolvedManualDocument,
} from '../src/manuals/api/manual.resources.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { ReleaseOutputPageDocument } from '../src/releases/api/release-output.resources.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #670: a derived manual gathering the operating manual's safety notices, grouped by hazard
 * level: read, checked, resolved and printed per variant and language, only from what the
 * reader may see; refused as a DITA package.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const NOTICES = `/manuals/${SAMPLE_NOTICE_LEAFLET_ID}`;

const publisher = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'notices-publisher',
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await addSampleSafetyLeaflet(dir());
  await addSampleNoticeLeaflet(dir());
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const checks = async (ref = 'main') => {
  const res = await t.get(`${NOTICES}/checks?ref=${encodeURIComponent(ref)}`);
  expect(res.status).toBe(200);
  return CheckPageDocument.parse(res.body).data.map((c) => c.attributes);
};
const resolved = async (variant: string, lang: string, ref = 'main') => {
  const res = await t.get(
    `${NOTICES}/variants/${variant}/${lang}?ref=${encodeURIComponent(ref)}`,
  );
  expect(res.status).toBe(200);
  return ResolvedManualDocument.parse(res.body).data;
};
type Entry =
  | { kind: 'group'; title: string; entries: Entry[] }
  | { kind: 'module'; title: string; blocks: { id: string }[] };
/** Each entry as `title: block IDs`, a group as `{ title: […] }`. */
const outline = (entries: readonly Entry[]): unknown[] =>
  entries.map((e) =>
    e.kind === 'group'
      ? { [e.title]: outline(e.entries) }
      : `${e.title}: ${e.blocks.map((b) => b.id).join(' ')}`,
  );
/** A PDF's page sizes in points, from its `/MediaBox` entries. */
const pageSizes = (pdf: Buffer) =>
  [
    ...pdf
      .toString('latin1')
      .matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
  ].map(([, w, h]) => `${Math.round(Number(w))}x${Math.round(Number(h))}`);
const binary: Parameters<ReturnType<TestApp['get']>['parse']>[0] = (
  r,
  done,
) => {
  const chunks: Buffer[] = [];
  r.on('data', (chunk: Buffer) => chunks.push(chunk));
  r.on('end', () => done(null, Buffer.concat(chunks)));
};
const commitOnMain = async (path: string, content: string) =>
  new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [{ path, content }],
    message: `Change ${path}`,
    author: { name: 'Someone', email: 'someone@example.com' },
  });

describe('a derived manual gathering safety notices (#670)', () => {
  it('reads with its notice gathering and the modules holding notices', async () => {
    const res = await t.get(NOTICES);
    expect(res.status).toBe(200);
    const { attributes } = ManualDocument.parse(res.body).data;
    expect(attributes).toMatchObject({
      kind: 'derived',
      rule: {
        source: 'operating',
        front: ['leaflet-intro'],
        notices: { groupBy: 'level' },
      },
    });
    expect(attributes.entries.map((e) => 'module' in e && e.module)).toEqual([
      'leaflet-intro',
      'battery-hazards',
      'charging',
      'crush-hazard',
      'hose-connection',
    ]);
    expect(
      (await checks()).filter((c) =>
        [
          'safety-notice-excluded',
          'empty-derived-manual',
          'xref-unknown-block',
        ].includes(c.code),
      ),
    ).toEqual([]);
  });

  it('resolves a group per hazard level, titled in the manual’s language, with the variant’s notices', async () => {
    const large = await resolved('model=large', 'en');
    expect(outline(large.attributes.entries as Entry[])).toEqual([
      'About this leaflet: leaflet-intro--text',
      { DANGER: ['Crush hazard: crush-hazard--notice'] },
      {
        WARNING: [
          'Battery hazards: battery-hazards--notice',
          'Connecting the hose: hose-connection--overload',
        ],
      },
      {
        CAUTION: [
          'Charging: safety-note--hot',
          'Connecting the hose: hose-connection--pinch',
        ],
      },
    ]);
    // A notice's ID and origin are its module's, as in the source manual.
    expect(large.attributes.origins['hose-connection--overload']).toEqual({
      module: 'hose-connection',
      block: 'overload',
    });
    const small = await resolved('model=small', 'de');
    expect(outline(small.attributes.entries as Entry[])).toEqual([
      'About this leaflet: leaflet-intro--text',
      { WARNUNG: ['Gefahren durch die Batterie: battery-hazards--notice'] },
      {
        VORSICHT: [
          'Laden: safety-note--hot',
          'Den Schlauch anschließen: hose-connection--pinch',
        ],
      },
    ]);
  });

  it('never shows a notice of a module the reader may not see', async () => {
    // `safety-note` is classified for the north region: a south reader sees none of it.
    t.actAs(actorWith(['content.read'], { facets: { region: ['south'] } }));
    const south = await resolved('model=large', 'en');
    expect(outline(south.attributes.entries as Entry[])).toEqual([
      'About this leaflet: leaflet-intro--text',
      { DANGER: ['Crush hazard: crush-hazard--notice'] },
      {
        WARNING: [
          'Battery hazards: battery-hazards--notice',
          'Connecting the hose: hose-connection--overload',
        ],
      },
      { CAUTION: ['Connecting the hose: hose-connection--pinch'] },
    ]);
    expect(JSON.stringify(south)).not.toMatch(/safety-note|Hot surface/);
    // Nor that `charging`, which they may see, refers to a module holding one: it is not
    // gathered for them.
    const theirs = ManualDocument.parse((await t.get(NOTICES)).body).data;
    expect(
      theirs.attributes.entries.map((e) => 'module' in e && e.module),
    ).toEqual([
      'leaflet-intro',
      'battery-hazards',
      'crush-hazard',
      'hose-connection',
    ]);
    // Nor through where `charging` is used (the module index, gathered for everyone).
    const usedIn = async () => {
      const res = await t.get('/modules/en/charging');
      expect(res.status).toBe(200);
      return ModuleDocument.parse(res.body).data.meta.usedIn.map((u) => u.id);
    };
    expect(await usedIn()).not.toContain(SAMPLE_NOTICE_LEAFLET_ID);
    t.actAs(READER);
    expect(await usedIn()).toContain(SAMPLE_NOTICE_LEAFLET_ID);
    // Readers of safety and concept modules only: no procedure, nor what it refers to.
    t.actAs(
      actorWith(['content.read'], { moduleTypes: ['safety', 'concept'] }),
    );
    const res = await t.get(`${NOTICES}/variants/model=large/en`);
    expect(res.status).toBe(200);
    const typed = ResolvedManualDocument.parse(res.body).data;
    expect(outline(typed.attributes.entries as Entry[])).toEqual([
      'About this leaflet: leaflet-intro--text',
      { DANGER: ['Crush hazard: crush-hazard--notice'] },
      { WARNING: ['Battery hazards: battery-hazards--notice'] },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /hose-connection|Pinching|Overpressure|Hot surface/,
    );
    const manual = await t.get(NOTICES);
    expect(JSON.stringify(manual.body)).not.toContain('hose-connection');
  });

  it('warns about notices its rule leaves out, at the module holding them', async () => {
    const stored = git('show', `main:manuals/${SAMPLE_NOTICE_LEAFLET_ID}.yaml`);
    const { commit } = await commitOnMain(
      `manuals/${SAMPLE_NOTICE_LEAFLET_ID}.yaml`,
      `${stored.replace(
        '    groupBy: level',
        '    groupBy: level\n    levels:\n      - danger\n      - caution',
      )}\n  exclude:\n    - charging\n`,
    );
    expect(
      (await checks(commit))
        .filter((c) => c.code === 'safety-notice-excluded')
        .map((c) => [c.severity, c.params]),
    ).toEqual([
      // Warnings, not a level the rule gathers.
      ['warning', { at: 'battery-hazards' }],
      ['warning', { at: 'hose-connection' }],
      // Reached only through the excluded `charging`.
      ['warning', { at: 'safety-note' }],
    ]);
    const large = await resolved('model=large', 'en', commit);
    expect(outline(large.attributes.entries as Entry[])).toEqual([
      'About this leaflet: leaflet-intro--text',
      { DANGER: ['Crush hazard: crush-hazard--notice'] },
      { CAUTION: ['Connecting the hose: hose-connection--pinch'] },
    ]);
    await commitOnMain(
      `manuals/${SAMPLE_NOTICE_LEAFLET_ID}.yaml`,
      `${stored}\n`,
    );
  });

  it('prints a PDF per variant and language on the leaflet design', async () => {
    for (const [variant, lang] of [
      ['model=small', 'en'],
      ['model=large', 'de'],
    ] as const) {
      const res = await t
        .get(`${NOTICES}/variants/${variant}/${lang}/pdf`)
        .buffer(true)
        .parse(binary);
      expect([variant, lang, res.status]).toEqual([variant, lang, 200]);
      const pdf = res.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(new Set(pageSizes(pdf))).toEqual(new Set(['420x595']));
    }
  });

  it('is released per variant and language, and refuses a DITA package', async () => {
    t.actAs(publisher);
    const created = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '1.0' },
        },
      }),
    );
    expect(created.status).toBe(201);
    const release = ReleaseDocument.parse(created.body).data;
    await t.runJobs();
    t.actAs(READER);
    const outputs = ReleaseOutputPageDocument.parse(
      (await t.get(`/releases/${release.id}/outputs?page[size]=100`)).body,
    ).data.filter((o) => o.attributes.manual === SAMPLE_NOTICE_LEAFLET_ID);
    expect(
      outputs
        .map((o) =>
          [
            o.attributes.state,
            o.attributes.variant,
            o.attributes.lang,
            o.meta.design?.id,
          ].join(' '),
        )
        .sort(),
    ).toEqual(
      ['model=large', 'model=small'].flatMap((variant) =>
        ['de', 'en', 'fr'].map(
          (lang) => `done ${variant} ${lang} ${SAMPLE_LEAFLET_DESIGN_ID}`,
        ),
      ),
    );
    const output = outputs[0]!;
    const dita = await t.get(
      `/releases/${release.id}/dita-packages/${output.id}`,
    );
    expect(dita.status).toBe(422);
    expect(dita.body.errors?.[0]?.code).toBe('dita-notices-unsupported');
  });
});
