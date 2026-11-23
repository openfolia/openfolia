import { execFileSync } from 'node:child_process';
import { type Manifest, parseManifest } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import {
  addSampleSafetyLeaflet,
  SAMPLE_LEAFLET_DESIGN_ID,
  SAMPLE_LEAFLET_ID,
} from '@openfolia/content-repo/testing';
import type { Actor } from '../src/access/core/actor.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ManualWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import {
  ManualDocument,
  ManualPageDocument,
} from '../src/manuals/api/manual.resources.js';
import { ReleaseOutputPageDocument } from '../src/releases/api/release-output.resources.js';
import {
  ReleaseChangePageDocument,
  ReleaseDocument,
} from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #451: a derived manual, a safety leaflet gathered from the operating manual's safety modules:
 * read, checked, resolved and printed per variant and language as any manual, kept in step with
 * its source, released with the changes list showing a changed safety module, and saved through
 * a change set as its rule, never its gathered entries.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const LEAFLET = `/manuals/${SAMPLE_LEAFLET_ID}`;

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'leaflet-author',
};
const publisher: Actor = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'leaflet-publisher',
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await addSampleSafetyLeaflet(dir());
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const manual = async (ref = 'main') => {
  const res = await t.get(`${LEAFLET}?ref=${encodeURIComponent(ref)}`);
  expect(res.status).toBe(200);
  return ManualDocument.parse(res.body).data;
};
const entryModules = (attributes: { entries: Manifest['entries'] }) =>
  attributes.entries.map((e) => ('module' in e ? e.module : e.title));
const checks = async (ref = 'main') => {
  const res = await t.get(`${LEAFLET}/checks?ref=${encodeURIComponent(ref)}`);
  expect(res.status).toBe(200);
  return CheckPageDocument.parse(res.body).data.map((c) => c.attributes);
};
/** A PDF's page sizes in points, from its `/MediaBox` entries. */
const pageSizes = (pdf: Buffer) =>
  [
    ...pdf
      .toString('latin1')
      .matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
  ].map(([, w, h]) => `${Math.round(Number(w))}x${Math.round(Number(h))}`);
/** A5 portrait (148 × 210 mm) in points. */
const A5 = '420x595';
/** A response body as bytes (supertest's `parse`). */
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

describe('a derived manual (#451)', () => {
  it('reads with its rule and the safety modules it gathers, front matter first', async () => {
    const leaflet = await manual();
    expect(leaflet.attributes).toMatchObject({
      kind: 'derived',
      title: 'Safety leaflet',
      rule: { source: 'operating', front: ['leaflet-intro'] },
    });
    expect(entryModules(leaflet.attributes)).toEqual([
      'leaflet-intro',
      'battery-hazards',
      'crush-hazard',
    ]);
    // Listed as any manual; the operating manual stays assembled.
    const list = ManualPageDocument.parse((await t.get('/manuals')).body);
    const ids = list.data.map((m) => m.id);
    expect(ids).toContain(SAMPLE_LEAFLET_ID);
    const operating = list.data.find((m) => m.id === 'operating');
    expect(
      operating && 'attributes' in operating
        ? operating.attributes.kind
        : 'none',
    ).toBeUndefined();
  });

  it('has no checks of its own when it gathers what it should', async () => {
    const found = await checks();
    expect(
      found.filter((c) =>
        [
          'unknown-source-manual',
          'derived-source',
          'no-gathered-types',
          'safety-module-excluded',
          'unknown-excluded-module',
          'empty-derived-manual',
        ].includes(c.code),
      ),
    ).toEqual([]);
  });

  it('renders a PDF per variant and language, with the source’s text attributes, on the leaflet design (A5, #668)', async () => {
    expect((await manual()).meta.design.id).toBe(SAMPLE_LEAFLET_DESIGN_ID);
    for (const [variant, lang] of [
      ['model=small', 'en'],
      ['model=large', 'de'],
    ] as const) {
      const res = await t
        .get(`${LEAFLET}/variants/${variant}/${lang}/pdf`)
        .buffer(true)
        .parse(binary);
      expect([variant, lang, res.status]).toEqual([variant, lang, 200]);
      expect(res.headers['content-type']).toBe('application/pdf');
      const pdf = res.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const sizes = pageSizes(pdf);
      expect(sizes.length).toBeGreaterThan(0);
      expect(new Set(sizes)).toEqual(new Set([A5]));
    }
    // Its layout fits: no region cut off, no running head shortened, no safety message split.
    expect(
      (await checks()).filter((c) =>
        [
          'page-design-overflow',
          'running-head-truncated',
          'safety-message-split',
          'unknown-page-design',
        ].includes(c.code),
      ),
    ).toEqual([]);
  });

  it('warns about a safety module its rule excludes, and follows its source', async () => {
    const stored = git('show', `main:manuals/${SAMPLE_LEAFLET_ID}.yaml`);
    const { commit } = await commitOnMain(
      `manuals/${SAMPLE_LEAFLET_ID}.yaml`,
      `${stored}\n  exclude:\n    - crush-hazard\n`,
    );
    const at = await manual(commit);
    expect(entryModules(at.attributes)).toEqual([
      'leaflet-intro',
      'battery-hazards',
    ]);
    expect(
      (await checks(commit))
        .filter((c) => c.code === 'safety-module-excluded')
        .map((c) => [c.severity, c.params]),
    ).toEqual([['warning', { at: 'crush-hazard' }]]);
    // Put back.
    await commitOnMain(`manuals/${SAMPLE_LEAFLET_ID}.yaml`, `${stored}\n`);
    expect(entryModules((await manual()).attributes)).toEqual([
      'leaflet-intro',
      'battery-hazards',
      'crush-hazard',
    ]);
  });

  it('reports a source that does not exist as a blocking check', async () => {
    const stored = git('show', `main:manuals/${SAMPLE_LEAFLET_ID}.yaml`);
    const { commit } = await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        {
          path: `manuals/${SAMPLE_LEAFLET_ID}.yaml`,
          content: `${stored.replace('source: operating', 'source: no-such-manual')}\n`,
        },
      ],
      message: 'Point the leaflet nowhere',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    expect(entryModules((await manual(commit)).attributes)).toEqual([
      'leaflet-intro',
    ]);
    expect(
      (await checks(commit))
        .filter((c) => c.code === 'unknown-source-manual')
        .map((c) => c.severity),
    ).toEqual(['blocking']);
    await commitOnMain(`manuals/${SAMPLE_LEAFLET_ID}.yaml`, `${stored}\n`);
  });

  it('is released with its source: a changed safety module shows in its changes', async () => {
    const cut = async (revision: string) => {
      t.actAs(publisher);
      const res = await t.post('/releases').send(
        JSON.stringify({
          data: { type: 'Release', attributes: { product: 'north', revision } },
        }),
      );
      expect(res.status).toBe(201);
      return ReleaseDocument.parse(res.body).data;
    };
    const first = await cut('1.0');
    // Printed per variant and language with its own design (#668).
    await t.runJobs();
    t.actAs(READER);
    const outputs = ReleaseOutputPageDocument.parse(
      (await t.get(`/releases/${first.id}/outputs?page[size]=50`)).body,
    ).data.filter((o) => o.attributes.manual === SAMPLE_LEAFLET_ID);
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
    const file = await t
      .get(outputs[0]?.links.file as string)
      .buffer(true)
      .parse(binary);
    expect(file.status).toBe(200);
    expect(new Set(pageSizes(file.body as Buffer))).toEqual(new Set([A5]));
    t.actAs(READER);
    const added = ReleaseChangePageDocument.parse(
      (await t.get(`/releases/${first.id}/changes?page[size]=100`)).body,
    );
    expect(added.data.map((c) => c.id)).toContain(`en/${SAMPLE_LEAFLET_ID}`);

    // Tags are ordered by their date, to the second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await commitOnMain(
      'modules/en/battery-hazards.adoc',
      git('show', 'main:modules/en/battery-hazards.adoc').replace(
        'goggles',
        'a face shield',
      ) + '\n',
    );
    const second = await cut('1.1');
    t.actAs(READER);
    const page = ReleaseChangePageDocument.parse(
      (await t.get(`/releases/${second.id}/changes?page[size]=100`)).body,
    );
    expect(
      page.data.map((c) => [
        c.id,
        c.meta.change,
        c.meta.modules.map((m) => `${m.change}:${m.moduleId}`),
      ]),
    ).toEqual([
      ['en/operating', 'changed', ['changed:battery-hazards']],
      [`en/${SAMPLE_LEAFLET_ID}`, 'changed', ['changed:battery-hazards']],
    ]);
  });

  it('is saved through a change set as its rule, never its gathered entries', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Leaflet title' } },
      }),
    );
    expect(created.status).toBe(201);
    const cs = ChangeSetDocument.parse(created.body).data;
    const locked = await t.post(`/change-sets/${cs.id}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: {
            subject: { type: 'manual', manualId: SAMPLE_LEAFLET_ID },
          },
        },
      }),
    );
    expect(locked.status).toBe(201);
    const path = `/change-sets/${cs.id}/manuals/${SAMPLE_LEAFLET_ID}/working-copy`;
    const wc = ManualWorkingCopyDocument.parse((await t.get(path)).body).data
      .attributes;
    const content = wc.content as Manifest;
    expect(content.kind).toBe('derived');
    expect(content.entries.length).toBeGreaterThan(0);
    const saved = await t.put(path).send(
      JSON.stringify({
        data: {
          type: 'WorkingCopy',
          attributes: { content: { ...content, title: 'Safety at a glance' } },
        },
        meta: { version: wc.version, baseCommit: wc.baseCommit },
      }),
    );
    expect(saved.status).toBe(200);
    const committed = await t.post(`/change-sets/${cs.id}/commits`);
    expect(committed.status).toBe(201);
    const file = `${git('show', `refs/heads/${cs.attributes.branch}:manuals/${SAMPLE_LEAFLET_ID}.yaml`)}\n`;
    expect(file).not.toContain('entries');
    const stored = parseManifest(file, { id: SAMPLE_LEAFLET_ID });
    expect(stored).toMatchObject({
      kind: 'derived',
      title: 'Safety at a glance',
      rule: { source: 'operating', front: ['leaflet-intro'] },
      entries: [],
    });
    // Its text attributes are its own: the source's are not copied in.
    expect(stored.attributes).toEqual({});
    // Let go, for the next author.
    const lockId = (locked.body as { data: { id: string } }).data.id;
    expect((await t.delete(`/locks/${lockId}`)).status).toBe(204);
  });

  it('reads its author’s working copy gathered from the rule it holds (#669)', async () => {
    t.actAs(author);
    const cs = ChangeSetDocument.parse(
      (
        await t.post('/change-sets').send(
          JSON.stringify({
            data: { type: 'ChangeSet', attributes: { title: 'Leaflet rule' } },
          }),
        )
      ).body,
    ).data;
    const lock = (manualId: string) =>
      t.post(`/change-sets/${cs.id}/locks`).send(
        JSON.stringify({
          data: {
            type: 'Lock',
            attributes: { subject: { type: 'manual', manualId } },
          },
        }),
      );
    expect((await lock(SAMPLE_LEAFLET_ID)).status).toBe(201);
    const path = `/change-sets/${cs.id}/manuals/${SAMPLE_LEAFLET_ID}/working-copy`;
    const wc = ManualWorkingCopyDocument.parse((await t.get(path)).body).data
      .attributes;
    const content = wc.content as Manifest;
    const rule = content.rule as NonNullable<Manifest['rule']>;
    // Saved as the editor saves a derived manual: the rule, never entries of its own.
    const saved = await t.put(path).send(
      JSON.stringify({
        data: {
          type: 'WorkingCopy',
          attributes: {
            content: {
              ...content,
              rule: { ...rule, exclude: ['battery-hazards'] },
              entries: [],
            },
          },
        },
        meta: { version: wc.version, baseCommit: wc.baseCommit },
      }),
    );
    expect(saved.status).toBe(200);
    const ref = encodeURIComponent(cs.attributes.branch);
    const live = await t.get(`${LEAFLET}?ref=${ref}&workingCopy=true`);
    expect(live.status).toBe(200);
    expect(live.headers['cache-control']).toContain('no-cache');
    const leaflet = ManualDocument.parse(live.body).data;
    expect(leaflet.attributes.rule?.exclude).toEqual(['battery-hazards']);
    expect(entryModules(leaflet.attributes)).toEqual([
      'leaflet-intro',
      'crush-hazard',
    ]);
    expect(
      leaflet.meta.issues.filter((i) => i.code === 'safety-module-excluded'),
    ).toEqual([expect.objectContaining({ at: 'battery-hazards' })]);
    // Without it, the branch's file.
    expect(
      entryModules((await manual(cs.attributes.branch)).attributes),
    ).toEqual(['leaflet-intro', 'battery-hazards', 'crush-hazard']);

    // A new derived manual only in the working copy is gathered as well.
    const id = 'quick-leaflet';
    expect((await lock(id)).status).toBe(201);
    const created = await t
      .put(`/change-sets/${cs.id}/manuals/${id}/working-copy`)
      .send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                id,
                kind: 'derived',
                title: 'Quick leaflet',
                variants: [{ model: 'large' }],
                attributes: {},
                rule: { source: 'operating', exclude: [], front: [], back: [] },
                entries: [],
              },
            },
          },
          meta: { version: 0, baseCommit: wc.baseCommit },
        }),
      );
    expect(created.status).toBe(200);
    const fresh = await t.get(`/manuals/${id}?ref=${ref}&workingCopy=true`);
    expect(fresh.status).toBe(200);
    expect(
      entryModules(ManualDocument.parse(fresh.body).data.attributes),
    ).toEqual(['battery-hazards', 'crush-hazard']);
    expect((await t.get(`/manuals/${id}?ref=${ref}`)).status).toBe(404);

    // Only its author previews it.
    t.actAs({ ...author, id: 'another-author' });
    expect((await t.get(`${LEAFLET}?ref=${ref}&workingCopy=true`)).status).toBe(
      403,
    );
    t.actAs(author);
    for (const lockId of (
      (await t.get(`/locks?filter[changeSet]=${cs.id}`)).body as {
        data: { id: string }[];
      }
    ).data.map((l) => l.id)) {
      await t.delete(`/locks/${lockId}`);
    }
  });

  it('refuses a rule whose source manual the author may not read, and reads one as missing', async () => {
    const publicAuthor: Actor = {
      ...actorWith(['content.read', 'content.read.draft', 'content.edit'], {
        maxAudience: 'public',
      }),
      id: 'public-author',
    };
    t.actAs(publicAuthor);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Service leaflet' } },
      }),
    );
    expect(created.status).toBe(201);
    const cs = ChangeSetDocument.parse(created.body).data;
    const id = 'service-leaflet';
    const locked = await t.post(`/change-sets/${cs.id}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: { subject: { type: 'manual', manualId: id } },
        },
      }),
    );
    // A new manual: only one who edits manuals of every audience may make it.
    expect(locked.status).toBe(403);

    // An author of every audience may; a public reader then reads it as one with a missing
    // source: none of the internal manual's modules, attributes or text.
    t.actAs(author);
    const own = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Service leaflet' } },
      }),
    );
    const mine = ChangeSetDocument.parse(own.body).data;
    expect(
      (
        await t.post(`/change-sets/${mine.id}/locks`).send(
          JSON.stringify({
            data: {
              type: 'Lock',
              attributes: { subject: { type: 'manual', manualId: id } },
            },
          }),
        )
      ).status,
    ).toBe(201);
    const path = `/change-sets/${mine.id}/manuals/${id}/working-copy`;
    const content = {
      schemaVersion: 1,
      id,
      kind: 'derived',
      title: 'Service leaflet',
      audience: 'public',
      variants: [{ model: 'large' }],
      attributes: {},
      rule: {
        source: 'service',
        moduleTypes: ['concept'],
        exclude: [],
        front: [],
        back: [],
      },
      entries: [],
    };
    const at = git('rev-parse', `refs/heads/${mine.attributes.branch}`);
    const saved = await t.put(path).send(
      JSON.stringify({
        data: { type: 'WorkingCopy', attributes: { content } },
        meta: { version: 0, baseCommit: at },
      }),
    );
    expect(saved.status).toBe(200);
    const committed = await t.post(`/change-sets/${mine.id}/commits`);
    expect(committed.status).toBe(201);
    const ref = encodeURIComponent(mine.attributes.branch);
    const whole = ManualDocument.parse(
      (await t.get(`/manuals/${id}?ref=${ref}`)).body,
    ).data;
    // For readers wider than its source's: nothing gathered, for anyone.
    expect(whole.attributes.entries).toEqual([]);
    const authorChecks = CheckPageDocument.parse(
      (await t.get(`/manuals/${id}/checks?ref=${ref}`)).body,
    ).data.map((c) => [c.attributes.code, c.attributes.severity]);
    expect(authorChecks).toContainEqual(['derived-audience-wider', 'blocking']);

    const publicReader = actorWith(['content.read', 'content.read.draft'], {
      maxAudience: 'public',
    });
    t.actAs(publicReader);
    const read = await t.get(`/manuals/${id}?ref=${ref}`);
    expect(read.status).toBe(200);
    const seen = ManualDocument.parse(read.body).data;
    expect(seen.attributes.entries).toEqual([]);
    expect(JSON.stringify(read.body)).not.toContain('Model A');
    expect(JSON.stringify(read.body)).not.toContain('internals');
    const found = await t.get(`/manuals/${id}/checks?ref=${ref}`);
    const readerCodes = CheckPageDocument.parse(found.body).data.map(
      (c) => c.attributes.code,
    );
    expect(readerCodes).toContain('unknown-source-manual');
    expect(readerCodes).not.toContain('derived-audience-wider');

    // The public author may not save a rule naming it: one answer, whether it is hidden or gone.
    t.actAs(publicAuthor);
    const theirs = ChangeSetDocument.parse(
      (
        await t.post('/change-sets').send(
          JSON.stringify({
            data: { type: 'ChangeSet', attributes: { title: 'Retitle' } },
          }),
        )
      ).body,
    ).data;
    const leafletPath = `/change-sets/${theirs.id}/manuals/${SAMPLE_LEAFLET_ID}/working-copy`;
    expect(
      (
        await t.post(`/change-sets/${theirs.id}/locks`).send(
          JSON.stringify({
            data: {
              type: 'Lock',
              attributes: {
                subject: { type: 'manual', manualId: SAMPLE_LEAFLET_ID },
              },
            },
          }),
        )
      ).status,
    ).toBe(201);
    const wc = ManualWorkingCopyDocument.parse((await t.get(leafletPath)).body)
      .data.attributes;
    const leaflet = wc.content as Manifest;
    const refusals = [];
    for (const source of ['service', 'no-such-manual']) {
      const res = await t.put(leafletPath).send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: { ...leaflet, rule: { ...leaflet.rule!, source } },
            },
          },
          meta: { version: wc.version, baseCommit: wc.baseCommit },
        }),
      );
      refusals.push([
        res.status,
        res.body.errors?.[0]?.code,
        res.body.errors?.[0]?.detail,
      ]);
    }
    expect(refusals[0]).toEqual(refusals[1]);
    expect(refusals[0]?.slice(0, 2)).toEqual([
      403,
      'derived-source-outside-scope',
    ]);
  });
});
