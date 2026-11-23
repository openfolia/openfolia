import { execFileSync } from 'node:child_process';
import {
  parseConfig,
  parseModule,
  printConfig,
  printModule,
  type Block,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #58: every PDF is tagged and declares PDF/UA-1 unless `pdf.standard` is
 * `none`; a document that cannot meet it is 422 `pdf-accessibility` on the
 * PDF route and a blocking check on the manual.
 */
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const text = (value: string) => [{ type: 'text' as const, text: value }];
const para = (id: string, value: string): Block => ({
  type: 'paragraph',
  id,
  content: text(value),
});
/** A table with a header row; a control character no font can show, which PDF/UA-1 refuses. */
const TABLE: Block = {
  type: 'table',
  id: 'lights',
  header: true,
  columns: [{ width: 1 }, { width: 2 }],
  rows: [
    {
      cells: [
        { blocks: [para('h1', 'Light')] },
        { blocks: [para('h2', 'Meaning')] },
      ],
    },
    {
      cells: [
        { blocks: [para('c1', 'Green')] },
        { blocks: [para('c2', 'Ready')] },
      ],
    },
  ],
};
const UNPRINTABLE = para('glyph', 'Charged \u{7}');

/** A branch off `main` whose `charging` module ends with `blocks`, and the configuration `standard` sets. */
async function branch(
  name: string,
  blocks: Block[],
  standard?: 'none',
): Promise<void> {
  git('branch', name, 'main');
  const charging = parseModule(git('show', 'main:modules/en/charging.adoc'), {
    id: 'charging',
  });
  const config = parseConfig(git('show', 'main:openfolia.yaml'));
  await new GitWriter(dir()).commit({
    branch: name,
    parent: git('rev-parse', `refs/heads/${name}`),
    changes: [
      {
        path: 'modules/en/charging.adoc',
        content: printModule({
          ...charging,
          blocks: [...charging.blocks, ...blocks],
        }),
      },
      ...(standard
        ? [
            {
              path: 'openfolia.yaml',
              content: printConfig({ ...config, pdf: { standard } }),
            },
          ]
        : []),
    ],
    message: `PDF/UA: ${name}`,
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}

const pdf = (ref: string, variant = 'model=large') =>
  t
    .get(`/manuals/operating/variants/${variant}/en/pdf?ref=${ref}`)
    .set('Accept', 'application/pdf')
    .buffer(true);
const checks = async (ref: string) => {
  const res = await t.get(`/manuals/operating/checks?ref=${ref}`);
  expect(res.status).toBe(200);
  return CheckPageDocument.parse(res.body);
};

beforeAll(async () => {
  t = await createTestApp();
  await branch('ua-table', [TABLE]);
  await branch('ua-refused', [UNPRINTABLE]);
  await branch('ua-off', [TABLE, UNPRINTABLE], 'none');
}, 60_000);
afterAll(() => t?.close());

describe('PDF/UA-1', () => {
  it('tags the sample manual and declares PDF/UA-1, with its title and language', async () => {
    const res = await pdf('main');
    expect(res.status).toBe(200);
    const body = (res.body as Buffer).toString('latin1');
    expect(body).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(body).toMatch(/\/Type \/StructTreeRoot/);
    expect(body).toMatch(/\/MarkInfo <<\s*\/Marked true/);
    expect(body).toMatch(/\/Lang \(en\)/);
    expect(body).toContain('/Title (Operating manual)');
    expect(body).toMatch(/\/DisplayDocTitle true/);
    // Headings with levels (the contents' title, the module), the image with its alt text.
    expect(body).toMatch(/\/S \/H1\b/);
    expect(body).toMatch(/\/S \/Figure[\s\S]*?\/Alt \(The charger\)/);
    expect(body).toMatch(/\/S \/TOC\b/);
  });

  it('marks a table’s header row', async () => {
    const res = await pdf('ua-table');
    expect(res.status).toBe(200);
    const body = (res.body as Buffer).toString('latin1');
    expect(body).toMatch(/\/S \/THead[\s\S]*?\/S \/TH\b/);
    expect(body).toContain('<pdfuaid:part>1</pdfuaid:part>');
  });

  it('refuses a document that cannot meet it with 422 pdf-accessibility, and reports it as a blocking check', async () => {
    const res = await pdf('ua-refused');
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/vnd.api+json');
    const [error] = ErrorDocument.parse(res.body).errors;
    expect(error).toMatchObject({ status: '422', code: 'pdf-accessibility' });
    const problems = error?.meta?.['problems'] as { message: string }[];
    expect(problems[0]?.message).toMatch(
      /^PDF\/UA-1 error: the text .* could not be displayed/,
    );

    const found = (await checks('ua-refused')).data.filter(
      (c) => c.attributes.code === 'pdf-accessibility',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.attributes).toMatchObject({
      severity: 'blocking',
      subject: { type: 'manual', manualId: 'operating' },
    });
    expect(found[0]?.attributes.params['problem']).toMatch(
      /could not be displayed/,
    );
    // Found in both variants; in English, and in the languages that fall back to it.
    expect(found[0]?.meta.variants).toEqual(['model=small', 'model=large']);
    expect(found[0]?.meta.languages).toContain('en');
  });

  it('renders as before with pdf.standard: none, and checks nothing', async () => {
    const res = await pdf('ua-off');
    expect(res.status).toBe(200);
    const body = (res.body as Buffer).toString('latin1');
    expect(body.startsWith('%PDF-')).toBe(true);
    expect(body).not.toContain('pdfuaid');
    expect(
      (await checks('ua-off')).data.map((c) => c.attributes.code),
    ).not.toContain('pdf-accessibility');
  });

  it('reports no accessibility problem for the sample manual', async () => {
    expect(
      (await checks('main')).data.map((c) => c.attributes.code),
    ).not.toContain('pdf-accessibility');
  });
});
