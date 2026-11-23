import { Readable } from 'node:stream';
import { PNG, PNG_HASH } from '@openfolia/content-repo/testing';
import type { z } from 'zod';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import {
  ManualDocument,
  ManualPageDocument,
  ResolvedManualDocument,
} from '../src/manuals/api/manual.resources.js';
import {
  ModuleDocument,
  ModulePageDocument,
} from '../src/modules/api/module.resources.js';
import { ModuleSummaryPageDocument } from '../src/modules/api/module-summary.resources.js';
import {
  ProjectConfigDocument,
  RefPageDocument,
} from '../src/project/api/project.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
beforeAll(async () => {
  // Blank optional settings, as in a copied .env.example, mean "default".
  t = await createTestApp({
    CCMS_PDF_WORKERS: '',
    CCMS_PDF_QUEUE: '',
    CCMS_PDF_TIMEOUT_MS: ' ',
  });
});
afterAll(() => t?.close());

/**
 * Bodies are checked against the schemas the OpenAPI document is generated
 * from, so the documentation cannot promise what the server does not send.
 */
const link = (s: string | null) => s && decodeURIComponent(s);

const as = <T>(schema: z.ZodType<T>, body: unknown): T => schema.parse(body);

/** The single error of an error document. */
const error = (body: unknown) => {
  const { errors } = as(ErrorDocument, body);
  const [only, ...rest] = errors;
  expect(rest).toEqual([]);
  if (!only) throw new Error('empty error document');
  return only;
};

describe('authentication', () => {
  it('rejects requests without a valid token', async () => {
    const missing = await t.anonymous().get('/config');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    expect(error(missing.body)).toMatchObject({
      status: '401',
      title: 'Unauthorized',
      code: 'unauthorized',
    });
    const wrong = await t
      .anonymous()
      .get('/config')
      .set('Authorization', 'Bearer wrong');
    expect(wrong.status).toBe(401);
    expect((await t.get('/config')).status).toBe(200);
  });

  it('serves the health check without a token, as plain JSON', async () => {
    const res = await t.anonymous().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      database: 'ok',
      pool: 'ok',
      blobs: 'ok',
    });
  });
});

describe('JSON:API', () => {
  it('answers with the JSON:API media type, errors included', async () => {
    const ok = await t.get('/config');
    expect(ok.headers['content-type']).toBe(JSON_API);
    const notFound = await t.get('/modules/en/nope');
    expect(notFound.headers['content-type']).toBe(JSON_API);
    // Binary routes too, for their errors.
    const pdfError = await t.get('/manuals/nope/variants/model=large/en/pdf');
    expect(pdfError.headers['content-type']).toBe(JSON_API);
    as(ErrorDocument, pdfError.body);
  });

  it('negotiates the media type', async () => {
    for (const accept of [
      JSON_API,
      '*/*',
      'text/html, application/xhtml+xml, */*;q=0.8',
    ]) {
      expect((await t.get('/config').set('Accept', accept)).status).toBe(200);
    }
    for (const accept of [
      'application/json',
      `${JSON_API}; ext="https://example.com/ext"`,
    ]) {
      const res = await t.get('/config').set('Accept', accept);
      expect(res.status).toBe(406);
      expect(error(res.body).code).toBe('not-acceptable');
    }
  });

  it('rejects query parameters a route does not support', async () => {
    const res = await t.get('/manuals?sort=-title&filter[lang]=en');
    expect(res.status).toBe(400);
    const { errors } = as(ErrorDocument, res.body);
    expect(errors.map((e) => e.source?.parameter).sort()).toEqual([
      'filter[lang]',
      'sort',
    ]);
  });

  it('names the parameter at fault', async () => {
    const res = await t.get('/modules/en/Bad_Id');
    expect(res.status).toBe(400);
    expect(error(res.body)).toMatchObject({
      code: 'invalid-parameter',
      source: { parameter: 'id' },
    });
  });
});

describe('paging', () => {
  it('pages every list, with meta and links', async () => {
    const res = await t.get('/modules?page[size]=2&page[number]=2');
    const page = as(ModulePageDocument, res.body);
    // Ordered by language, then ID: de/charging, en/charging, en/internals, …
    expect(page.data.map((m) => m.id)).toEqual([
      'en/internals',
      'en/safety-note',
    ]);
    expect(page.meta.page).toEqual({
      currentPage: 2,
      lastPage: 2,
      perPage: 2,
      total: 4,
    });
    expect(link(page.links.prev)).toBe('/modules?page[size]=2&page[number]=1');
    expect(page.links.next).toBeNull();

    const refs = as(RefPageDocument, (await t.get('/refs')).body);
    expect(refs.meta.page.total).toBe(refs.data.length);
  });

  it('keeps other parameters in the links', async () => {
    const res = await t.get('/modules?filter[lang]=en&page[size]=1&ref=v1');
    const page = as(ModulePageDocument, res.body);
    expect(link(page.links.next)).toBe(
      '/modules?filter[lang]=en&page[size]=1&ref=v1&page[number]=2',
    );
  });

  it('rejects malformed or too large pages', async () => {
    for (const [query, parameter] of [
      ['page[size]=0', 'page[size]'],
      ['page[size]=201', 'page[size]'],
      ['page[number]=x', 'page[number]'],
    ] as const) {
      const res = await t.get(`/manuals?${query}`);
      expect(res.status).toBe(400);
      expect(error(res.body).source).toEqual({ parameter });
    }
  });
});

describe('refs and caching', () => {
  it('lists branches and tags', async () => {
    const refs = as(RefPageDocument, (await t.get('/refs')).body);
    expect(refs.data).toContainEqual({
      type: 'Ref',
      id: 'tags/v1',
      attributes: { kind: 'tag', name: 'v1', commit: t.commits.v1 },
      meta: { withdrawal: null },
    });
    expect(refs.data.map((r) => r.id)).toContain('heads/main');
  });

  it('reads at the requested ref and reports the commit', async () => {
    const main = await t.get('/modules/en/charging');
    expect(main.headers['x-ccms-commit']).toBe(t.commits.main);
    expect(main.headers['cache-control']).toBe('private, no-cache');
    expect(JSON.stringify(as(ModuleDocument, main.body))).toContain(
      'charges automatically',
    );
    const old = await t.get('/modules/en/charging?ref=v1');
    expect(JSON.stringify(old.body)).toContain('charges itself');
  });

  it('marks responses for a commit ID as immutable and supports revalidation', async () => {
    const res = await t.get(`/config?ref=${t.commits.v1}`);
    const config = as(ProjectConfigDocument, res.body);
    expect(config.data).toMatchObject({ type: 'ProjectConfig', id: 'project' });
    expect(res.headers['cache-control']).toContain('immutable');
    const again = await t
      .get(`/config?ref=${t.commits.v1}`)
      .set('If-None-Match', res.headers['etag'] ?? '');
    expect(again.status).toBe(304);
  });

  it('rejects a repeated ref instead of reading the default', async () => {
    const res = await t.get('/config?ref=v1&ref=v1');
    expect(res.status).toBe(400);
    expect(error(res.body).source).toEqual({ parameter: 'ref' });
  });

  it('never lets an error response be cached', async () => {
    const res = await t.get(`/modules/en/nope?ref=${t.commits.v1}`);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['etag'] ?? '').not.toContain(t.commits.v1);
  });

  it('returns 404 for unknown or unsafe refs', async () => {
    for (const ref of ['nope', '--help', 'main~1', 'v1:openfolia.yaml']) {
      const res = await t.get(`/config?ref=${encodeURIComponent(ref)}`);
      expect(res.status).toBe(404);
      expect(error(res.body).code).toBe('not-found');
    }
  });
});

describe('modules', () => {
  it('lists modules as full resources, optionally by language', async () => {
    const page = as(
      ModulePageDocument,
      (await t.get('/modules?filter[lang]=de')).body,
    );
    expect(page.data).toEqual([
      expect.objectContaining({
        type: 'Module',
        id: 'de/charging',
        attributes: expect.objectContaining({
          moduleId: 'charging',
          lang: 'de',
          title: 'Laden',
          moduleType: 'procedure',
        }),
      }),
    ]);
  });

  it('reads a module with its validation issues in meta', async () => {
    const doc = as(ModuleDocument, (await t.get('/modules/en/charging')).body);
    expect(doc.data.id).toBe('en/charging');
    expect(doc.data.attributes.blocks.length).toBeGreaterThan(0);
    expect(doc.data.meta.issues).toEqual([]);
    expect(doc.data.attributes.keywords).toEqual(['maintenance', 'battery']);
    const none = as(
      ModuleDocument,
      (await t.get('/modules/en/safety-note')).body,
    );
    expect(none.data.attributes).not.toHaveProperty('keywords');
    const missing = await t.get('/modules/en/nope');
    expect(missing.status).toBe(404);
  });

  it('rejects malformed IDs before any lookup', async () => {
    for (const path of [
      '/modules/en/..%2Fopenfolia',
      '/modules/en/Bad_Id',
      '/modules?filter[lang]=x%20y',
    ]) {
      const res = await t.get(path);
      expect(res.status).toBe(400);
      const { errors } = as(ErrorDocument, res.body);
      expect(errors.every((e) => e.code === 'invalid-parameter')).toBe(true);
    }
  });

  it('lists a broken module with its error and reads it as 422', async () => {
    const page = as(
      ModulePageDocument,
      (await t.get('/modules?ref=draft&filter[lang]=en')).body,
    );
    expect(page.data).toContainEqual({
      type: 'Module',
      id: 'en/broken',
      attributes: { moduleId: 'broken', lang: 'en' },
      meta: { error: expect.stringContaining('modules/en/broken.adoc') },
    });
    const res = await t.get('/modules/en/broken?ref=draft');
    expect(res.status).toBe(422);
    expect(error(res.body)).toMatchObject({
      code: 'invalid-content',
      meta: { path: 'modules/en/broken.adoc' },
    });
  });
});

describe('module summaries', () => {
  const summaries = async (query: string) => {
    const res = await t.get(`/module-summaries${query}`);
    expect(res.status).toBe(200);
    return as(ModuleSummaryPageDocument, res.body);
  };

  it('lists one row per module, languages grouped, none changed on the released branch', async () => {
    const page = await summaries('');
    expect(page.data.map((s) => s.id)).toEqual([
      'charging',
      'internals',
      'safety-note',
    ]);
    expect(page.data[0]).toEqual({
      type: 'ModuleSummary',
      id: 'charging',
      attributes: expect.objectContaining({
        moduleId: 'charging',
        title: 'Charging',
        titleLang: 'en',
        moduleType: 'procedure',
        languages: ['en', 'de'],
      }),
      // The start of its text; a text attribute's value depends on the manual: its reference.
      meta: {
        changed: false,
        text: expect.stringMatching(
          /^The \{product-name\} charges automatically\. /,
        ),
      },
    });
    expect(page.meta.page).toMatchObject({ total: 3, currentPage: 1 });
  });

  it('marks what a branch changed, and filters on it before paging', async () => {
    const draft = await summaries('?ref=draft');
    expect(
      Object.fromEntries(draft.data.map((s) => [s.id, s.meta.changed])),
    ).toEqual({
      charging: false,
      internals: false,
      'safety-note': false,
      unlabelled: true,
    });
    const changed = await summaries('?ref=draft&filter[changed]=true');
    expect(changed.data.map((s) => s.id)).toEqual(['unlabelled']);
    expect(changed.meta.page.total).toBe(1);
    // The release tag is older than the released branch: its English charging differs.
    const tag = await summaries('?ref=v1&filter[changed]=true');
    expect(tag.data.map((s) => s.id)).toEqual(['charging']);
  });

  it('filters by language, type, audience, facet and text', async () => {
    const de = await summaries('?filter[lang]=de');
    expect(de.data).toMatchObject([
      { id: 'charging', attributes: { title: 'Laden', titleLang: 'de' } },
    ]);
    const q = await summaries('?filter[q]=LADEN&page[size]=1');
    expect(q.data.map((s) => s.id)).toEqual(['charging']);
    expect(link(q.links.self)).toContain('filter[q]=LADEN');
    const procedures = await summaries('?filter[type]=procedure');
    expect(
      procedures.data.every((s) => s.attributes.moduleType === 'procedure'),
    ).toBe(true);
    const none = await summaries(
      '?filter[audience]=nobody&filter[facet]=region:north',
    );
    expect(none.data).toEqual([]);
  });

  it('reads the summaries of the module IDs asked for (#481)', async () => {
    const page = await summaries('?filter[id]=internals,charging,no-such');
    expect(page.data.map((s) => s.id)).toEqual(['charging', 'internals']);
    expect(page.meta.page.total).toBe(2);
    expect(link(page.links.self)).toContain('filter[id]=internals,charging');
  });

  it('filters by keywords and repeated facets, and lists the shown language’s keywords', async () => {
    const page = await summaries('?filter[keyword]=MAINTENANCE');
    expect(page.data.map((s) => s.id)).toEqual(['charging', 'internals']);
    expect(page.data[0]?.attributes.keywords).toEqual([
      'maintenance',
      'battery',
    ]);
    // German keywords, the row in German.
    const de = await summaries('?filter[lang]=de&filter[keyword]=wartung');
    expect(de.data.map((s) => [s.id, s.attributes.keywords])).toEqual([
      ['charging', ['Wartung', 'Akku']],
    ]);
    expect(
      (await summaries('?filter[lang]=en&filter[keyword]=wartung')).data,
    ).toEqual([]);
    expect(
      (
        await summaries(
          '?filter[keyword]=maintenance&filter[keyword]=internal%20wiring',
        )
      ).data.map((s) => s.id),
    ).toEqual(['internals']);
    expect(
      (
        await summaries(
          '?filter[facet]=region:north&filter[facet]=region:south',
        )
      ).data,
    ).toEqual([]);
    const unlabelled = await summaries('?ref=draft&filter[q]=unlabelled');
    expect(unlabelled.data[0]?.attributes.keywords).toEqual([]);
  });

  it('counts only what the reader may see, whatever the filter names', async () => {
    t.actAs(actorWith(['content.read'], { maxAudience: 'public' }));
    try {
      const page = await summaries('?filter[keyword]=maintenance');
      expect(page.data.map((s) => s.id)).toEqual(['charging']);
      expect(page.meta.page.total).toBe(1);
      const hidden = await summaries('?filter[keyword]=internal%20wiring');
      const unknown = await summaries('?filter[keyword]=no-such');
      expect(hidden.data).toEqual([]);
      expect(hidden.meta.page).toEqual(unknown.meta.page);
    } finally {
      t.actAs(undefined);
    }
  });

  it('keys its ETag on the released branch too, and is never immutable', async () => {
    const commit = t.commits.v1;
    const pinned = await t.get(`/module-summaries?ref=${commit}`);
    expect(pinned.headers['cache-control']).toBe('private, no-cache');
    const modules = await t.get(`/modules?ref=${commit}`);
    expect(pinned.headers['etag']).not.toBe(modules.headers['etag']);
    const again = await t
      .get(`/module-summaries?ref=${commit}`)
      .set('If-None-Match', pinned.headers['etag'] ?? '');
    expect(again.status).toBe(304);
    // An ETag that covers only the requested commit no longer answers 304.
    const stale = await t
      .get(`/module-summaries?ref=${commit}`)
      .set('If-None-Match', modules.headers['etag'] ?? '');
    expect(stale.status).toBe(200);
  });

  it('refuses malformed filters and unknown parameters', async () => {
    for (const query of [
      '?filter[changed]=yes',
      '?filter[facet]=region',
      '?filter[facet]=region:north&filter[facet]=nope',
      '?filter[keyword]=a,b',
      `?filter[keyword]=${'k'.repeat(65)}`,
      `?${Array.from({ length: 33 }, (_, i) => `filter[keyword]=k${i}`).join('&')}`,
      '?filter[type]=Bad_Type',
      '?filter[q]=%20',
      '?filter[lang]=x%20y',
      '?filter[q]=a&filter[q]=b',
      '?filter[id]=',
      '?filter[id]=a,,b',
      '?filter[id]=Not_An_Id',
      `?filter[id]=${Array.from({ length: 201 }, (_, i) => `m${i}`).join(',')}`,
      '?filter[id]=a&filter[id]=b',
      `?filter[q]=a${'%20'.repeat(250)}`,
    ]) {
      const res = await t.get(`/module-summaries${query}`);
      expect(res.status).toBe(400);
      const { errors } = as(ErrorDocument, res.body);
      expect(errors.map((e) => e.code)).toContain('invalid-parameter');
      expect(errors.every((e) => e.code === 'invalid-parameter')).toBe(true);
    }
    const unknown = await t.get('/module-summaries?filter[state]=draft');
    expect(unknown.status).toBe(400);
    expect(error(unknown.body).code).toBe('unsupported-parameter');
  });
});

describe('manuals', () => {
  it('lists manuals with their published variants', async () => {
    const page = as(ManualPageDocument, (await t.get('/manuals')).body);
    expect(page.data).toHaveLength(2);
    expect(page.data[0]).toMatchObject({
      type: 'Manual',
      id: 'operating',
      attributes: { title: 'Operating manual' },
    });
    expect(page.data[1]).toMatchObject({
      type: 'Manual',
      id: 'service',
      attributes: { title: 'Service manual' },
    });
  });

  it('reads a manual: stored manifest in attributes, derived data in meta', async () => {
    const doc = as(ManualDocument, (await t.get('/manuals/operating')).body);
    expect(doc.data.attributes.variants).toEqual([
      { model: 'small' },
      { model: 'large' },
    ]);
    expect(doc.data.attributes.textAttributes).toHaveProperty('product-name');
    expect(doc.data.meta.variants).toEqual([
      { slug: 'model=small', label: 'Small', values: { model: 'small' } },
      { slug: 'model=large', label: 'Large', values: { model: 'large' } },
    ]);
  });

  it('resolves a manual for a listed variant and language', async () => {
    const res = await t.get('/manuals/operating/variants/model=large/en');
    expect(res.status).toBe(200);
    const { data } = as(ResolvedManualDocument, res.body);
    expect(data.id).toBe('operating/model=large/en');
    expect(data.relationships.manual.data).toEqual({
      type: 'Manual',
      id: 'operating',
    });
    expect(JSON.stringify(data.attributes)).toContain(
      'The Model A charges automatically.',
    );
    expect(data.meta.issues).toEqual([
      expect.objectContaining({ code: 'above-audience', module: 'internals' }),
    ]);
  });

  it('only serves listed variants and configured languages', async () => {
    for (const path of [
      '/manuals/operating/variants/model=huge/en',
      '/manuals/operating/variants/model=large/es',
      '/manuals/nope/variants/model=large/en',
    ]) {
      expect((await t.get(path)).status).toBe(404);
    }
  });

  it('renders the PDF with images and symbols, and caches it', async () => {
    const path = '/manuals/operating/variants/model=small/de/pdf';
    const res = await t.get(path).set('Accept', 'application/pdf').buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'inline; filename="operating-model=small-de.pdf"',
    );
    expect(res.headers['x-ccms-issues']).toBe('3');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const [a, b] = await Promise.all([
      t.get(path).buffer(true),
      t.get(path).buffer(true),
    ]);
    expect(a.body).toEqual(pdf);
    expect(b.body).toEqual(pdf);
  });
});

describe('assets', () => {
  it('serves images with a sniffed type and a locked-down policy', async () => {
    const res = await t.get(`/assets/${PNG_HASH}`).set('Accept', 'image/*');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect((await t.get(`/assets/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await t.get('/assets/nope')).status).toBe(400);
  });

  it('streams an image from the blob store with its stored type, never a redirect', async () => {
    const store = (contentType: string) =>
      t.blobs.put(Readable.from([PNG]), { contentType, maxBytes: 1_000_000 });
    try {
      // Stored with another type than Git's sniffed one: the store's wins.
      await store('image/webp');
      const res = await t.get(`/assets/${PNG_HASH}`).buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['content-length']).toBe(String(PNG.length));
      expect(res.headers['content-disposition']).toBe('inline');
      // A branch: revalidated (who may see it can change); a commit: immutable.
      expect(res.headers['cache-control']).toBe('private, no-cache');
      const pinned = await t.get(`/assets/${PNG_HASH}?ref=${t.commits.main}`);
      expect(pinned.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(res.headers['location']).toBeUndefined();
      expect(Buffer.from(res.body as Buffer)).toEqual(PNG);

      // A type that is no image is a download.
      await t.blobs.delete(PNG_HASH);
      await store('text/html');
      const html = await t.get(`/assets/${PNG_HASH}`);
      expect(html.headers['content-type']).toMatch(/^text\/html/);
      expect(html.headers['content-disposition']).toBe(
        `attachment; filename="${PNG_HASH}"; filename*=UTF-8''${PNG_HASH}`,
      );
    } finally {
      await t.blobs.delete(PNG_HASH);
    }
  });
});

describe('unknown routes', () => {
  it('answer 404 as a JSON:API error', async () => {
    const res = await t.get('/nope');
    expect(res.status).toBe(404);
    expect(error(res.body).code).toBe('not-found');
  });
});
