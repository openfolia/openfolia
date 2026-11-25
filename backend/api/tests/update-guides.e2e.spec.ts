import { execFileSync } from 'node:child_process';
import { resolveUpdateGuide } from '@openfolia/content-model/core';
import { GitWriter } from '@openfolia/content-repo';
import {
  addSampleUpdateGuide,
  SAMPLE_UPDATE_GUIDE_ID,
  SAMPLE_UPDATE_STEPS,
  SAMPLE_UPDATE_VERSIONS,
} from '@openfolia/content-repo/testing';
import type { Actor } from '../src/access/core/actor.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { ManualDocument } from '../src/manuals/api/manual.resources.js';
import {
  UpdateGuideDocument,
  UpdateGuideStepPageDocument,
} from '../src/manuals/api/update-guide.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #906: an update guide, read with what a reader picks from and every step, paged, from released
 * content only; checked, resolved and printed as any manual.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const GUIDE = `/manuals/${SAMPLE_UPDATE_GUIDE_ID}`;
const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft']),
  id: 'guide-author',
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await addSampleUpdateGuide(dir());
  // An unreleased change: a branch no release or `main` points to.
  const writer = new GitWriter(dir());
  const main = git('rev-parse', 'refs/heads/main');
  await writer.createBranch('guide-draft', main);
  await writer.commit({
    branch: 'guide-draft',
    parent: main,
    changes: [
      {
        path: `manuals/${SAMPLE_UPDATE_GUIDE_ID}.yaml`,
        content: git(
          'show',
          `main:manuals/${SAMPLE_UPDATE_GUIDE_ID}.yaml`,
        ).replace('Software update guide', 'Draft update guide'),
      },
    ],
    message: 'Retitle the update guide',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const allSteps = async (lang: string) => {
  const res = await t.get(`${GUIDE}/update-guide/${lang}/steps?page[size]=100`);
  expect(res.status).toBe(200);
  return UpdateGuideStepPageDocument.parse(res.body).data;
};

describe('an update guide (#906)', () => {
  it('reads as a manual of its kind, with its guide and its steps as entries', async () => {
    const res = await t.get(GUIDE);
    expect(res.status).toBe(200);
    const { attributes } = ManualDocument.parse(res.body).data;
    expect(attributes.kind).toBe('update-guide');
    expect(attributes.guide?.versions).toEqual([...SAMPLE_UPDATE_VERSIONS]);
    expect(attributes.guide?.steps).toHaveLength(SAMPLE_UPDATE_STEPS.length);
    expect(attributes.entries).toHaveLength(SAMPLE_UPDATE_STEPS.length);
  });

  it('gives what a reader picks from: versions, levels and options', async () => {
    t.actAs(READER);
    const res = await t.get(`${GUIDE}/update-guide/de`);
    expect(res.status).toBe(200);
    const { data } = UpdateGuideDocument.parse(res.body);
    expect(data.id).toBe(`${SAMPLE_UPDATE_GUIDE_ID}/de`);
    expect(data.attributes).toMatchObject({
      title: 'Leitfaden für Software-Updates',
      lang: 'de',
      attribute: { id: 'software', label: 'Software' },
      versions: [...SAMPLE_UPDATE_VERSIONS],
      levels: [
        { id: 'public', label: 'Public' },
        { id: 'internal', label: 'Internal' },
      ],
      options: [
        {
          id: 'cluster',
          label: 'Cluster setup',
          values: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      ],
    });
    expect(data.meta.stepCount).toBe(SAMPLE_UPDATE_STEPS.length);
  });

  it('lists every step with its version, phase, level, condition and body, paged', async () => {
    t.actAs(READER);
    const first = await t.get(`${GUIDE}/update-guide/en/steps?page[size]=5`);
    expect(first.status).toBe(200);
    const page = UpdateGuideStepPageDocument.parse(first.body);
    expect(page.data).toHaveLength(5);
    expect(page.meta.page).toEqual({
      currentPage: 1,
      lastPage: 3,
      perPage: 5,
      total: SAMPLE_UPDATE_STEPS.length,
    });
    expect(page.links.next).toContain('page%5Bnumber%5D=2');
    const last = UpdateGuideStepPageDocument.parse(
      (
        await t.get(
          `${GUIDE}/update-guide/en/steps?page[number]=3&page[size]=5`,
        )
      ).body,
    );
    expect(last.data).toHaveLength(2);

    const steps = await allSteps('en');
    expect(
      steps.map((s) => `${s.attributes.version} ${s.attributes.phase} ${s.id}`),
    ).toEqual([
      '1.1 during install-package',
      '1.1 after check-version',
      '2.0 before back-up-settings',
      '2.0 before stop-service',
      '2.0 during migrate-database',
      '2.0 after renew-licence',
      '2.1 after reconnect-nodes',
      '3.0 before check-requirements',
      '3.0 during convert-configuration',
      '3.0 after sign-in-again',
      '4.0 before drain-cluster',
      '4.0 after remove-old-files',
    ]);
    const migrate = steps.find((s) => s.id === 'migrate-database')?.attributes;
    expect(migrate).toMatchObject({
      title: 'Migrate the database',
      level: 'internal',
      when: null,
    });
    expect(JSON.stringify(migrate?.blocks)).toContain('migration tool');
    expect(
      steps.find((s) => s.id === 'drain-cluster')?.attributes,
    ).toMatchObject({
      condition: 'cluster in (yes)',
      when: { op: 'in', attr: 'cluster', values: ['yes'] },
    });
    // In German, from the German modules.
    const de = await allSteps('de');
    expect(de[0]?.attributes).toMatchObject({
      title: 'Das Update-Paket installieren',
      lang: 'de',
    });
  });

  it('gives a client what it needs to pick a jump’s steps (`resolveUpdateGuide`)', async () => {
    const steps = (await allSteps('en')).map((s) => ({
      id: s.id,
      ...s.attributes,
    }));
    const result = resolveUpdateGuide(
      { versions: SAMPLE_UPDATE_VERSIONS, steps },
      { from: '2.0', to: '4.0', level: 'public', options: { cluster: 'yes' } },
      ['public', 'internal'],
    );
    expect(
      result.status === 'resolved' &&
        result.phases.map((p) => [p.phase, p.steps.map((s) => s.step.id)]),
    ).toEqual([
      ['before', ['check-requirements', 'drain-cluster']],
      ['during', []],
      ['after', ['reconnect-nodes', 'sign-in-again', 'remove-old-files']],
    ]);
  });

  it('is read from released content only', async () => {
    t.actAs(READER);
    for (const path of [
      `${GUIDE}/update-guide/en`,
      `${GUIDE}/update-guide/en/steps`,
    ]) {
      const res = await t.get(`${path}?ref=guide-draft`);
      expect([path, res.status]).toEqual([path, 404]);
    }
    // Someone who may read drafts reads it there.
    t.actAs(author);
    const draft = await t.get(`${GUIDE}/update-guide/en?ref=guide-draft`);
    expect(draft.status).toBe(200);
    expect(UpdateGuideDocument.parse(draft.body).data.attributes.title).toBe(
      'Draft update guide',
    );
  });

  it('is not found for a manual of another kind, or an unconfigured language', async () => {
    t.actAs(READER);
    expect((await t.get('/manuals/operating/update-guide/en')).status).toBe(
      404,
    );
    expect(
      (await t.get('/manuals/operating/update-guide/en/steps')).status,
    ).toBe(404);
    expect((await t.get(`${GUIDE}/update-guide/ja`)).status).toBe(404);
  });

  it('has no blocking checks, and prints the whole guide as a PDF', async () => {
    const checks = await t.get(`${GUIDE}/checks`);
    expect(checks.status).toBe(200);
    expect(
      CheckPageDocument.parse(checks.body)
        .data.map((c) => c.attributes)
        .filter((c) => c.severity === 'blocking'),
    ).toEqual([]);
    const resolved = await t.get(`${GUIDE}/variants/model=large/en`);
    expect(resolved.status).toBe(200);
    const groups = (
      resolved.body as {
        data: { attributes: { entries: { title: string }[] } };
      }
    ).data.attributes.entries.map((e) => e.title);
    expect(groups).toEqual([
      'Version 1.1',
      'Version 2.0',
      'Version 2.1',
      'Version 3.0',
      'Version 4.0',
    ]);
    expect(JSON.stringify(resolved.body)).not.toContain('updateSteps');
    const pdf = await t
      .get(`${GUIDE}/variants/model=large/en/pdf`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
