import { execFileSync } from 'node:child_process';
import {
  addSamplePageDesigns,
  addSampleTemplates,
} from '@openfolia/content-repo/testing';
import {
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_FILE_BYTES,
  MAX_TEMPLATE_FILES,
} from '@openfolia/content-model';
import { EXAMPLE_TEMPLATE } from '@openfolia/render-typst';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { TemplateFileWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import {
  PageDesignTemplateFilePageDocument,
  PageDesignTemplateFileTextDocument,
  PageDesignTemplateFileTextPageDocument,
  PageDesignTemplatePageDocument,
} from '../src/page-designs/api/page-design-templates.controller.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #396: an own template's files are edited in a change set, like any other project file: a lock
 * and a working copy per file (`template/<id>/<path>`), the live preview reading the drafts, a
 * save point writing exactly their text, a check holding a broken one, and only for one who may
 * change page designs.
 */
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const json = (body: unknown) => JSON.stringify(body);

const author = actorWith([
  'content.read',
  'content.read.draft',
  'content.edit',
]);
/** Edits English content only: may not change page designs, nor their templates. */
const narrow = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit'], {
    languages: ['en'],
  }),
  id: 'sample-narrow',
};

const BROKEN = `${EXAMPLE_TEMPLATE['manual.typ']}#let x = (1).nope()\n`;
const BROKEN_LINE = EXAMPLE_TEMPLATE['manual.typ']!.split('\n').length;

beforeAll(async () => {
  t = await createTestApp();
  await addSamplePageDesigns(dir());
  addSampleTemplates(dir(), {
    house: { ...EXAMPLE_TEMPLATE, 'notes.txt': 'Our house style.\n' },
    walled: EXAMPLE_TEMPLATE,
  });
  // A design laid out with the house template: a change to the template is checked at it.
  const head = git('rev-parse', 'main');
  const design = [
    'schemaVersion: 1',
    'name: Own',
    'preset: classic',
    'template: house',
    'colours:',
    '  primary: "#1f4e79"',
    '  accent: "#b45309"',
    '  text: "#1f2328"',
    '',
  ].join('\n');
  const blob = execFileSync(
    'git',
    ['-C', dir(), 'hash-object', '-w', '--stdin'],
    {
      input: design,
      encoding: 'utf8',
    },
  ).trim();
  // Through an index of its own: read the head, add the design, write the tree.
  const index = `${dir()}/template-files-index`;
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[]) =>
    execFileSync('git', ['-C', dir(), ...args], {
      encoding: 'utf8',
      env,
    }).trim();
  run(['read-tree', head]);
  run([
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${blob},design/own.yaml`,
  ]);
  const written = run(['write-tree']);
  const commit = execFileSync(
    'git',
    ['-C', dir(), 'commit-tree', written, '-p', head, '-m', 'Own design'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    },
  ).trim();
  git('update-ref', 'refs/heads/main', commit);
  execFileSync('rm', ['-f', index]);
}, 60_000);
afterAll(() => t?.close());
afterEach(() => t.actAs(undefined));

async function changeSet(
  title: string,
): Promise<{ id: string; branch: string }> {
  const created = await t
    .post('/change-sets')
    .send(json({ data: { type: 'ChangeSet', attributes: { title } } }));
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  return { id, branch: attributes.branch };
}

const subject = (path: string, templateId = 'house') => ({
  type: 'template',
  templateId,
  path,
});
const copyPath = (id: string, path: string, templateId = 'house') =>
  `/change-sets/${id}/page-design-templates/${templateId}/files/working-copy?path=${encodeURIComponent(path)}`;

async function lock(id: string, path: string, templateId = 'house') {
  return t.post(`/change-sets/${id}/locks`).send(
    json({
      data: {
        type: 'Lock',
        attributes: { subject: subject(path, templateId) },
      },
    }),
  );
}

async function save(
  id: string,
  path: string,
  text: string,
  meta: { version: number; baseCommit: string },
  templateId = 'house',
) {
  return t.put(copyPath(id, path, templateId)).send(
    json({
      data: {
        type: 'WorkingCopy',
        attributes: { content: { schemaVersion: 1, text } },
      },
      meta,
    }),
  );
}

const preview = (query: string, templateId = 'house') =>
  t
    .get(
      `/page-design-templates/${templateId}/preview/pages/1.png?width=200&${query}`,
    )
    .set('Accept', 'image/png')
    .buffer(true);

describe('a template’s files, read at a ref (#396)', () => {
  it('lists the folder’s files by path, paged, and which are text', async () => {
    const res = await t.get('/page-design-templates/house/files');
    expect(res.status).toBe(200);
    const listed = PageDesignTemplateFilePageDocument.parse(res.body);
    expect(listed.data.map((f) => [f.id, f.attributes.text])).toEqual([
      ['default.typ', true],
      ['design.typ', true],
      ['manual.typ', true],
      ['notes.txt', true],
    ]);
    expect(listed.data[2]?.meta.draft).toBe(false);
    expect(listed.meta.page).toMatchObject({ total: 4 });
    expect((await t.get('/page-design-templates/nowhere/files')).status).toBe(
      404,
    );
    expect(
      (await t.get('/page-design-templates/house/files?filter[x]=1')).status,
    ).toBe(400);
  });

  it('reads a text file, and nothing outside the folder', async () => {
    const res = await t.get('/page-design-templates/house/file?path=notes.txt');
    expect(res.status).toBe(200);
    expect(
      PageDesignTemplateFileTextDocument.parse(res.body).data.attributes.text,
    ).toBe('Our house style.\n');
    for (const path of [
      '../../openfolia.yaml',
      '/etc/passwd',
      '..%2F..%2Fopenfolia.yaml',
      '.git/config',
      'manual',
    ]) {
      const refused = await t.get(
        `/page-design-templates/house/file?path=${encodeURIComponent(path)}`,
      );
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).not.toMatch(/root:|schemaVersion/);
    }
  });

  it('gives the example template a new one starts from', async () => {
    const res = await t.get('/page-design-template-example/files');
    expect(res.status).toBe(200);
    const listed = PageDesignTemplateFileTextPageDocument.parse(res.body);
    expect(listed.data.map((f) => f.id)).toEqual(
      Object.keys(EXAMPLE_TEMPLATE).sort(),
    );
    expect(
      listed.data.find((f) => f.id === 'manual.typ')?.attributes.text,
    ).toBe(EXAMPLE_TEMPLATE['manual.typ']);
  });

  it('previews the template on its probe manual', async () => {
    const res = await preview('');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    const past = await t
      .get('/page-design-templates/house/preview/pages/99.png')
      .set('Accept', 'image/png');
    expect(past.status).toBe(404);
    expect(ErrorDocument.parse(past.body).errors[0]?.meta).toMatchObject({
      pages: expect.any(Number),
    });
    expect((await preview('nope=1')).status).toBe(400);
  });
});

describe('editing a template’s files in a change set (#396)', () => {
  it('saves, previews the draft, commits exactly its text, and checks the design that names it', async () => {
    t.actAs(author);
    const cs = await changeSet('House template');
    const read = TemplateFileWorkingCopyDocument.parse(
      (await t.get(copyPath(cs.id, 'manual.typ'))).body,
    ).data.attributes;
    expect(read).toMatchObject({
      subject: subject('manual.typ'),
      version: 0,
      content: { schemaVersion: 1, text: EXAMPLE_TEMPLATE['manual.typ'] },
    });

    // A save needs the lock.
    const meta = { version: 0, baseCommit: read.baseCommit };
    expect((await save(cs.id, 'manual.typ', BROKEN, meta)).status).toBe(409);
    expect((await lock(cs.id, 'manual.typ')).status).toBe(201);
    const saved = await save(cs.id, 'manual.typ', BROKEN, meta);
    expect(saved.status).toBe(200);
    const after = TemplateFileWorkingCopyDocument.parse(saved.body).data;
    expect(after.attributes.version).toBe(1);
    expect(after.id).toBe(`${cs.id}/template/house/manual.typ`);

    // The live preview reads the draft: its error, with the file and line.
    const live = await preview(`ref=${cs.branch}&workingCopy=true`);
    expect(live.status).toBe(422);
    const [error] = ErrorDocument.parse(live.body).errors;
    expect(error).toMatchObject({
      code: 'template-error',
      meta: {
        template: 'house',
        problems: [
          expect.objectContaining({
            file: 'templates/house/manual.typ',
            line: BROKEN_LINE,
          }),
        ],
      },
    });
    // Without working copies, the branch's file: it compiles.
    expect((await preview(`ref=${cs.branch}`)).status).toBe(200);
    // The listing marks the draft.
    const files = PageDesignTemplateFilePageDocument.parse(
      (
        await t.get(
          `/page-design-templates/house/files?ref=${cs.branch}&workingCopy=true`,
        )
      ).body,
    );
    expect(files.data.filter((f) => f.meta.draft).map((f) => f.id)).toEqual([
      'manual.typ',
    ]);
    // A draft of a committed file is committed still.
    expect(files.data.every((f) => f.meta.committed)).toBe(true);

    // A new file and a deletion, in one save point.
    expect((await lock(cs.id, 'parts/notice.typ')).status).toBe(201);
    expect((await lock(cs.id, 'notes.txt')).status).toBe(201);
    expect(
      (
        await save(cs.id, 'parts/notice.typ', '#let notice = 1\n', {
          version: 0,
          baseCommit: read.baseCommit,
        })
      ).status,
    ).toBe(200);
    const committed = await t.post(`/change-sets/${cs.id}/commits`).send(
      json({
        data: {
          type: 'Commit',
          attributes: { deletes: [subject('notes.txt')] },
        },
      }),
    );
    expect(committed.status).toBe(201);
    expect(git('show', `${cs.branch}:templates/house/manual.typ`)).toBe(
      BROKEN.trimEnd(),
    );
    expect(
      execFileSync('git', [
        '-C',
        dir(),
        'show',
        `${cs.branch}:templates/house/manual.typ`,
      ]).toString(),
    ).toBe(BROKEN);
    expect(git('show', `${cs.branch}:templates/house/parts/notice.typ`)).toBe(
      '#let notice = 1',
    );
    expect(() =>
      execFileSync(
        'git',
        [
          '-C',
          dir(),
          'cat-file',
          '-e',
          `${cs.branch}:templates/house/notes.txt`,
        ],
        { stdio: 'ignore' },
      ),
    ).toThrow();

    // The design naming the template is held by the broken one.
    const checks = CheckPageDocument.parse(
      (await t.get(`/change-sets/${cs.id}/checks`)).body,
    ).data.map((c) => c.attributes);
    expect(checks).toContainEqual(
      expect.objectContaining({
        code: 'page-design-template-error',
        severity: 'blocking',
        subject: { type: 'design', designId: 'own' },
      }),
    );
    // The released content keeps the template as it was.
    expect(git('show', 'main:templates/house/manual.typ')).toBe(
      EXAMPLE_TEMPLATE['manual.typ']!.trimEnd(),
    );
  });

  it('starts a new template from its manual.typ alone', async () => {
    t.actAs(author);
    const cs = await changeSet('New template');
    const path = `/change-sets/${cs.id}/page-design-templates/fresh/files/working-copy?path=manual.typ`;
    expect((await t.get(path)).status).toBe(404);
    const baseCommit = git('rev-parse', cs.branch);
    expect(
      (
        await t.post(`/change-sets/${cs.id}/locks`).send(
          json({
            data: {
              type: 'Lock',
              attributes: {
                subject: {
                  type: 'template',
                  templateId: 'fresh',
                  path: 'manual.typ',
                },
              },
            },
          }),
        )
      ).status,
    ).toBe(201);
    const saved = await t.put(path).send(
      json({
        data: {
          type: 'WorkingCopy',
          attributes: {
            content: { schemaVersion: 1, text: EXAMPLE_TEMPLATE['manual.typ'] },
          },
        },
        meta: { version: 0, baseCommit },
      }),
    );
    expect(saved.status).toBe(200);
    const fresh = PageDesignTemplateFilePageDocument.parse(
      (
        await t.get(
          `/page-design-templates/fresh/files?ref=${cs.branch}&workingCopy=true`,
        )
      ).body,
    );
    expect(
      fresh.data.map((f) => [f.id, f.meta.draft, f.meta.committed]),
    ).toEqual([['manual.typ', true, false]]);
    // Listed with the drafts; not yet at the branch.
    const listed = PageDesignTemplatePageDocument.parse(
      (await t.get(`/page-design-templates?ref=${cs.branch}`)).body,
    );
    expect(listed.data.map((d) => d.id)).not.toContain('fresh');
    expect(
      PageDesignTemplatePageDocument.parse(
        (
          await t.get(
            `/page-design-templates?ref=${cs.branch}&workingCopy=true`,
          )
        ).body,
      ).data.map((d) => d.id),
    ).toContain('fresh');
    expect(
      (
        await t.get(
          `/page-design-templates/fresh/files?ref=${cs.branch}&workingCopy=true`,
        )
      ).status,
    ).toBe(200);
    expect((await t.post(`/change-sets/${cs.id}/commits`)).status).toBe(201);
    expect(
      PageDesignTemplatePageDocument.parse(
        (await t.get(`/page-design-templates?ref=${cs.branch}`)).body,
      ).data.map((d) => d.id),
    ).toContain('fresh');
  });

  it('keeps a template within its sandbox: a draft reading a host file is its error', async () => {
    t.actAs(author);
    const cs = await changeSet('Sandbox');
    const baseCommit = git('rev-parse', cs.branch);
    // A template of its own: the locks of the test before stay with its change set.
    expect((await lock(cs.id, 'manual.typ', 'walled')).status).toBe(201);
    expect(
      (
        await save(
          cs.id,
          'manual.typ',
          `${EXAMPLE_TEMPLATE['manual.typ']}#let secret = read("/etc/passwd")\n#let other = read("../../openfolia.yaml")\n`,
          { version: 0, baseCommit },
          'walled',
        )
      ).status,
    ).toBe(200);
    const res = await preview(`ref=${cs.branch}&workingCopy=true`, 'walled');
    expect(res.status).toBe(422);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'template-error',
    );
    expect(JSON.stringify(res.body)).not.toMatch(
      /root:|openfolia-typst-|languages:/,
    );
  });

  it('refuses a path outside the folder, a file that is no text and too much text', async () => {
    t.actAs(author);
    const cs = await changeSet('Paths');
    const baseCommit = git('rev-parse', cs.branch);
    for (const path of [
      '../../openfolia.yaml',
      '.hidden.typ',
      'a//b.typ',
      'logo.png',
      '/etc/passwd.txt',
    ]) {
      expect((await t.get(copyPath(cs.id, path))).status).toBe(404);
      expect(
        (await save(cs.id, path, 'x', { version: 0, baseCommit })).status,
      ).toBe(404);
      const locked = await lock(cs.id, path);
      expect(locked.status).toBe(400);
    }
    // A file where a folder is, or under a file: Git holds no file and folder of one name.
    expect((await lock(cs.id, 'manual.typ/inner.typ')).status).toBe(201);
    const clash = await save(cs.id, 'manual.typ/inner.typ', 'x', {
      version: 0,
      baseCommit,
    });
    expect(clash.status).toBe(422);
    expect(ErrorDocument.parse(clash.body).errors[0]?.code).toBe(
      'path-conflict',
    );
    // Two drafts of one name, a file and a folder: refused at the save point, not a 500.
    for (const path of ['twin.typ', 'twin.typ/inner.typ']) {
      expect((await lock(cs.id, path)).status).toBe(201);
      expect(
        (await save(cs.id, path, 'x', { version: 0, baseCommit })).status,
      ).toBe(200);
    }
    const twins = await t.post(`/change-sets/${cs.id}/commits`);
    expect(twins.status).toBe(422);
    expect(ErrorDocument.parse(twins.body).errors[0]?.code).toBe(
      'path-conflict',
    );
    expect((await lock(cs.id, 'big.typ')).status).toBe(201);
    const big = await save(cs.id, 'big.typ', 'x'.repeat(256 * 1024 + 1), {
      version: 0,
      baseCommit,
    });
    expect([400, 413]).toContain(big.status);
    const nul = await save(cs.id, 'big.typ', 'a\u0000b', {
      version: 0,
      baseCommit,
    });
    expect(nul.status).toBe(400);
  });

  it('refuses a save past the folder’s caps (422 template-too-large), and lists every draft with the folder’s size (#803)', async () => {
    t.actAs(author);
    const cs = await changeSet('Capped');
    const baseCommit = git('rev-parse', cs.branch);
    // A template only drafts hold, filled to MAX_TEMPLATE_BYTES exactly.
    const full = MAX_TEMPLATE_BYTES / MAX_TEMPLATE_FILE_BYTES;
    const paths = Array.from({ length: full }, (_, i) =>
      i === 0 ? 'manual.typ' : `f${String(i).padStart(2, '0')}.typ`,
    );
    const filled = `//${'x'.repeat(MAX_TEMPLATE_FILE_BYTES - 3)}\n`;
    for (const path of paths) {
      expect((await lock(cs.id, path, 'capped')).status).toBe(201);
      const res = await save(
        cs.id,
        path,
        filled,
        { version: 0, baseCommit },
        'capped',
      );
      expect(res.status).toBe(200);
    }
    const listedPath = `/page-design-templates/capped/files?ref=${cs.branch}&workingCopy=true&page[size]=10`;
    const before = PageDesignTemplateFilePageDocument.parse(
      (await t.get(listedPath)).body,
    );
    expect(before.meta.page.total).toBe(full);
    expect(before.meta.folder).toEqual({
      files: full,
      bytes: MAX_TEMPLATE_BYTES,
      maxFiles: MAX_TEMPLATE_FILES,
      maxBytes: MAX_TEMPLATE_BYTES,
      pastCaps: false,
    });

    // One byte more: refused before it is stored.
    expect((await lock(cs.id, 'more.typ', 'capped')).status).toBe(201);
    const refused = await save(
      cs.id,
      'more.typ',
      'x',
      { version: 0, baseCommit },
      'capped',
    );
    expect(refused.status).toBe(422);
    const error = ErrorDocument.parse(refused.body).errors[0];
    expect(error?.code).toBe('template-too-large');
    expect(error?.meta).toMatchObject({
      maxFiles: MAX_TEMPLATE_FILES,
      maxBytes: MAX_TEMPLATE_BYTES,
      files: full + 1,
      bytes: MAX_TEMPLATE_BYTES + 1,
    });
    expect((await t.get(copyPath(cs.id, 'more.typ', 'capped'))).status).toBe(
      404,
    );
    // A file made smaller makes room again.
    const smaller = await save(
      cs.id,
      'f01.typ',
      '// short\n',
      { version: 1, baseCommit },
      'capped',
    );
    expect(smaller.status).toBe(200);
    expect(
      (await save(cs.id, 'more.typ', 'x', { version: 0, baseCommit }, 'capped'))
        .status,
    ).toBe(200);
    expect(
      PageDesignTemplateFilePageDocument.parse((await t.get(listedPath)).body)
        .meta.folder,
    ).toMatchObject({ files: full + 1, pastCaps: false });
  }, 120_000);

  it('is changed only by one who may change page designs', async () => {
    t.actAs(narrow);
    const cs = await changeSet('Narrow');
    const baseCommit = git('rev-parse', cs.branch);
    expect((await lock(cs.id, 'manual.typ')).status).toBe(403);
    expect(
      (await save(cs.id, 'manual.typ', '// mine\n', { version: 0, baseCommit }))
        .status,
    ).toBe(403);
  });
});
