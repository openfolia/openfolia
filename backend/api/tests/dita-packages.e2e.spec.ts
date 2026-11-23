import { ProjectConfig } from '@openfolia/content-model';
import type { z } from 'zod';
import { convertDita } from '@openfolia/dita';
import { unzipSync } from 'fflate';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  DitaPackageDocument,
  DitaPackagePageDocument,
} from '../src/dita/api/dita-package.resources.js';
import { ProjectConfigDocument } from '../src/project/api/project.resources.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Plans the release's outputs first: slower than most.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
const publicReader = user('public-reader', ['content.read'], {
  maxAudience: 'public',
});
const conceptsOnly = user('concepts-only', ['content.read'], {
  moduleTypes: ['concept'],
});

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

const download = (path: string, as: Actor = READER) => {
  t.actAs(as);
  return t
    .get(path)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        done(
          null,
          res.headers['content-type'] === 'application/zip'
            ? body
            : JSON.parse(body.toString('utf8')),
        );
      });
    });
};

const list = async (releaseId: string, as: Actor = READER, query = '') => {
  t.actAs(as);
  return t.get(`/releases/${releaseId}/dita-packages${query}`);
};

describe('DITA packages (#433)', () => {
  let release: z.infer<typeof ReleaseDocument>['data'];

  beforeAll(async () => {
    t.actAs(publisher);
    const res = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '1.0' },
        },
      }),
    );
    expect(res.status).toBe(201);
    release = ReleaseDocument.parse(res.body).data;
    t.actAs(undefined);
    await t.runJobs();
  });

  const small = async () => {
    const page = DitaPackagePageDocument.parse((await list(release.id)).body);
    const found = page.data.find(
      (p) =>
        p.attributes.manual === 'operating' &&
        p.attributes.variant === 'model=small' &&
        p.attributes.lang === 'en',
    );
    if (!found) throw new Error('no package');
    return found;
  };

  it('lists one package per output the reader may read, paged', async () => {
    const res = await list(release.id);
    expect(res.status).toBe(200);
    const page = DitaPackagePageDocument.parse(res.body);
    expect(page.meta.page.total).toBe(page.data.length);
    expect((await small()).attributes.fileName).toBe(
      'operating_model-small_en_1.0-dita.zip',
    );
    const pub = DitaPackagePageDocument.parse(
      (await list(release.id, publicReader)).body,
    );
    expect(pub.data.some((p) => p.attributes.manual === 'service')).toBe(false);
    expect(
      DitaPackagePageDocument.parse((await list(release.id, conceptsOnly)).body)
        .data,
    ).toEqual([]);
    const one = DitaPackagePageDocument.parse(
      (await list(release.id, READER, '?filter[manual]=service&page[size]=1'))
        .body,
    );
    expect(one.data.map((p) => p.attributes.manual)).toEqual(['service']);
    expect((await list(release.id, READER, '?filter[nope]=1')).status).toBe(
      400,
    );
  });

  it('makes a package that imports again as the release’s content, the same bytes each time', async () => {
    const pkg = await small();
    t.actAs(READER);
    const described = await t.get(pkg.links.self);
    expect(described.status).toBe(200);
    const doc = DitaPackageDocument.parse(described.body).data;
    expect(doc.meta.languages).toEqual(['en']);
    expect(doc.meta.references).toBe('conref');
    expect(doc.meta.topics).toBeGreaterThan(0);

    const res = await download(pkg.links.file);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(
      'operating_model-small_en_1.0-dita.zip',
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(res.headers['x-ccms-dita-warnings'])).toBe(
      doc.meta.warnings.length,
    );
    const bytes = res.body as Buffer;
    expect(bytes.length).toBe(doc.meta.size);
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    expect(names).toContain('en/operating.ditamap');
    expect(names).toContain('filters/model-small.ditaval');
    expect(names.some((n) => /^images\/[0-9a-f]{64}\.png$/.test(n))).toBe(true);
    // The internal module stays out of a public manual's package.
    expect(names).not.toContain('en/internals.dita');
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
      expect(name.split('/')).not.toContain('..');
    }

    // Importing it again gives the manual, in its variant.
    t.actAs(READER);
    const config = ProjectConfig.parse(
      ProjectConfigDocument.parse((await t.get('/config')).body).data
        .attributes,
    );
    const again = await convertDita(new Map(Object.entries(files)), config);
    expect(again.document.manuals.map((m) => [m.id, m.variants])).toEqual([
      ['operating', [{ model: 'small' }]],
    ]);
    expect(again.document.modules.length).toBe(doc.meta.topics);

    const second = await download(pkg.links.file);
    expect(Buffer.compare(second.body as Buffer, bytes)).toBe(0);
  });

  it('takes the languages and how references are written as options', async () => {
    const pkg = await small();
    t.actAs(READER);
    const all = DitaPackageDocument.parse(
      (await t.get(`${pkg.links.self}?languages=all&references=resolved`)).body,
    ).data;
    expect(all.meta.languages.length).toBeGreaterThan(1);
    expect(all.meta.references).toBe('resolved');
    expect(all.attributes.fileName).toBe(
      'operating_model-small_all_1.0-dita.zip',
    );
    expect(all.links.file).toBe(
      `${pkg.links.file}?languages=all&references=resolved`,
    );
    const res = await download(all.links.file);
    expect(res.status).toBe(200);
    const names = Object.keys(unzipSync(res.body as Buffer));
    for (const lang of all.meta.languages) {
      expect(names).toContain(`${lang}/operating.ditamap`);
    }

    for (const query of ['?languages=some', '?references=inline']) {
      const bad = await t.get(`${pkg.links.self}${query}`);
      expect(bad.status).toBe(400);
      expect(codeOf(bad.body)).toBe('invalid-parameter');
      const badFile = await download(`${pkg.links.file}${query}`);
      expect(badFile.status).toBe(400);
    }
    const other = await download(`${pkg.links.file}?nope=1`);
    expect(other.status).toBe(400);
    expect(codeOf(other.body)).toBe('unsupported-parameter');
  });

  it('is 404 for a reader who may not read the output', async () => {
    const pkg = await small();
    const res = await download(pkg.links.file, conceptsOnly);
    expect(res.status).toBe(404);
    t.actAs(conceptsOnly);
    expect((await t.get(pkg.links.self)).status).toBe(404);
    t.actAs(READER);
    expect(
      (
        await t.get(
          `/releases/${release.id}/dita-packages/00000000-0000-7000-8000-000000000000`,
        )
      ).status,
    ).toBe(404);
  });
});
