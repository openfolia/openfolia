import { execFileSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import { GitWriter } from '@openfolia/content-repo';
import { unzipSync } from 'fflate';
import JSZip from 'jszip';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  PACKAGE_SENDS_AT_ONCE,
  type PackageSends,
} from '../src/base/core/package-sends.js';
import { DitaSends } from '../src/dita/core/actions/dita-packages.action.js';
import { IirdsSends } from '../src/iirds/core/actions/iirds-packages.action.js';
import {
  IirdsPackageDocument,
  IirdsPackagePageDocument,
} from '../src/iirds/api/iirds-package.resources.js';
import { ProjectConfigDocument } from '../src/project/api/project.resources.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { schemaProblems } from './iirds/iirds-schema.js';
import { validateIirdsPackage } from './iirds/official-validator.js';
import { createTestApp, type TestApp } from './test-app.js';

// Renders the release's PDFs first: slower than most.
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
/** Leaves a module type out: sees no manual whole, so no package. */
const conceptsOnly = user('concepts-only', ['content.read'], {
  moduleTypes: ['concept'],
});

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const cut = async (revision: string) => {
  // Tags are ordered by their date, to the second.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: { type: 'Release', attributes: { product: 'north', revision } },
    }),
  );
  expect(res.status).toBe(201);
  return ReleaseDocument.parse(res.body).data;
};

/** The mapping on main, and the safety note (its symbol) in the operating manual. */
const MAPPING = `iirds:
  baseIri: https://docs.example.com/iirds/
  documentTypes: [OperatingInstructions]
  manualDocumentTypes:
    service: [MaintenanceInstructions]
  moduleTypes:
    concept: { topicType: GenericConcept, subjects: [SafetyInstruction] }
    procedure: GenericTask
  audiences:
    public: Role
  facets:
    region: ProductVariant
  variantAttributes:
    model: ProductVariant
`;
const addMapping = async () => {
  const manual = git('show', 'main:manuals/operating.yaml');
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'openfolia.yaml',
        content: `${git('show', 'main:openfolia.yaml')}\n${MAPPING}`,
      },
      {
        path: 'manuals/operating.yaml',
        content: manual.replace(
          '  - module: charging\n',
          '  - module: charging\n  - module: safety-note\n',
        ),
      },
    ],
    message: 'Map the content to iiRDS',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
};

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

/** A package's file, its body as bytes whatever its type (a JSON:API error stays JSON). */
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
          res.headers['content-type'] === 'application/iirds+zip'
            ? body
            : JSON.parse(body.toString('utf8')),
        );
      });
    });
};

const list = async (releaseId: string, as: Actor = READER, query = '') => {
  t.actAs(as);
  return t.get(`/releases/${releaseId}/iirds-packages${query}`);
};

describe('iiRDS packages (#431)', () => {
  let unmapped: Awaited<ReturnType<typeof cut>>;
  let release: Awaited<ReturnType<typeof cut>>;

  beforeAll(async () => {
    unmapped = await cut('1.0');
    await addMapping();
    release = await cut('2.0');
    t.actAs(undefined);
    await t.runJobs();
  });

  it('refuses a release whose configuration holds no mapping', async () => {
    const res = await list(unmapped.id);
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('iirds-not-configured');
  });

  it('lists one package per output the reader may read, paged', async () => {
    const res = await list(release.id);
    expect(res.status).toBe(200);
    const page = IirdsPackagePageDocument.parse(res.body);
    expect(
      page.data.map(
        (p) =>
          `${p.attributes.manual}/${p.attributes.variant}/${p.attributes.lang}`,
      ),
    ).toContain('operating/model=small/en');
    expect(page.data.some((p) => p.attributes.manual === 'service')).toBe(true);
    expect(page.meta.page.total).toBe(page.data.length);
    const small = page.data.find(
      (p) =>
        p.attributes.manual === 'operating' &&
        p.attributes.variant === 'model=small' &&
        p.attributes.lang === 'en',
    );
    expect(small?.attributes).toMatchObject({
      fileName: 'operating_model-small_en_2.0.iirds',
      pdf: true,
    });
    // A public reader sees no internal manual's package; a role leaving a module type out sees none.
    const pub = IirdsPackagePageDocument.parse(
      (await list(release.id, publicReader)).body,
    );
    expect(pub.data.some((p) => p.attributes.manual === 'service')).toBe(false);
    expect(
      IirdsPackagePageDocument.parse(
        (await list(release.id, conceptsOnly)).body,
      ).data,
    ).toEqual([]);
    // Filtered and paged.
    const one = IirdsPackagePageDocument.parse(
      (await list(release.id, READER, '?filter[manual]=service&page[size]=1'))
        .body,
    );
    expect(one.data.map((p) => p.attributes.manual)).toEqual(['service']);
    expect((await list(release.id, READER, '?filter[nope]=1')).status).toBe(
      400,
    );
  });

  it('makes a package the official validator and the schema accept, the same bytes each time', async () => {
    const page = IirdsPackagePageDocument.parse((await list(release.id)).body);
    const small = page.data.find(
      (p) =>
        p.attributes.manual === 'operating' &&
        p.attributes.variant === 'model=small' &&
        p.attributes.lang === 'en',
    );
    if (!small) throw new Error('no package');
    t.actAs(READER);
    const described = await t.get(small.links.self);
    expect(described.status).toBe(200);
    const doc = IirdsPackageDocument.parse(described.body).data;
    // Everything a public manual holds is mapped (the `internal` audience is not, but it holds none of it).
    expect(doc.meta.warnings).toEqual([]);
    expect(doc.meta.topics).toBe(2);
    expect(doc.meta.media).toBeGreaterThanOrEqual(2);

    const res = await download(small.links.file);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/iirds+zip');
    expect(res.headers['content-disposition']).toContain(
      'operating_model-small_en_2.0.iirds',
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const bytes = res.body as Buffer;
    expect(bytes.length).toBe(doc.meta.size);
    expect(Number(res.headers['content-length'])).toBe(doc.meta.size);

    // `mimetype` first and stored, with the media type and no line break.
    expect(bytes.subarray(30, 38).toString('latin1')).toBe('mimetype');
    expect(bytes.readUInt16LE(8)).toBe(0);
    const files = unzipSync(bytes);
    expect(Buffer.from(files['mimetype'] as Uint8Array).toString()).toBe(
      'application/iirds+zip',
    );
    const names = Object.keys(files);
    expect(names[0]).toBe('mimetype');
    expect(names).toEqual(
      expect.arrayContaining([
        'META-INF/metadata.rdf',
        'content/charging.html',
        'content/safety-note.html',
        'symbols/w001.svg',
        'pdf/operating_model-small_en_2.0.pdf',
      ]),
    );
    expect(names.some((n) => /^media\/[0-9a-f]{64}\.png$/.test(n))).toBe(true);
    // The internal module stays out of a public manual's package.
    expect(names).not.toContain('content/internals.html');
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(260);
      expect(name).not.toMatch(/[\\,"*:<>]|\.\.|^\//);
    }
    const html = Buffer.from(
      files['content/charging.html'] as Uint8Array,
    ).toString();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toMatch(/src="\.\.\/media\/[0-9a-f]{64}\.png"/);

    const rdf = Buffer.from(
      files['META-INF/metadata.rdf'] as Uint8Array,
    ).toString();
    expect(schemaProblems(rdf)).toEqual([]);
    expect(rdf).toContain('iirds#OperatingInstructions');
    expect(rdf).toContain('https://docs.example.com/iirds/facets/region/north');
    expect(rdf).toContain(
      'https://docs.example.com/iirds/variant-attributes/model/small',
    );

    const result = await validateIirdsPackage(
      bytes,
      'operating_model-small_en_2.0.iirds',
    );
    expect(result.iirdsVersion).toBe('1.3');
    expect(result.checked).toBeGreaterThan(50);
    expect(result.violations.filter((v) => v.prio === 'MUST')).toEqual([]);
    // Readable by a common ZIP reader too.
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toContain('META-INF/metadata.rdf');

    const again = await download(small.links.file);
    expect(Buffer.compare(again.body as Buffer, bytes)).toBe(0);
  });

  it('maps the manual’s own document types, and warns of what it cannot map', async () => {
    const page = IirdsPackagePageDocument.parse(
      (await list(release.id, READER, '?filter[manual]=service')).body,
    );
    const service = page.data[0];
    if (!service) throw new Error('no package');
    t.actAs(READER);
    const doc = IirdsPackageDocument.parse(
      (await t.get(service.links.self)).body,
    ).data;
    expect(doc.meta.warnings.map((w) => `${w.code} ${w.id}`)).toEqual(
      expect.arrayContaining(['unmapped-audience internal']),
    );
    const res = await download(service.links.file);
    expect(res.status).toBe(200);
    expect(Number(res.headers['x-ccms-iirds-warnings'])).toBe(
      doc.meta.warnings.length,
    );
    const files = unzipSync(res.body as Buffer);
    const rdf = Buffer.from(
      files['META-INF/metadata.rdf'] as Uint8Array,
    ).toString();
    expect(rdf).toContain('iirds#MaintenanceInstructions');
    expect(rdf).not.toContain('iirds#OperatingInstructions');
    expect(schemaProblems(rdf)).toEqual([]);
    const result = await validateIirdsPackage(
      res.body as Buffer,
      service.attributes.fileName,
    );
    expect(result.violations.filter((v) => v.prio === 'MUST')).toEqual([]);
  });

  it('answers 404 for a package the reader may not read, exactly like a missing one', async () => {
    const page = IirdsPackagePageDocument.parse(
      (await list(release.id, READER, '?filter[manual]=service')).body,
    );
    const service = page.data[0];
    if (!service) throw new Error('no package');
    for (const path of [service.links.self, service.links.file]) {
      t.actAs(publicReader);
      const res = await t.get(path);
      expect(res.status).toBe(404);
      expect(codeOf(res.body)).toBe('not-found');
    }
    t.actAs(READER);
    const missing = await t.get(
      `/releases/${release.id}/iirds-packages/00000000-0000-4000-8000-000000000000`,
    );
    expect(missing.status).toBe(404);
    // A package of another release is not this one's.
    const other = await t.get(
      `/releases/${unmapped.id}/iirds-packages/${service.id}`,
    );
    expect(other.status).not.toBe(200);
  });

  it('checks the mapping in the configuration, for the admin', async () => {
    t.actAs(READER);
    const res = await t.get('/config?ref=main');
    expect(res.status).toBe(200);
    expect(
      ProjectConfigDocument.parse(res.body).data.meta?.iirdsIssues?.map(
        (i) => `${i.code} ${i.path}`,
      ),
    ).toEqual(['unmapped-audience audiences.internal']);
    const before = await t.get(
      `/config?ref=${encodeURIComponent(unmapped.attributes.tag)}`,
    );
    expect(ProjectConfigDocument.parse(before.body).data.meta).toBeUndefined();
  });

  it('delivers every package the list shows, an empty manual’s as its document alone (#551)', async () => {
    // A public manual whose one module is internal: its audience reads none of it.
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        {
          path: 'manuals/hollow.yaml',
          content:
            'schemaVersion: 1\ntitle: Hollow manual\naudience: public\nvariants:\n  - model: small\nentries:\n  - module: internals\n',
        },
      ],
      message: 'Add a manual its audience reads nothing of',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    const third = await cut('3.0');
    t.actAs(undefined);
    await t.runJobs();
    const page = IirdsPackagePageDocument.parse(
      (await list(third.id, READER, '?page[size]=100')).body,
    );
    expect(page.meta.page.total).toBe(page.data.length);
    expect(page.data.map((p) => p.attributes.manual)).toContain('hollow');
    for (const listed of page.data) {
      t.actAs(READER);
      const described = await t.get(listed.links.self);
      expect(described.status).toBe(200);
      const res = await download(listed.links.file);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/iirds+zip');
    }
    const hollow = page.data.find((p) => p.attributes.manual === 'hollow');
    t.actAs(READER);
    const doc = IirdsPackageDocument.parse(
      (await t.get(hollow?.links.self as string)).body,
    ).data;
    expect(doc.meta.topics).toBe(0);
    expect(doc.meta.warnings.map((w) => w.code)).toContain('manual-empty');
    const bytes = (await download(hollow?.links.file as string)).body as Buffer;
    const files = unzipSync(bytes);
    expect(Object.keys(files).some((n) => n.startsWith('content/'))).toBe(
      false,
    );
    const rdf = Buffer.from(
      files['META-INF/metadata.rdf'] as Uint8Array,
    ).toString();
    expect(schemaProblems(rdf)).toEqual([]);
    expect(rdf).toContain('<iirds:Document ');
    expect(rdf).not.toContain('<iirds:DirectoryNode ');
    const result = await validateIirdsPackage(
      bytes,
      'hollow_model-small_en_3.0.iirds',
    );
    expect(result.violations.filter((v) => v.prio === 'MUST')).toEqual([]);
  });

  it('takes no query parameter on the file', async () => {
    const page = IirdsPackagePageDocument.parse((await list(release.id)).body);
    const first = page.data[0];
    if (!first) throw new Error('no package');
    const res = await download(`${first.links.file}?download=1`);
    expect(res.status).toBe(400);
  });

  describe('bounds the sends (#654)', () => {
    /** A body that would go on for ever, holding its turn. */
    async function* endless(): AsyncIterable<Uint8Array> {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield new Uint8Array(16);
      }
    }
    const held: Readable[] = [];
    afterEach(() => {
      for (const body of held.splice(0)) body.destroy();
    });
    const hold = (sends: PackageSends, as: Actor) => {
      const body = sends.send(as, endless());
      body.on('error', () => undefined);
      held.push(body);
    };
    const firstFile = async () => {
      const page = IirdsPackagePageDocument.parse(
        (await list(release.id)).body,
      );
      const first = page.data[0];
      if (!first) throw new Error('no package');
      return first.links.file;
    };
    /** A 429 `rate-limited` with none of the file's headers set. */
    const refusedBeforeHeaders = (
      res: Awaited<ReturnType<typeof download>>,
    ) => {
      expect(res.status).toBe(429);
      expect(codeOf(res.body)).toBe('rate-limited');
      expect(res.headers['content-type']).toContain('application/vnd.api+json');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['x-ccms-iirds-warnings']).toBeUndefined();
    };

    it('answers 429 to a reader past their share, before any header of the file', async () => {
      const file = await firstFile();
      hold(t.app.get(IirdsSends), READER);
      refusedBeforeHeaders(await download(file));
      // Another reader still gets theirs.
      const other = await download(file, publisher);
      expect(other.status).toBe(200);
    });

    it('answers 429 once every turn is taken, whoever asks', async () => {
      const file = await firstFile();
      const sends = t.app.get(IirdsSends);
      for (let n = 0; n < PACKAGE_SENDS_AT_ONCE; n++) {
        hold(sends, user(`holder-${n}`, ['content.read']));
      }
      refusedBeforeHeaders(await download(file));
    });

    it('keeps its turns apart from the DITA packages’', async () => {
      const file = await firstFile();
      const dita = t.app.get(DitaSends);
      for (let n = 0; n < PACKAGE_SENDS_AT_ONCE; n++) {
        hold(dita, user(`dita-holder-${n}`, ['content.read']));
      }
      const res = await download(file);
      expect(res.status).toBe(200);
    });

    it('frees the turn of a download once it ends', async () => {
      const file = await firstFile();
      expect((await download(file)).status).toBe(200);
      expect((await download(file)).status).toBe(200);
    });
  });
});
