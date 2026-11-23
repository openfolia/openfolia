import { addSampleSnippets } from '@openfolia/content-repo/testing';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ModuleSummaryPageDocument } from '../src/modules/api/module-summary.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  // A snippet type in the configuration; a public snippet (also in German), an internal one.
  await addSampleSnippets(process.env['CCMS_CONTENT_DIR'] as string);
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const summaries = async (query: string) => {
  const res = await t.get(`/module-summaries${query}`);
  expect(res.status).toBe(200);
  return ModuleSummaryPageDocument.parse(res.body);
};

describe('GET /module-summaries?filter[snippet]=', () => {
  it('lists only the snippets, each with the start of its text', async () => {
    const page = await summaries('?filter[snippet]=true');
    expect(
      page.data.map((s) => [s.id, s.attributes.moduleType, s.meta.text]),
    ).toEqual([
      [
        'trained-staff',
        'snippet',
        'Only trained service staff may open the housing.',
      ],
      [
        'wear-gloves',
        'snippet',
        'Wear protective gloves when you touch the battery terminals.',
      ],
    ]);
    expect(page.meta.page.total).toBe(2);
    const others = await summaries('?filter[snippet]=false');
    expect(others.data.map((s) => s.id)).toEqual([
      'charging',
      'internals',
      'safety-note',
    ]);
  });

  it('gives the text in the language asked for', async () => {
    const page = await summaries('?filter[snippet]=true&filter[lang]=de');
    expect(page.data.map((s) => [s.id, s.meta.text])).toEqual([
      [
        'wear-gloves',
        'Tragen Sie Schutzhandschuhe, wenn Sie die Batteriepole berühren.',
      ],
    ]);
  });

  it('never offers a snippet the reader may not see', async () => {
    t.actAs(actorWith(['content.read'], { maxAudience: 'public' }));
    const page = await summaries('?filter[snippet]=true');
    expect(page.data.map((s) => s.id)).toEqual(['wear-gloves']);
  });

  it('refuses a value that is not true or false', async () => {
    const res = await t.get('/module-summaries?filter[snippet]=yes');
    expect(res.status).toBe(400);
    expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
      'invalid-parameter',
    );
  });
});
