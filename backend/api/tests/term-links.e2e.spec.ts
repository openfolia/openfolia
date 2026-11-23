import { execFileSync } from 'node:child_process';
import {
  Manifest,
  printManifest,
  printModule,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { addSampleTerms } from '@openfolia/content-repo/testing';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { TermDocument } from '../src/terms/api/term.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Term links and the glossary (#245) through the API, over the sample
 * repository with its terms (`addSampleTerms`: its `storage` module links
 * battery and charger, and the operating manual has a glossary), plus a
 * module linking a term that does not exist and a deprecated one, in a
 * manual of its own.
 */
const LINKS: Module = {
  schemaVersion: 1,
  id: 'links',
  meta: {
    title: 'Links',
    type: 'concept',
    lang: 'en',
    audience: 'public',
    facets: {},
  },
  blocks: [
    {
      type: 'paragraph',
      id: 'p',
      content: [
        {
          type: 'text',
          text: 'gizmo',
          marks: [{ type: 'term', termId: 'gizmo' }],
        },
        { type: 'text', text: ' and ' },
        {
          type: 'text',
          text: 'power pack',
          marks: [{ type: 'term', termId: 'power-pack' }],
        },
      ],
    },
  ],
};

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

beforeAll(async () => {
  t = await createTestApp();
  await addSampleTerms(dir());
  const parent = execFileSync(
    'git',
    ['-C', dir(), 'rev-parse', 'refs/heads/main'],
    { encoding: 'utf8', env },
  ).trim();
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent,
    changes: [
      { path: 'modules/en/links.adoc', content: printModule(LINKS) },
      {
        path: 'manuals/links.yaml',
        content: printManifest(
          Manifest.parse({
            schemaVersion: 1,
            id: 'links',
            title: 'Links',
            audience: 'public',
            variants: [{ model: 'large' }],
            entries: [{ module: 'links' }],
          }),
        ),
      },
    ],
    message: 'Add links',
    author: { name: 'Test', email: 'test@example.com' },
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('term links through the API (#245)', () => {
  it('previews a term link with its definition, and the glossary at the end', async () => {
    t.actAs(READER);
    const res = await t.get('/manuals/operating/variants/model=large/en/html');
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html).toMatch(
      /<span class="of-term"><a class="of-term__link" href="#of-_term-battery" aria-describedby="of-_term-tip-\d+">battery<\/a><span class="of-term__definition" role="tooltip" id="of-_term-tip-\d+">The rechargeable energy store that powers the vehicle\.<\/span><\/span>/,
    );
    const glossary = html.slice(html.indexOf('class="of-glossary"'));
    expect(glossary).toContain('<h2');
    expect(glossary).toContain('>Glossary</');
    expect(glossary.indexOf('id="of-_term-battery"')).toBeLessThan(
      glossary.indexOf('id="of-_term-charger"'),
    );
    expect(glossary).toContain(
      'The device that charges the <strong>battery</strong>.',
    );
  });

  it('checks the links: blocking for a term that does not exist, a warning for a deprecated one', async () => {
    t.actAs(READER);
    const res = await t.get('/manuals/links/checks');
    expect(res.status).toBe(200);
    const page = CheckPageDocument.parse(res.body);
    // The writing checks' `forbidden-term` (#55) is not about links.
    const terms = page.data.filter(
      (c) =>
        c.attributes.code.endsWith('-term') &&
        c.attributes.category !== 'writing',
    );
    expect(
      terms.map((c) => [
        c.attributes.code,
        c.attributes.severity,
        c.attributes.blockId,
        c.attributes.params,
      ]),
    ).toEqual([
      ['unknown-term', 'blocking', 'p', { term: 'gizmo' }],
      [
        'deprecated-term',
        'warning',
        'p',
        { term: 'power-pack', replacedBy: 'battery' },
      ],
    ]);
  });

  it('names the modules linking a term', async () => {
    t.actAs(READER);
    const res = await t.get('/terms/power-pack');
    expect(res.status).toBe(200);
    expect(TermDocument.parse(res.body).data.meta).toMatchObject({
      usage: { modules: 1 },
      linkedIn: [{ moduleId: 'links', lang: 'en', title: 'Links' }],
    });
    const housing = TermDocument.parse((await t.get('/terms/housing')).body);
    expect(housing.data.meta).toMatchObject({
      usage: { modules: 0 },
      linkedIn: [],
    });
  });

  it('refuses to delete a term still linked, and deletes it once nothing links it', async () => {
    const editor: Actor = {
      ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
      id: 'links-editor',
    };
    t.actAs(editor);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Terms' } },
      }),
    );
    expect(created.status).toBe(201);
    const changeSet = ChangeSetDocument.parse(created.body).data;
    const lock = (subject: unknown) =>
      t
        .post(`/change-sets/${changeSet.id}/locks`)
        .send(
          JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }),
        );
    const commit = (attributes: unknown) =>
      t
        .post(`/change-sets/${changeSet.id}/commits`)
        .send(JSON.stringify({ data: { type: 'Commit', attributes } }));
    const charger = { type: 'term', termId: 'charger' };
    const housing = { type: 'term', termId: 'housing' };
    expect((await lock(charger)).status).toBe(201);
    expect((await lock(housing)).status).toBe(201);
    const refused = await commit({ subjects: [], deletes: [charger] });
    expect(refused.status).toBe(422);
    expect(ErrorDocument.parse(refused.body).errors).toEqual([
      expect.objectContaining({
        status: '422',
        code: 'term-in-use',
        source: { pointer: '/module/en/storage/blocks/charge' },
        meta: {
          subject: { type: 'module', lang: 'en', moduleId: 'storage' },
          at: 'charge',
          term: 'charger',
        },
      }),
    ]);
    // A term nothing links goes.
    expect((await commit({ subjects: [], deletes: [housing] })).status).toBe(
      201,
    );
  });
});
