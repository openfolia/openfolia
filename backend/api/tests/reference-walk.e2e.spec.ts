import { execFileSync } from 'node:child_process';
import {
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_CHARS,
  MAX_EXPANDED_TABLE_CELLS,
  MAX_NESTING_DEPTH,
  printModule,
  type Block,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChunkPageDocument } from '../src/chunks/api/chunk.resources.js';
import { ResolvedManualDocument } from '../src/manuals/api/manual.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #679: a manual whose module references multiply past `MAX_EXPANDED_NODES` (a diamond 18
 * levels deep) is answered 422 `expansion-too-large` wherever it is made (resolution, PDF, page,
 * HTML, previews, a notice gathering), never a 500, and is a blocking check. Expanded per
 * reader: one who may not see half of the diamond reads the manual. Its chunks (#681) leave out
 * only the modules too large to cut (#688).
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * 2^18 paths down, nested 37 deep: within `MAX_NESTING_DEPTH`, past the size. Not deeper: each
 * level more makes three more modules too large to cut, and a commit of many such is too large
 * as a whole (#684, `CHUNK_SET_MODULES_AT_LIMITS`).
 */
const DEPTH = 18;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const text = (t: string) => [{ type: 'text' as const, text: t }];

const module = (id: string, blocks: Block[], north = false): Module => ({
  schemaVersion: 1,
  id,
  meta: {
    title: id,
    type: 'concept',
    lang: 'en',
    audience: 'public',
    facets: north ? { region: ['north'] } : {},
    keywords: [],
  },
  blocks,
});
const refs = (id: string, to: string[]): Block[] => [
  { type: 'paragraph', id: 'own', content: text(id) },
  ...to.map((ref): Block => ({
    type: 'moduleRef',
    id: `to-${ref}`,
    module: ref,
  })),
];

/** `j0` → `a0`, `b0` → `j1` → …: 2^18 paths down. The `b` modules are for the north only. */
function diamond(): Module[] {
  const modules: Module[] = [];
  for (let level = 0; level < DEPTH; level++) {
    const next = `j${level + 1}`;
    modules.push(
      module(`j${level}`, refs(`j${level}`, [`a${level}`, `b${level}`])),
      module(`a${level}`, refs(`a${level}`, [next])),
      module(`b${level}`, refs(`b${level}`, [next]), true),
    );
  }
  modules.push(module(`j${DEPTH}`, refs(`j${DEPTH}`, [])));
  // A safety message holding the whole diamond: what a notice gathering gives of it.
  modules.push(
    module('deep-notice', [
      {
        type: 'safety',
        id: 'notice',
        severity: 'warning',
        hazard: text('Deep'),
        symbols: [],
        blocks: [{ type: 'moduleRef', id: 'to-j0', module: 'j0' }],
      },
    ]),
  );
  return modules;
}

const DEEP = `schemaVersion: 1
title: Deep manual
audience: public
variants:
  - model: large
entries:
  - module: j0
  - module: deep-notice
`;
const DEEP_NOTICES = `schemaVersion: 1
kind: derived
title: Deep notices
audience: public
variants:
  - model: large
rule:
  source: deep
  notices:
    groupBy: module
`;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      ...diamond().map((m) => ({
        path: `modules/en/${m.id}.adoc`,
        content: printModule(m),
      })),
      { path: 'manuals/deep.yaml', content: DEEP },
      { path: 'manuals/deep-notices.yaml', content: DEEP_NOTICES },
    ],
    message: 'A diamond of module references',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const binary: Parameters<ReturnType<TestApp['get']>['parse']>[0] = (
  r,
  done,
) => {
  const chunks: Buffer[] = [];
  r.on('data', (chunk: Buffer) => chunks.push(chunk));
  r.on('end', () => done(null, Buffer.concat(chunks)));
};

const tooLarge = (res: { status: number; body: unknown }) => {
  expect(res.status).toBe(422);
  const [error] = ErrorDocument.parse(res.body).errors;
  expect(error).toMatchObject({
    status: '422',
    code: 'expansion-too-large',
    meta: {
      nodes: MAX_EXPANDED_NODES,
      chars: MAX_EXPANDED_CHARS,
      tableCells: MAX_EXPANDED_TABLE_CELLS,
      depth: MAX_NESTING_DEPTH,
    },
  });
  expect(error?.detail).toContain('500,000');
};

describe('a manual expanding past the limit (#679)', () => {
  it('is refused with expansion-too-large by resolution, PDF, page, HTML and previews', async () => {
    tooLarge(await t.get('/manuals/deep/variants/model=large/en'));
    const pdf = await t
      .get('/manuals/deep/variants/model=large/en/pdf')
      .buffer(true)
      .parse(binary);
    expect(pdf.status).toBe(422);
    tooLarge({ status: pdf.status, body: JSON.parse(String(pdf.body)) });
    const page = await t
      .get('/manuals/deep/variants/model=large/en/pdf/pages/1.png')
      .buffer(true)
      .parse(binary);
    tooLarge({ status: page.status, body: JSON.parse(String(page.body)) });
    // The HTML routes answer their errors as JSON:API too.
    const html = await t.get('/manuals/deep/variants/model=large/en/html');
    tooLarge({ status: html.status, body: JSON.parse(html.text) });
    const preview = await t.get('/modules/en/j0/preview');
    tooLarge({ status: preview.status, body: JSON.parse(preview.text) });
    tooLarge(
      await t.get('/manuals/deep/variants/model=large/en/pdf/layout-warnings'),
    );
    tooLarge(await t.get('/modules/en/j0/hidden-content'));
    tooLarge(
      await t.get('/manuals/deep/variants/model=large/en/hidden-content'),
    );
  });

  it('is refused for a notice gathering whose notice holds it', async () => {
    tooLarge(await t.get('/manuals/deep-notices/variants/model=large/en'));
  });

  it('is a blocking check of the manual, per variant and language', async () => {
    const res = await t.get('/manuals/deep/checks');
    expect(res.status).toBe(200);
    const checks = CheckPageDocument.parse(res.body).data;
    const large = checks.filter(
      (c) =>
        c.attributes.code === 'expansion-too-large' &&
        c.attributes.subject.type === 'manual',
    );
    expect(large).toHaveLength(1);
    expect(large[0]?.attributes).toMatchObject({
      severity: 'blocking',
      category: 'reference',
      subject: { type: 'manual', manualId: 'deep' },
    });
    // Each language: the diamond's modules fall back to English.
    expect(large[0]?.meta).toMatchObject({
      variants: ['model=large'],
      languages: ['en', 'de', 'fr'],
    });
    // Nothing else is made of it: no PDF to check.
    expect(checks.map((c) => c.attributes.code)).not.toContain(
      'pdf-not-checked',
    );
  });

  it('expands per reader: one who may not see half the diamond reads the manual', async () => {
    t.actAs(actorWith(['content.read'], { facets: { region: ['south'] } }));
    const res = await t.get('/manuals/deep/variants/model=large/en');
    expect(res.status).toBe(200);
    const { attributes } = ResolvedManualDocument.parse(res.body).data;
    const body = JSON.stringify(attributes.entries);
    expect(body).toContain(`"j${DEPTH}"`);
    expect(body).not.toMatch(/"b\d+"/);
    // The reader who sees it all still gets the refusal: nothing carried over.
    t.actAs(undefined);
    tooLarge(await t.get('/manuals/deep/variants/model=large/en'));
  });
});

describe('chunks of a module expanding past the limit (#681, #688)', () => {
  type LeftOut = { moduleId: string; lang: string; reason: string };
  const chunks = (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(200);
    return ChunkPageDocument.parse(res.body);
  };

  it('leaves out only the modules too large to cut, names them, and serves the rest, never a 500', async () => {
    const page = chunks(await t.get('/chunks?page[size]=200'));
    const leftOut = (page.meta.leftOut ?? []) as LeftOut[];
    const names = leftOut.map((m) => m.moduleId);
    // The top of the diamond holds 2^18 paths: left out; its bottom is chunked.
    expect(names).toEqual(expect.arrayContaining(['a0', 'b0', 'j0']));
    expect(leftOut.every((m) => m.lang === 'en' && m.reason === 'size')).toBe(
      true,
    );
    const ids = page.data.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([`en/j${DEPTH}`, 'en/charging']),
    );
    expect(ids.some((id) => names.includes(id.split('/')[1] ?? ''))).toBe(
      false,
    );
    // Only what the request asks for is named.
    const bottom = chunks(await t.get(`/chunks?filter[module]=j${DEPTH}`));
    expect(bottom.data.map((c) => c.id)).toEqual([`en/j${DEPTH}`]);
    expect(bottom.meta.leftOut).toBeUndefined();
    const variant = chunks(await t.get('/chunks?filter[variant]=model=large'));
    expect(variant.meta.leftOut).toEqual(page.meta.leftOut);
  });

  it('expands per reader: one who may not see half the diamond reads every chunk', async () => {
    t.actAs(actorWith(['content.read'], { facets: { region: ['south'] } }));
    const res = await t.get('/chunks?filter[module]=j0&filter[lang]=en');
    const page = chunks(res);
    expect(page.meta.leftOut).toBeUndefined();
    const [chunk] = page.data;
    expect(chunk?.attributes.text).toContain(`j${DEPTH}`);
    expect(chunk?.attributes.text).not.toMatch(/^b\d+$/m);
    // The reader who sees it all still has it left out: nothing carried over.
    t.actAs(undefined);
    expect(
      chunks(await t.get('/chunks?filter[module]=j0&filter[lang]=en')).meta
        .leftOut,
    ).toEqual([{ moduleId: 'j0', lang: 'en', reason: 'size' }]);
  });
});
