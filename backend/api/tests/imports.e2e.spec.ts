import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseModule,
  printModule,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { seedAccess } from '../src/access/repos/seed.js';
import { AssetPageDocument } from '../src/assets/api/asset.resources.js';
import { DeleteAssetAction } from '../src/assets/core/actions/delete-asset.action.js';
import { ListAssetsAction } from '../src/assets/core/actions/list-assets.action.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import {
  ImportDocument,
  ImporterPageDocument,
} from '../src/imports/api/import.resources.js';
import { ImportSweeper } from '../src/imports/api/import-sweeper.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

const EXAMPLE = join(
  import.meta.dirname,
  '../../../packages/content-model/src/fixtures/import-example',
);

/**
 * The example bundle of the import format, with its configuration values
 * mapped onto the sample repository's (its audience, facet, module type,
 * safety symbol and variant value).
 */
function exampleDocument(): Record<string, unknown> {
  const text = readFileSync(join(EXAMPLE, 'import.json'), 'utf8')
    .replaceAll('"customer"', '"public"')
    .replaceAll('"product-line"', '"region"')
    .replaceAll('"lifters"', '"north"')
    .replaceAll('"reference"', '"concept"')
    .replaceAll('"m002"', '"w001"')
    .replaceAll('"l-200"', '"small"');
  return JSON.parse(text) as Record<string, unknown>;
}

function exampleFiles(): Zippable {
  const files: Zippable = {};
  for (const name of readdirSync(join(EXAMPLE, 'assets'))) {
    files[`assets/${name}`] = new Uint8Array(
      readFileSync(join(EXAMPLE, 'assets', name)),
    );
  }
  return files;
}

const zip = (document: unknown, files: Zippable = exampleFiles()) =>
  Buffer.from(
    zipSync({ 'import.json': strToU8(JSON.stringify(document)), ...files }),
  );

const ROLE_PERMISSIONS: Permission[] = [
  'admin.roles',
  'content.edit',
  'content.read',
  'content.read.draft',
];
const importer: Actor = {
  kind: 'user',
  id: 'sample-importer',
  roles: [
    {
      id: 'importer',
      name: 'Importer',
      permissions: ROLE_PERMISSIONS,
      scope: {},
    },
  ],
};
const editor: Actor = {
  kind: 'user',
  id: 'sample-editor',
  roles: [
    {
      id: 'editor',
      name: 'Editor',
      permissions: ['content.edit', 'content.read', 'content.read.draft'],
      scope: {},
    },
  ],
};

let t: TestApp;
beforeAll(async () => {
  // Small save points: the example's four files become two commits.
  t = await createTestApp({ CCMS_IMPORT_COMMIT_FILES: '2' });
  await seedAccess(t.database, {
    roles: [
      {
        id: 'importer',
        name: 'Importer',
        permissions: ROLE_PERMISSIONS,
        scope: {},
      },
    ],
    users: [{ id: importer.id, name: 'Importer', roles: ['importer'] }],
  });
});
afterAll(() => t?.close());
beforeEach(() => t.actAs(importer));

const upload = (bytes: Buffer, fields: Record<string, string> = {}) => {
  let req = t
    .anonymous()
    .post('/imports')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', JSON_API)
    .set(REQUEST_HEADER, '1');
  for (const [name, value] of Object.entries(fields)) {
    req = req.field(name, value);
  }
  return req.attach('file', bytes, 'loading.zip');
};
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

describe('GET /importers', () => {
  it('lists the built-in importers, paged, with their options as JSON Schema', async () => {
    const res = await t.get('/importers');
    expect(res.status).toBe(200);
    const doc = ImporterPageDocument.parse(res.body);
    expect(doc.data).toEqual(
      ['bundle', 'dita'].map((id) =>
        expect.objectContaining({
          type: 'Importer',
          id,
          meta: {
            optionsSchema: expect.objectContaining({ type: 'object' }),
            // The default CCMS_IMPORT_MAX_BYTES: 64 MiB.
            maxBytes: 64 * 1024 * 1024,
          },
        }),
      ),
    );
    expect(doc.meta.page).toMatchObject({ total: 2, currentPage: 1 });
  });

  it('is refused without admin.roles', async () => {
    t.actAs(editor);
    const res = await t.get('/importers');
    expect(res.status).toBe(403);
    expect(error(res.body)?.code).toBe('forbidden');
  });
});

describe('POST /imports', () => {
  it('reports a dry run and writes nothing', async () => {
    const before = await t.blobs.list();
    const changeSets = await t.get('/change-sets');
    const res = await upload(zip(exampleDocument()), { dryRun: 'true' });
    expect(res.status).toBe(200);
    const doc = ImportDocument.parse(res.body);
    expect(doc.data.attributes).toMatchObject({
      state: 'dry-run',
      importer: 'bundle',
      baseRef: 'main',
      fileName: 'loading.zip',
    });
    const { report } = doc.data.meta;
    expect(report).toMatchObject({ valid: true, applicable: true });
    expect(report.counts).toMatchObject({
      modules: 3,
      manuals: 1,
      assets: 2,
      create: 6,
      update: 0,
      skip: 0,
      refuse: 0,
      passthrough: 1,
      converterReport: 2,
    });
    expect(
      report.items.map((i) => [i.kind, i.lang ?? '', i.id, i.action]),
    ).toEqual([
      ['module', 'en', 'tank-filling', 'create'],
      ['module', 'de', 'tank-filling', 'create'],
      ['module', 'en', 'pressure-limits', 'create'],
      ['manual', '', 'pump-guide', 'create'],
      ['asset', '', expect.stringMatching(/^sha256:105586/), 'create'],
      ['asset', '', expect.stringMatching(/^sha256:4977/), 'create'],
    ]);
    expect(report.converterReport).toHaveLength(2);
    // No blob, no row, no change set.
    expect(await t.blobs.list()).toEqual(before);
    expect((await t.get(`/imports/${doc.data.id}`)).status).toBe(404);
    expect((await t.get('/change-sets')).body).toEqual(changeSets.body);
  });

  it('skips an ID that exists, and updates it with "update existing"', async () => {
    const document = exampleDocument();
    const modules = document['modules'] as Record<string, unknown>[];
    const first = modules[0] as { id: string };
    first.id = 'charging';
    // The German translation and the manual follow the module's new ID.
    (modules[1] as { id: string }).id = 'charging';
    const text = JSON.stringify(document).replaceAll(
      '"module":"tank-filling"',
      '"module":"charging"',
    );
    const bundle = zip(JSON.parse(text));
    const skip = ImportDocument.parse(
      (await upload(bundle, { dryRun: 'true' })).body,
    );
    const actions = (doc: ImportDocument) =>
      doc.data.meta.report.items
        .filter((i) => i.id === 'charging')
        .map((i) => [i.lang, i.action, i.reasons.map((r) => r.code)]);
    expect(actions(skip)).toEqual([
      ['en', 'skip', ['exists']],
      ['de', 'skip', ['exists']],
    ]);
    const update = ImportDocument.parse(
      (await upload(bundle, { dryRun: 'true', updateExisting: 'true' })).body,
    );
    expect(actions(update)).toEqual([
      ['en', 'update', []],
      ['de', 'update', []],
    ]);
  });

  it('refuses what the validator finds, item by item, and cannot be applied', async () => {
    const document = exampleDocument();
    const modules = document['modules'] as { meta: { type: string } }[];
    (modules[2] as { meta: { type: string } }).meta.type = 'unknown-type';
    const res = await upload(zip(document));
    expect(res.status).toBe(201);
    const doc = ImportDocument.parse(res.body);
    expect(doc.data.meta.report.applicable).toBe(false);
    const refused = doc.data.meta.report.items.find(
      (i) => i.id === 'pressure-limits',
    );
    expect(refused).toMatchObject({ action: 'refuse' });
    expect(refused?.reasons.map((r) => r.code)).toContain(
      'unknown-module-type',
    );
    const apply = await t
      .post(`/imports/${doc.data.id}/apply`)
      .set('Content-Type', JSON_API);
    expect(apply.status).toBe(422);
    expect(error(apply.body)?.code).toBe('import-not-applicable');
  });

  it('refuses a module holding a table past the caps (#686), and cannot be applied', async () => {
    const document = exampleDocument();
    const modules = document['modules'] as { blocks: unknown[] }[];
    // 1,001 columns: one past MAX_TABLE_COLUMNS.
    (modules[2] as { blocks: unknown[] }).blocks.push({
      type: 'table',
      id: 'wide',
      columns: Array.from({ length: 1_001 }, () => ({ width: 1 })),
      header: false,
      rows: [{ cells: [{ colspan: 100, blocks: [] }] }],
    });
    const res = await upload(zip(document));
    expect(res.status).toBe(201);
    const doc = ImportDocument.parse(res.body);
    expect(doc.data.meta.report.applicable).toBe(false);
    const refused = doc.data.meta.report.items.find(
      (i) => i.id === 'pressure-limits',
    );
    expect(refused).toMatchObject({ action: 'refuse' });
    expect(refused?.reasons.map((r) => r.code)).toEqual(['table-too-large']);
    const apply = await t
      .post(`/imports/${doc.data.id}/apply`)
      .set('Content-Type', JSON_API);
    expect(apply.status).toBe(422);
    expect(error(apply.body)?.code).toBe('import-not-applicable');
  });

  it('refuses a hostile archive before anything is stored', async () => {
    const before = await t.blobs.list();
    const slip = Buffer.from(
      zipSync({
        'import.json': strToU8('{"formatVersion":1,"modules":[]}'),
        '../escape.txt': strToU8('out'),
      }),
    );
    const res = await upload(slip);
    expect(res.status).toBe(422);
    expect(error(res.body)).toMatchObject({
      code: 'invalid-archive',
      meta: { reason: 'unsafe-path' },
    });
    const notZip = await upload(Buffer.from('<?xml version="1.0"?><a/>'));
    expect(notZip.status).toBe(422);
    expect(error(notZip.body)?.meta).toMatchObject({ reason: 'not-a-zip' });
    expect(await t.blobs.list()).toEqual(before);
  });

  it('refuses a role without admin.roles before reading the form', async () => {
    t.actAs(editor);
    const res = await upload(zip(exampleDocument()), { dryRun: 'true' });
    expect(res.status).toBe(403);
    expect(error(res.body)?.code).toBe('forbidden');
  });

  it('refuses an administrator who may not edit content', async () => {
    t.actAs({
      ...importer,
      id: 'admin-only',
      roles: [
        {
          id: 'admin',
          name: 'Admin',
          permissions: ['admin.roles', 'content.read'],
          scope: {},
        },
      ],
    });
    const res = await upload(zip(exampleDocument()), { dryRun: 'true' });
    expect(res.status).toBe(403);
  });

  it('refuses a form with a field it does not have', async () => {
    const res = await upload(zip(exampleDocument()), { other: 'x' });
    expect(res.status).toBe(400);
    expect(error(res.body)).toMatchObject({
      code: 'invalid-body',
      source: { parameter: 'other' },
    });
  });
});

describe('POST /imports/:importId/apply', () => {
  it('imports the example into one change set in several save points', async () => {
    const created = await upload(zip(exampleDocument()));
    expect(created.status).toBe(201);
    const stored = ImportDocument.parse(created.body);
    expect(created.headers['location']).toBe(`/imports/${stored.data.id}`);
    expect(stored.data.attributes.state).toBe('validated');

    const res = await t
      .post(`/imports/${stored.data.id}/apply`)
      .set('Content-Type', JSON_API);
    expect(res.status).toBe(202);
    expect(ImportDocument.parse(res.body).data.attributes.state).toBe(
      'applying',
    );
    const again = await t
      .post(`/imports/${stored.data.id}/apply`)
      .set('Content-Type', JSON_API);
    expect(again.status).toBe(409);
    expect(error(again.body)?.code).toBe('invalid-state');

    expect(await t.runJobs()).toBeGreaterThanOrEqual(1);
    const done = ImportDocument.parse(
      (await t.get(`/imports/${stored.data.id}`)).body,
    );
    expect(done.data.meta.failure).toBeNull();
    expect(done.data.attributes.state).toBe('applied');
    expect(done.data.meta.progress).toMatchObject({
      phase: 'done',
      assets: { done: 2, total: 2 },
      files: { done: 4, total: 4 },
    });
    // Four files, two per save point.
    expect(done.data.meta.progress.commits).toHaveLength(2);
    const changeSetId = done.data.relationships?.changeSet.data.id ?? '';

    const changeSet = ChangeSetDocument.parse(
      (await t.get(`/change-sets/${changeSetId}`)).body,
    );
    expect(changeSet.data.attributes).toMatchObject({
      title: 'Import of loading.zip',
      state: 'draft',
      author: { kind: 'user', id: importer.id },
    });
    const changes = ChangeSetChangePageDocument.parse(
      (await t.get(`/change-sets/${changeSetId}/changes`)).body,
    );
    expect(changes.data.map((c) => [c.id, c.meta.change]).sort()).toEqual([
      ['manual/pump-guide', 'added'],
      ['module/de/tank-filling', 'added'],
      ['module/en/pressure-limits', 'added'],
      ['module/en/tank-filling', 'added'],
    ]);
    const checks = CheckPageDocument.parse(
      (await t.get(`/change-sets/${changeSetId}/checks`)).body,
    );
    expect(
      checks.data.filter((c) => c.attributes.severity === 'blocking'),
    ).toEqual([]);
    // The files were uploaded into the change set, as an editor's are.
    const attachment = await t.get(
      `/change-sets/${changeSetId}/assets/105586f66f9086e6475e5cf9dc9eb74b3ba3b552556df7d3386d734a4d759cae`,
    );
    expect(attachment.status).toBe(200);

    const audit = AuditEventPageDocument.parse(
      (await t.get(`/audit-events?filter[subject]=import/${stored.data.id}`))
        .body,
    );
    expect(audit.data).toHaveLength(1);
    expect(audit.data[0]?.attributes).toMatchObject({
      action: 'import.apply',
      data: {
        state: 'applied',
        changeSetId,
        counts: expect.objectContaining({ create: 6 }),
        commits: 2,
      },
    });
  });

  it('applies the rest with skipRefused, leaving exactly the refused item out (#758)', async () => {
    // IDs of its own: no other test's change set holds their locks.
    const document = JSON.parse(
      JSON.stringify(exampleDocument())
        .replaceAll('"tank-filling"', '"skip-tank"')
        .replaceAll('"pressure-limits"', '"skip-limits"')
        .replaceAll('"pump-guide"', '"skip-guide"'),
    ) as Record<string, unknown>;
    // The German translation is refused; nothing else needs it.
    const modules = document['modules'] as { meta: { type: string } }[];
    (modules[1] as { meta: { type: string } }).meta.type = 'unknown-type';
    const created = await upload(zip(document));
    expect(created.status).toBe(201);
    const stored = ImportDocument.parse(created.body);
    const report = stored.data.meta.report;
    expect(report).toMatchObject({
      applicable: false,
      applicableWithoutRefused: true,
      counts: { refuse: 1 },
    });

    // Without the flag (and with it false) it is refused as before.
    for (const body of [undefined, { meta: { skipRefused: false } }]) {
      const refused = await t
        .post(`/imports/${stored.data.id}/apply`)
        .set('Content-Type', JSON_API)
        .send(body);
      expect(refused.status).toBe(422);
      expect(error(refused.body)).toMatchObject({
        code: 'import-not-applicable',
        meta: { skipRefused: true },
      });
    }
    const unknown = await t
      .post(`/imports/${stored.data.id}/apply`)
      .set('Content-Type', JSON_API)
      .send({ meta: { skipRefused: true, everything: true } });
    expect(unknown.status).toBe(400);

    const res = await t
      .post(`/imports/${stored.data.id}/apply`)
      .set('Content-Type', JSON_API)
      .send({ meta: { skipRefused: true } });
    expect(res.status).toBe(202);
    expect(ImportDocument.parse(res.body).data.attributes.state).toBe(
      'applying',
    );
    expect(await t.runJobs()).toBeGreaterThanOrEqual(1);
    const done = ImportDocument.parse(
      (await t.get(`/imports/${stored.data.id}`)).body,
    );
    expect(done.data.meta.failure).toBeNull();
    expect(done.data.attributes.state).toBe('applied');
    // The report still lists what was left out, and why.
    expect(
      done.data.meta.report.items
        .filter((i) => i.action === 'refuse')
        .map((i) => [i.id, i.lang, i.reasons.map((r) => r.code)]),
    ).toEqual([['skip-tank', 'de', ['unknown-module-type']]]);
    const changeSetId = done.data.relationships?.changeSet.data.id ?? '';
    const changes = ChangeSetChangePageDocument.parse(
      (await t.get(`/change-sets/${changeSetId}/changes`)).body,
    );
    expect(changes.data.map((c) => [c.id, c.meta.change]).sort()).toEqual([
      ['manual/skip-guide', 'added'],
      ['module/en/skip-limits', 'added'],
      ['module/en/skip-tank', 'added'],
    ]);
    const changeSet = ChangeSetDocument.parse(
      (await t.get(`/change-sets/${changeSetId}`)).body,
    );
    expect(changeSet.data.attributes.description).toContain(
      'Left out: 1 item the check refused.\n- module de/skip-tank (unknown-module-type',
    );
    // Every commit message says so too.
    const messages = execFileSync(
      'git',
      [
        '-C',
        process.env['CCMS_CONTENT_DIR'] as string,
        'log',
        '--format=%B%x00',
        `${changeSet.data.attributes.baseCommit}..change-sets/${changeSetId}`,
      ],
      { encoding: 'utf8' },
    )
      .split('\0')
      .map((m) => m.trim())
      .filter((m) => m !== '');
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const message of messages) {
      expect(message).toMatch(
        /^Import of loading\.zip(, part \d of \d)?\n\nLeft out: 1 item the check refused\.\n- module de\/skip-tank \(unknown-module-type: /,
      );
    }
    const audit = AuditEventPageDocument.parse(
      (await t.get(`/audit-events?filter[subject]=import/${stored.data.id}`))
        .body,
    );
    expect(audit.data[0]?.attributes.data).toMatchObject({
      state: 'applied',
      counts: expect.objectContaining({ refuse: 1 }),
    });
  });

  it('refuses skipRefused when something else needs the refused item', async () => {
    const document = JSON.parse(
      JSON.stringify(exampleDocument())
        .replaceAll('"tank-filling"', '"needs-tank"')
        .replaceAll('"pressure-limits"', '"needs-limits"')
        .replaceAll('"pump-guide"', '"needs-guide"'),
    ) as Record<string, unknown>;
    // The manual and the other modules name it.
    const modules = document['modules'] as { meta: { type: string } }[];
    (modules[2] as { meta: { type: string } }).meta.type = 'unknown-type';
    const stored = ImportDocument.parse((await upload(zip(document))).body);
    expect(stored.data.meta.report.applicableWithoutRefused).toBe(false);
    const res = await t
      .post(`/imports/${stored.data.id}/apply`)
      .set('Content-Type', JSON_API)
      .send({ meta: { skipRefused: true } });
    expect(res.status).toBe(422);
    expect(error(res.body)).toMatchObject({
      code: 'import-not-applicable',
      meta: { skipRefused: false },
    });
    expect(
      ImportDocument.parse((await t.get(`/imports/${stored.data.id}`)).body)
        .data.attributes.state,
    ).toBe('validated');
  });

  it('is only the uploader’s: another administrator gets 404', async () => {
    const stored = ImportDocument.parse(
      (await upload(zip(exampleDocument()))).body,
    );
    t.actAs({ ...importer, id: 'someone-else' });
    expect((await t.get(`/imports/${stored.data.id}`)).status).toBe(404);
    const res = await t
      .post(`/imports/${stored.data.id}/apply`)
      .set('Content-Type', JSON_API);
    expect(res.status).toBe(404);
  });

  it('fails an import whose modules another import’s change set holds', async () => {
    const document = exampleDocument();
    (document['modules'] as { id: string }[]).splice(1, 1);
    const one = document['modules'] as Record<string, unknown>[];
    (one[0] as { id: string }).id = 'tank-check';
    const text = JSON.stringify(document).replaceAll(
      '"module":"tank-filling"',
      '"module":"tank-check"',
    );
    const changed = JSON.parse(text) as Record<string, unknown>;
    changed['manuals'] = [];
    const first = ImportDocument.parse((await upload(zip(changed))).body);
    const second = ImportDocument.parse((await upload(zip(changed))).body);
    await t
      .post(`/imports/${first.data.id}/apply`)
      .set('Content-Type', JSON_API);
    await t.runJobs();
    // The first import's change set holds them, not main: the second's
    // target is unchanged, and it applies too (into a change set of its own).
    await t
      .post(`/imports/${second.data.id}/apply`)
      .set('Content-Type', JSON_API);
    await t.runJobs();
    const result = ImportDocument.parse(
      (await t.get(`/imports/${second.data.id}`)).body,
    );
    // Its locks are held by the first import's change set.
    expect(result.data.attributes.state).toBe('failed');
    expect(result.data.meta.failure?.code).toBe('locked');
  });

  it('removes an expired import with its upload', async () => {
    const empty = zip({ formatVersion: 1, modules: [] }, {});
    const stored = ImportDocument.parse((await upload(empty)).body);
    expect(await t.blobs.exists(sha256(empty))).toBe(true);
    const sweeper = t.app.get(ImportSweeper);
    await sweeper.runOnce(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect((await t.get(`/imports/${stored.data.id}`)).status).toBe(404);
    // Its upload went with it.
    expect(await t.blobs.exists(sha256(empty))).toBe(false);
  });
});

describe('files already stored (#332)', () => {
  const EXAMPLE_PNG =
    '497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581';
  /** A real 1×1 PNG with bytes after its end, so no other test holds it. */
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  let images = 0;
  const png = () =>
    Buffer.concat([PNG_BYTES, Buffer.from(`#import-${++images}`)]);

  /** The example, its image block pointing at `hash`, the image not carried. */
  const referring = (hash: string) => {
    const text = JSON.stringify(exampleDocument()).replaceAll(
      EXAMPLE_PNG,
      hash,
    );
    const files = exampleFiles();
    delete files[`assets/${EXAMPLE_PNG}`];
    return zip(JSON.parse(text), files);
  };
  /** The dry run's report, with `hash` written as `<hash>`. */
  const reportFor = async (hash: string) => {
    const res = await upload(referring(hash), { dryRun: 'true' });
    expect(res.status).toBe(200);
    const { report } = ImportDocument.parse(res.body).data.meta;
    return JSON.parse(JSON.stringify(report).replaceAll(hash, '<hash>'));
  };
  /** Uploads `bytes` into a new change set of `as`; its hash. */
  const uploadInto = async (as: Actor, bytes: Buffer) => {
    t.actAs(as);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Images' } },
      }),
    );
    expect(created.status).toBe(201);
    const id = ChangeSetDocument.parse(created.body).data.id;
    const res = await t
      .anonymous()
      .post(`/change-sets/${id}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .attach('file', bytes, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    t.actAs(importer);
    return sha256(bytes);
  };

  it('reports a stored file the importer may not read exactly as a missing one', async () => {
    const theirs = await uploadInto(editor, png());
    expect(await t.blobs.exists(theirs)).toBe(true);
    const missing = sha256(png());
    expect(await t.blobs.exists(missing)).toBe(false);

    const outOfScope = await reportFor(theirs);
    const absent = await reportFor(missing);
    expect(outOfScope).toEqual(absent);
    expect(outOfScope).toMatchObject({ valid: false, applicable: false });
    const item = (
      outOfScope as { items: { id: string; lang?: string; reasons: unknown }[] }
    ).items.find((i) => i.id === 'tank-filling' && i.lang === 'en');
    expect(item?.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-asset' }),
      ]),
    );
  });

  it('never reuses another import’s uploaded bundle', async () => {
    const bundle = zip({ formatVersion: 1, modules: [] }, {});
    // Stored by an import of another administrator, kept for an hour.
    t.actAs({ ...importer, id: 'sample-other-importer' });
    expect((await upload(bundle)).status).toBe(201);
    t.actAs(importer);
    const hash = sha256(bundle);
    expect(await t.blobs.exists(hash)).toBe(true);
    // Also the importer's own: an import's upload is no asset.
    expect((await upload(bundle)).status).toBe(201);
    expect(await reportFor(hash)).toEqual(await reportFor(sha256(png())));
  });

  it('reuses a file the importer uploaded into a change set of theirs, and applies it', async () => {
    const own = await uploadInto(importer, png());
    const report = await reportFor(own);
    expect(report).toMatchObject({ valid: true, applicable: true });
    // Not carried, so not listed as a file to upload.
    expect(
      (report as { items: { kind: string }[] }).items.filter(
        (i) => i.kind === 'asset',
      ),
    ).toHaveLength(1);

    const document = JSON.parse(
      JSON.stringify(exampleDocument())
        .replaceAll(EXAMPLE_PNG, own)
        .replaceAll('tank-filling', 'tank-reuse')
        .replaceAll('pressure-limits', 'limits-reuse')
        .replaceAll('pump-guide', 'guide-reuse'),
    ) as Record<string, unknown>;
    const files = exampleFiles();
    delete files[`assets/${EXAMPLE_PNG}`];
    const stored = ImportDocument.parse(
      (await upload(zip(document, files))).body,
    );
    expect(stored.data.meta.report.applicable).toBe(true);
    await t
      .post(`/imports/${stored.data.id}/apply`)
      .set('Content-Type', JSON_API);
    await t.runJobs();
    const done = ImportDocument.parse(
      (await t.get(`/imports/${stored.data.id}`)).body,
    );
    expect(done.data.meta.failure).toBeNull();
    expect(done.data.attributes.state).toBe('applied');
  });
});

describe('an import’s uploaded bundle and the media library (#332)', () => {
  const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
  const DAY = 24 * 60 * 60 * 1000;

  /** Commits a module on main attaching the file `hash`. */
  async function attachOnMain(hash: string): Promise<void> {
    const charging = parseModule(git('show', 'main:modules/en/charging.adoc'), {
      id: 'charging',
    });
    const module: Module = {
      ...charging,
      id: 'bundle-attached',
      meta: { ...charging.meta, title: 'Bundle attached' },
      blocks: [
        {
          type: 'attachment',
          id: 'the-bundle',
          asset: `sha256:${hash}`,
          name: 'The bundle',
          fileName: 'bundle.zip',
          mediaType: 'application/zip',
          size: 1,
        },
      ],
    };
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        {
          path: 'modules/en/bundle-attached.adoc',
          content: printModule(module),
        },
      ],
      message: 'Attach a bundle',
      author: { name: 'Test', email: 'test@example.com' },
    });
  }

  it('neither lists nor deletes a kept import’s bundle as unused', async () => {
    const bundle = zip({ formatVersion: 1, modules: [], manuals: [] }, {});
    expect((await upload(bundle)).status).toBe(201);
    const hash = sha256(bundle);
    const deleted = await t.delete(`/assets/${hash}`);
    expect(deleted.status).toBe(409);
    expect(error(deleted.body)).toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'import' }] },
    });
    // Even once it is past the grace period.
    const later = Date.now() + 2 * DAY;
    const list = t.app.get(ListAssetsAction);
    const del = t.app.get(DeleteAssetAction);
    vi.spyOn(list, 'now').mockReturnValue(later);
    vi.spyOn(del, 'now').mockReturnValue(later);
    try {
      const unused = AssetPageDocument.parse(
        (await t.get('/assets?filter[unused]=true&page[size]=100')).body,
      );
      expect(unused.data.map((a) => a.id)).not.toContain(hash);
      const again = await t.delete(`/assets/${hash}`);
      expect(error(again.body)).toMatchObject({
        code: 'asset-in-use',
        meta: { usedIn: [{ in: 'import' }] },
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(await t.blobs.exists(hash)).toBe(true);
  });

  it('keeps an expired import’s bytes that content refers to', async () => {
    const bundle = zip(
      { formatVersion: 1, modules: [], manuals: [], converterReport: [] },
      {},
    );
    const stored = ImportDocument.parse((await upload(bundle)).body);
    const hash = sha256(bundle);
    await attachOnMain(hash);
    await t.app
      .get(ImportSweeper)
      .runOnce(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect((await t.get(`/imports/${stored.data.id}`)).status).toBe(404);
    expect(await t.blobs.exists(hash)).toBe(true);
  });
});
