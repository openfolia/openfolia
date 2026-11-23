import { execFileSync } from 'node:child_process';
import {
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  printModule,
  type Block,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { ResolvedManualDocument } from '../src/manuals/api/manual.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #686: a table past the caps (`MAX_TABLE_COLUMNS`, `MAX_TABLE_CELLS`) is refused as content
 * that may not be (422 `table-too-large`) when it is saved. A module already in Git holding one
 * is answered the same where it is read, and is left out of its manuals as a module that cannot
 * be read (`invalid-module`, a blocking check): never laid out, never a 500.
 */

const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const text = (t: string) => [{ type: 'text' as const, text: t }];

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};

/** One row of `columns` columns, its single cell spanning 100 of them: few cells, wide. */
const wideTable = (columns: number): Block => ({
  type: 'table',
  id: 'wide',
  columns: Array.from({ length: columns }, () => ({ width: 1 })),
  header: false,
  rows: [
    {
      cells: Array.from({ length: Math.ceil(columns / 100) }, (_c, c) => ({
        colspan: Math.min(100, columns - c * 100),
        blocks: [],
      })),
    },
  ],
});

const module = (id: string, blocks: Block[]): Module => ({
  schemaVersion: 1,
  id,
  meta: {
    title: id,
    type: 'concept',
    lang: 'en',
    audience: 'public',
    facets: {},
    keywords: [],
  },
  blocks: [{ type: 'paragraph', id: 'intro', content: text(id) }, ...blocks],
});

const WIDE_MANUAL = `schemaVersion: 1
title: Wide manual
audience: public
variants:
  - model: large
entries:
  - module: wide
`;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  // Printed as it is: the printer never validates, so Git holds what no save would take.
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'modules/en/wide.adoc',
        content: printModule(
          module('wide', [wideTable(MAX_TABLE_COLUMNS + 1)]),
        ),
      },
      { path: 'manuals/wide.yaml', content: WIDE_MANUAL },
    ],
    message: 'A table past the caps',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

/** The answer's one error: 422 `table-too-large`, the caps in `meta`. */
const tooLarge = (res: { status: number; body: unknown }) => {
  expect(res.status).toBe(422);
  const [error, ...rest] = ErrorDocument.parse(res.body).errors;
  expect(rest).toEqual([]);
  expect(error).toMatchObject({
    status: '422',
    code: 'table-too-large',
    meta: { columns: MAX_TABLE_COLUMNS, cells: MAX_TABLE_CELLS },
  });
  expect(error?.detail).toContain('1,000 columns');
  return error;
};

describe('saving a table past the caps (#686)', () => {
  async function changeSet(): Promise<string> {
    t.actAs(author);
    const res = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Tables' } },
      }),
    );
    expect(res.status).toBe(201);
    const id = ChangeSetDocument.parse(res.body).data.id;
    const lock = await t.post(`/change-sets/${id}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: {
            subject: { type: 'module', lang: 'en', moduleId: 'charging' },
          },
        },
      }),
    );
    expect(lock.status).toBe(201);
    return id;
  }
  const save = (cs: string, content: unknown) =>
    t.put(`/change-sets/${cs}/modules/en/charging/working-copy`).send(
      JSON.stringify({
        data: { type: 'WorkingCopy', attributes: { content } },
        meta: { version: 0, baseCommit: t.commits.main },
      }),
    );

  it('is refused with 422 table-too-large, pointing at the table, past either cap', async () => {
    const cs = await changeSet();
    const committed = ModuleWorkingCopyDocument.parse(
      (await t.get(`/change-sets/${cs}/modules/en/charging/working-copy`)).body,
    ).data.attributes.content;
    const blocks = [...committed.blocks, wideTable(MAX_TABLE_COLUMNS + 1)];
    const error = tooLarge(await save(cs, { ...committed, blocks }));
    expect(error?.source).toEqual({
      pointer: `/data/attributes/content/blocks/${blocks.length - 1}`,
    });
    // 101 columns by 500 rows (50,500 places) in about 1,000 cells: at the top of each band of
    // 100 rows a cell spanning 100 by 100 and a single cell, every other row a single cell.
    const spanned: Block = {
      type: 'table',
      id: 'spanned',
      columns: Array.from({ length: 101 }, () => ({ width: 1 })),
      header: false,
      rows: Array.from({ length: 500 }, (_r, r) => ({
        cells: [
          ...(r % 100 === 0
            ? [{ colspan: 100, rowspan: 100, blocks: [] }]
            : []),
          { blocks: [] },
        ],
      })),
    };
    const spannedRes = await save(cs, {
      ...committed,
      blocks: [...committed.blocks, spanned],
    });
    expect(spannedRes.status).toBe(422);
    const [cellError] = ErrorDocument.parse(spannedRes.body).errors;
    expect(cellError).toMatchObject({
      code: 'table-too-large',
      meta: { columns: MAX_TABLE_COLUMNS, cells: MAX_TABLE_CELLS },
    });
    expect(cellError?.detail).toContain('50,000 cells');
    // At the cap, the same table is saved.
    const within = await save(cs, {
      ...committed,
      blocks: [...committed.blocks, wideTable(MAX_TABLE_COLUMNS)],
    });
    expect(within.status).toBe(200);
  });
});

describe('a table past the caps already in Git (#686)', () => {
  it('is refused with table-too-large where the module is read or previewed', async () => {
    const read = tooLarge(await t.get('/modules/en/wide'));
    expect(read?.meta).toMatchObject({ path: 'modules/en/wide.adoc' });
    const preview = await t.get('/modules/en/wide/preview');
    tooLarge({ status: preview.status, body: JSON.parse(preview.text) });
  });

  it('is left out of a manual as a module that cannot be read, saying why', async () => {
    // As any module whose file cannot be read: its manual resolves without it, with the
    // `invalid-module` issue, and its PDF and HTML are made without it.
    const res = await t.get('/manuals/wide/variants/model=large/en');
    expect(res.status).toBe(200);
    const manual = ResolvedManualDocument.parse(res.body).data;
    expect(manual.attributes.entries).toEqual([]);
    expect(manual.meta.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'invalid-module',
        module: 'wide',
        message: expect.stringContaining('a table has at most 1,000 columns'),
      }),
    ]);
    const html = await t.get('/manuals/wide/variants/model=large/en/html');
    expect(html.status).toBe(200);
    expect(html.text).not.toContain('of-table');
    const pdf = await t
      .get('/manuals/wide/variants/model=large/en/pdf')
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(String(pdf.body).slice(0, 5)).toBe('%PDF-');
  });

  it('is a blocking check of the module, not a failed check run', async () => {
    const res = await t.get('/manuals/wide/checks');
    expect(res.status).toBe(200);
    const invalid = CheckPageDocument.parse(res.body).data.filter(
      (c) => c.attributes.code === 'invalid-module',
    );
    expect(invalid.map((c) => c.attributes.severity)).toEqual(['blocking']);
  });

  it('leaves the other modules readable, and their chunks served', async () => {
    expect((await t.get('/modules/en/charging')).status).toBe(200);
    const chunks = await t.get('/chunks?filter[module]=charging');
    expect(chunks.status).toBe(200);
  });
});
