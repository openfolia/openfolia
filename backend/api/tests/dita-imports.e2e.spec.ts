import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseConfig, printConfig } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { zipSync, type Zippable } from 'fflate';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { seedAccess } from '../src/access/repos/seed.js';
import { JSON_API, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { changeSetBranch } from '../src/change-sets/core/change-set.js';
import { ImportDocument } from '../src/imports/api/import.resources.js';
import { ProjectConfigDocument } from '../src/project/api/project.resources.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/** The DITA fixture project of `@openfolia/dita` (#432): a garden pump, in English and German. */
const FIXTURES = join(
  import.meta.dirname,
  '../../../packages/dita/src/fixtures',
);
const PROJECT = join(FIXTURES, 'garden-pump');

function projectFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const stack = [PROJECT];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else {
        files.set(
          relative(PROJECT, path).split(sep).join('/'),
          new Uint8Array(readFileSync(path)),
        );
      }
    }
  }
  return files;
}

const zip = (files: ReadonlyMap<string, Uint8Array>) =>
  Buffer.from(zipSync(Object.fromEntries(files) as Zippable));

const ROLE_PERMISSIONS: Permission[] = [
  'admin.roles',
  'content.edit',
  'content.read',
  'content.read.draft',
];
const importer: Actor = {
  kind: 'user',
  id: 'dita-importer',
  roles: [
    {
      id: 'importer',
      name: 'Importer',
      permissions: ROLE_PERMISSIONS,
      scope: {},
    },
  ],
};

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const author = { name: 'Test', email: 'test@example.com' };

beforeAll(async () => {
  t = await createTestApp();
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
  // The sample configuration, with the fixture's values and its DITA mapping.
  const sample = parseConfig(git('show', 'main:openfolia.yaml'));
  const fixture = parseConfig(
    readFileSync(join(FIXTURES, 'garden-pump.openfolia.yaml'), 'utf8'),
  );
  const merged = {
    ...sample,
    moduleTypes: [
      ...sample.moduleTypes,
      ...fixture.moduleTypes.filter(
        (t) => !sample.moduleTypes.some((s) => s.id === t.id),
      ),
    ],
    audiences: [...sample.audiences, ...fixture.audiences],
    variantAttributes: sample.variantAttributes.map((a) =>
      a.id === 'model' && a.kind === 'enum'
        ? {
            ...a,
            values: [
              ...a.values,
              { id: 'basic', label: 'Basic' },
              { id: 'pro', label: 'Pro' },
            ],
          }
        : a,
    ),
    safetySymbols: [...sample.safetySymbols, ...fixture.safetySymbols],
    dita: fixture.dita,
  };
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      { path: 'openfolia.yaml', content: printConfig(merged as never) },
    ],
    message: 'Configure the DITA import',
    author,
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
    .set(REQUEST_HEADER, '1')
    .field('importer', 'dita');
  for (const [name, value] of Object.entries(fields)) {
    req = req.field(name, value);
  }
  return req.attach('file', bytes, 'garden-pump.zip');
};

const actions = (doc: ImportDocument) =>
  doc.data.meta.report.items
    .filter((i) => i.kind !== 'asset')
    .map((i) =>
      `${i.lang ?? ''}/${i.id} ${i.action} ${i.reasons.map((r) => r.code).join(',')}`.trim(),
    );

describe('the DITA importer (#432)', () => {
  it('checks the DITA mapping in the configuration', async () => {
    const res = await t.get('/config');
    expect(res.status).toBe(200);
    expect(ProjectConfigDocument.parse(res.body).data.meta?.ditaIssues).toEqual(
      [],
    );
  });

  it('reports a dry run of a DITA project: modules, manuals, the image, what it could not map', async () => {
    const res = await upload(zip(projectFiles()), { dryRun: 'true' });
    expect(res.status).toBe(200);
    const doc = ImportDocument.parse(res.body);
    expect(doc.data.attributes).toMatchObject({
      importer: 'dita',
      state: 'dry-run',
    });
    const { report } = doc.data.meta;
    expect(report).toMatchObject({ valid: true, applicable: true });
    expect(report.source).toMatchObject({ system: 'DITA' });
    expect(report.counts).toMatchObject({
      modules: 10,
      manuals: 2,
      assets: 1,
      create: 13,
      refuse: 0,
    });
    const codes = report.converterReport.map(
      (e) => /^\[([a-z-]+)\]/.exec(e.message)?.[1],
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'ditaval-unreferenced',
        'footnote',
        'dropped-element',
        'translated-map',
      ]),
    );
  });

  it('imports into a change set; the same project again changes nothing, a changed topic updates its module', async () => {
    const created = ImportDocument.parse(
      (await upload(zip(projectFiles()))).body,
    );
    const apply = await t
      .post(`/imports/${created.data.id}/apply`)
      .set('Content-Type', JSON_API);
    expect(apply.status).toBe(202);
    await t.runJobs();
    const done = ImportDocument.parse(
      (await t.get(`/imports/${created.data.id}`)).body,
    );
    expect(done.data.meta.failure).toBeNull();
    expect(done.data.attributes.state).toBe('applied');
    const changeSetId = done.data.relationships?.changeSet.data.id ?? '';

    // The change set's files onto main, as a merged review would put them.
    const branch = `refs/heads/${changeSetBranch(changeSetId)}`;
    const paths = git(
      'diff',
      '--name-only',
      '--diff-filter=AM',
      'refs/heads/main',
      branch,
      '--',
      'modules',
      'manuals',
    ).split('\n');
    expect(paths.length).toBeGreaterThanOrEqual(12);
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: paths.map((path) => ({
        path,
        content: git('show', `${branch}:${path}`) + '\n',
      })),
      message: 'Merge the DITA import',
      author,
    });

    const again = ImportDocument.parse(
      (
        await upload(zip(projectFiles()), {
          dryRun: 'true',
          updateExisting: 'true',
        })
      ).body,
    );
    expect(
      new Set(actions(again).map((a) => a.split(' ').slice(1).join(' '))),
    ).toEqual(new Set(['skip unchanged']));
    expect(again.data.meta.report.applicable).toBe(false);

    const files = projectFiles();
    const path = 'en/topics/fault.dita';
    files.set(
      path,
      new TextEncoder().encode(
        new TextDecoder()
          .decode(files.get(path))
          .replace('The filter is blocked.', 'The filter is clogged.'),
      ),
    );
    const changed = ImportDocument.parse(
      (await upload(zip(files), { dryRun: 'true', updateExisting: 'true' }))
        .body,
    );
    expect(
      actions(changed).filter((a) => !a.endsWith('skip unchanged')),
    ).toEqual(['en/topics-fault update']);
    expect(changed.data.meta.report.applicable).toBe(true);
  }, 120_000);

  it('refuses a file that is no ZIP', async () => {
    const res = await upload(Buffer.from('<map/>'), { dryRun: 'true' });
    expect(res.status).toBe(422);
  });
});
