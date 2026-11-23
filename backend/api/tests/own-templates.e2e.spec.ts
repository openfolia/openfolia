import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, printConfig } from '@openfolia/content-model';
import { addSamplePageDesigns } from '@openfolia/content-repo/testing';
import { EXAMPLE_TEMPLATE } from '@openfolia/render-typst';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { PageDesignTemplatePageDocument } from '../src/page-designs/api/page-design-templates.controller.js';
import { PageDesignDocument } from '../src/page-designs/api/page-design.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #396: a page design names an organisation's own Typst template, a folder of the content
 * repository (`templates/<id>/manual.typ`), which lays its PDF out; one that does not compile is
 * the template's error, with its file and line, and a blocking check.
 */
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (
  args: string[],
  env: Record<string, string> = {},
  input?: string,
) =>
  execFileSync('git', ['-C', dir(), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Someone',
      GIT_AUTHOR_EMAIL: 'someone@example.com',
      GIT_COMMITTER_NAME: 'Someone',
      GIT_COMMITTER_EMAIL: 'someone@example.com',
      ...env,
    },
    ...(input !== undefined && { input }),
  }).trim();

/**
 * Commits `files` on top of `parent` to `branch` with Git's own plumbing: the API writes no
 * template (it is a project file pushed to the repository, #396), so neither does the test.
 */
function commit(
  branch: string,
  parent: string,
  files: Record<string, string>,
): string {
  const scratch = mkdtempSync(join(tmpdir(), 'openfolia-template-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    git(['read-tree', parent], env);
    for (const [path, text] of Object.entries(files)) {
      const file = join(scratch, 'blob');
      writeFileSync(file, text);
      const blob = git(['hash-object', '-w', file]);
      git(
        ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`],
        env,
      );
    }
    const tree = git(['write-tree'], env);
    const made = git(['commit-tree', tree, '-p', parent, '-m', 'Templates']);
    git(['update-ref', `refs/heads/${branch}`, made]);
    return made;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A classic design, by its own template when `template` is given. */
const design = (name: string, template?: string) =>
  [
    'schemaVersion: 1',
    `name: ${name}`,
    'preset: classic',
    ...(template ? [`template: ${template}`] : []),
    'colours:',
    '  primary: "#1f4e79"',
    '  accent: "#b45309"',
    '  text: "#1f2328"',
    'regions:',
    '  footer: |-',
    '    [#keep]',
    '    Keep this manual with the product.',
    '',
  ].join('\n');

/** The example template's files in `templates/<id>/`. */
const example = (id: string) =>
  Object.fromEntries(
    Object.entries(EXAMPLE_TEMPLATE).map(([path, text]) => [
      `templates/${id}/${path}`,
      text,
    ]),
  );

const BROKEN_LINE = EXAMPLE_TEMPLATE['manual.typ']!.split('\n').length + 1;

let main: string;
beforeAll(async () => {
  t = await createTestApp();
  const withDesigns = await addSamplePageDesigns(dir());
  main = commit('main', withDesigns, {
    ...example('house'),
    ...example('broken'),
    'templates/broken/manual.typ': `${EXAMPLE_TEMPLATE['manual.typ']}\n#read("/etc/passwd")\n`,
    'design/plain.yaml': design('Plain'),
    'design/own.yaml': design('Own', 'house'),
    'design/bad.yaml': design('Bad', 'broken'),
    'design/gone.yaml': design('Gone', 'nowhere'),
  });
  // A branch whose manuals are laid out by the broken template.
  const config = parseConfig(git(['show', `${main}:openfolia.yaml`]));
  commit('broken-default', main, {
    'openfolia.yaml': printConfig({
      ...config,
      pdf: { ...config.pdf, design: 'bad' },
    }),
  });
}, 60_000);
afterAll(() => t?.close());

const PAGE = '/manuals/operating/variants/model=large/en/pdf/pages';
const page = (n: number, query: string) =>
  t
    .get(`${PAGE}/${n}.png?width=300&${query}`)
    .set('Accept', 'image/png')
    .buffer(true);

describe('GET /page-design-templates (#396)', () => {
  it('lists every folder with a manual.typ, by ID, paged', async () => {
    const res = await t.get('/page-design-templates');
    expect(res.status).toBe(200);
    const listed = PageDesignTemplatePageDocument.parse(res.body);
    expect(listed.data).toEqual([
      {
        type: 'PageDesignTemplate',
        id: 'broken',
        attributes: { path: 'templates/broken/manual.typ' },
      },
      {
        type: 'PageDesignTemplate',
        id: 'house',
        attributes: { path: 'templates/house/manual.typ' },
      },
    ]);
    expect(listed.meta.page).toMatchObject({ total: 2 });
    const second = PageDesignTemplatePageDocument.parse(
      (await t.get('/page-design-templates?page[size]=1&page[number]=2')).body,
    );
    expect(second.data.map((d) => d.id)).toEqual(['house']);
    expect((await t.get('/page-design-templates?filter[x]=1')).status).toBe(
      400,
    );
  });

  it('says a design names a template the repository does not have', async () => {
    const gone = PageDesignDocument.parse(
      (await t.get('/page-designs/gone')).body,
    );
    expect(gone.data.attributes.template).toBe('nowhere');
    expect(gone.data.meta.issues).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'unknown-template',
        at: 'template',
      }),
    );
    const own = PageDesignDocument.parse(
      (await t.get('/page-designs/own')).body,
    );
    expect(own.data.meta.issues.map((i) => i.code)).not.toContain(
      'unknown-template',
    );
  });
});

describe('a design laid out by its own template (#396)', () => {
  it('renders the example template exactly as the classic preset', async () => {
    for (const n of [1, 2]) {
      const [preset, own] = await Promise.all([
        page(n, 'design=plain'),
        page(n, 'design=own'),
      ]);
      expect([preset.status, own.status]).toEqual([200, 200]);
      expect((own.body as Buffer).equals(preset.body as Buffer)).toBe(true);
    }
  });

  it('answers a template that does not compile with its file and line, as data', async () => {
    const res = await page(1, 'design=bad');
    expect(res.status).toBe(422);
    const [error] = ErrorDocument.parse(res.body).errors;
    expect(error).toMatchObject({
      code: 'template-error',
      meta: {
        design: 'bad',
        template: 'broken',
        problems: [
          expect.objectContaining({
            file: 'templates/broken/manual.typ',
            line: BROKEN_LINE,
            message: expect.stringContaining('file not found'),
          }),
        ],
      },
    });
    // Nothing of the server's paths, and nothing of the host file.
    expect(JSON.stringify(res.body)).not.toMatch(/openfolia-typst-|root:/);
    const warnings = await t.get(
      '/manuals/operating/variants/model=large/en/pdf/layout-warnings?design=bad',
    );
    expect(warnings.status).toBe(422);
  });

  it('lays a design naming a template that is not there out by its preset', async () => {
    const [preset, gone] = await Promise.all([
      page(1, 'design=plain'),
      page(1, 'design=gone'),
    ]);
    expect(gone.status).toBe(200);
    expect((gone.body as Buffer).equals(preset.body as Buffer)).toBe(true);
  });

  it('is a blocking check at every manual laid out with it', async () => {
    const res = await t.get('/manuals/operating/checks?ref=broken-default');
    expect(res.status).toBe(200);
    const found = CheckPageDocument.parse(res.body).data.filter(
      (c) => c.attributes.code === 'page-design-template-error',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.attributes).toMatchObject({
      severity: 'blocking',
      subject: { type: 'manual', manualId: 'operating' },
      params: {
        design: 'bad',
        template: 'broken',
        file: 'templates/broken/manual.typ',
        line: String(BROKEN_LINE),
      },
    });
  });

  it('is a blocking check at the design in a change set that breaks its template', async () => {
    const author = actorWith([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'House template' } },
      }),
    );
    expect(created.status).toBe(201);
    const changeSet = ChangeSetDocument.parse(created.body).data;
    const checks = async () => {
      const res = await t.get(`/change-sets/${changeSet.id}/checks`);
      expect(res.status).toBe(200);
      return CheckPageDocument.parse(res.body).data.map((c) => c.attributes);
    };
    try {
      // Only the template's folder changes: the design naming it is checked.
      commit(changeSet.attributes.branch, main, {
        'templates/house/manual.typ': `${EXAMPLE_TEMPLATE['manual.typ']}\n#let x = (1).nope()\n`,
      });
      const broken = await checks();
      expect(broken).toContainEqual(
        expect.objectContaining({
          code: 'page-design-template-error',
          severity: 'blocking',
          subject: { type: 'design', designId: 'own' },
          params: expect.objectContaining({
            file: 'templates/house/manual.typ',
            line: String(BROKEN_LINE),
          }),
        }),
      );
      // Fixed: nothing holds it.
      commit(
        changeSet.attributes.branch,
        git(['rev-parse', changeSet.attributes.branch]),
        {
          'templates/house/manual.typ': EXAMPLE_TEMPLATE['manual.typ']!,
        },
      );
      expect(
        (await checks()).filter((c) => c.code === 'page-design-template-error'),
      ).toEqual([]);
    } finally {
      t.actAs(undefined);
    }
  });
});
