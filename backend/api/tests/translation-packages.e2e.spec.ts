import { execFileSync } from 'node:child_process';
import { parseModule } from '@openfolia/content-model';
import { cotiSchemaErrors, readCoti } from '@openfolia/xliff';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { TranslationImportDocument } from '../src/translations/api/translation-import.resources.js';
import { TranslationJobDocument } from '../src/translations/api/translation-job.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

// COTI packages (#140): a job leaves as a package for a translation management system and comes
// back as one, through the same XLIFF export (#50) and import (#51).

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const show = (ref: string, path: string) =>
  execFileSync('git', ['-C', dir(), 'show', `${ref}:${path}`], {
    encoding: 'utf8',
  });

const translator = () =>
  actorWith([
    'content.read',
    'content.read.draft',
    'content.edit',
    'translation.manage',
  ]);
const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

const binary = (path: string) =>
  t
    .get(path)
    .buffer(true)
    .parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });

const upload = (bytes: Uint8Array, fields: Record<string, string> = {}) => {
  let req = t
    .anonymous()
    .post('/translations/imports')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', JSON_API)
    .set(REQUEST_HEADER, '1');
  for (const [name, value] of Object.entries(fields))
    req = req.field(name, value);
  return req.attach('file', Buffer.from(bytes), 'package.coti');
};

async function exportCharging(languages: string[]) {
  const res = await t.post('/translations/exports').send({
    data: {
      type: 'TranslationJob',
      attributes: {
        languages,
        subject: { type: 'modules', moduleIds: ['charging'] },
        ref: 'main',
        dueDate: '2026-12-01',
      },
    },
  });
  expect(res.status).toBe(201);
  return TranslationJobDocument.parse(res.body).data;
}

/** A package's entries, by path. */
async function packageOf(jobId: string): Promise<Record<string, Uint8Array>> {
  const res = await binary(`/translations/exports/${jobId}/package`);
  expect(res.status).toBe(200);
  return unzipSync(new Uint8Array(res.body as Buffer));
}

/** Each `<source>` given a `<target>`, as a translator would write them (the codes kept). */
const TRANSLATIONS: Record<string, Record<string, string>> = {
  de: { intro: 'Das <ph id="1"/> lädt sich automatisch.' },
  fr: {
    intro: 'Le <ph id="1"/> se recharge automatiquement.',
    photo: 'Le chargeur',
  },
};
const translated = (xml: string, lang: string) =>
  xml.replace(/<unit id="([^"]+)"[\s\S]*?<\/unit>/g, (unit, id: string) =>
    unit.replace(
      /<source>(.*?)<\/source>/gs,
      (_, source: string) =>
        `<source>${source}</source><target>${TRANSLATIONS[lang]?.[id] ?? source}</target>`,
    ),
  );

/**
 * The shared fixture (#140): a package as a translation system returns it. The XLIFF translated,
 * `COTI.xml` with its own ID and the status set (all the standard lets it change), a reference
 * file added; folders and names as they were.
 */
function returned(entries: Record<string, Uint8Array>): {
  package: Uint8Array;
  xliff: Record<string, string>;
} {
  const out: Record<string, Uint8Array> = {};
  const xliff: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(entries)) {
    const text = strFromU8(bytes);
    if (path.endsWith('/COTI.xml')) {
      out[path] = strToU8(
        text
          .replace('status="none"', 'status="final"')
          .replace('proposal="no"', 'proposal="no" tms-id="TMS-1"'),
      );
      const folder = path.slice(0, path.lastIndexOf('/'));
      out[`${folder}/reference files/notes.txt`] = strToU8('Context.');
    } else {
      const lang = /trgLang="([^"]+)"/.exec(text)?.[1] as string;
      xliff[lang] = translated(text, lang);
      out[path] = strToU8(xliff[lang]);
    }
  }
  return { package: zipSync(out), xliff };
}

beforeAll(async () => {
  t = await createTestApp({ CCMS_MAX_UPLOAD_BYTES: String(64 * 1024) });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('a job as a COTI package, there and back', () => {
  let jobId: string;
  let entries: Record<string, Uint8Array>;

  it('downloads as a package: one project per language, each COTI.xml valid, the XLIFF the job file’s', async () => {
    t.actAs(translator());
    const job = await exportCharging(['de', 'fr']);
    jobId = job.id;
    const res = await binary(`/translations/exports/${jobId}/package`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(
        `^attachment; filename="\\d{4}-\\d\\d-\\d\\dT\\d{6}Z_translation-${jobId}\\.coti"$`,
      ),
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    entries = unzipSync(new Uint8Array(res.body as Buffer));
    const de = `${jobId}-de_en-US_de-DE`;
    const fr = `${jobId}-fr_en-US_fr-FR`;
    expect(Object.keys(entries).sort()).toEqual([
      `${de}/COTI.xml`,
      `${de}/translation files/translation-${jobId}-de.xlf`,
      `${fr}/COTI.xml`,
      `${fr}/translation files/translation-${jobId}-fr.xlf`,
    ]);
    for (const folder of [de, fr]) {
      const xml = strFromU8(entries[`${folder}/COTI.xml`] as Uint8Array);
      expect(cotiSchemaErrors(xml)).toEqual([]);
      expect(readCoti(xml)).toMatchObject({
        level: '1',
        packageId: jobId,
        status: 'none',
        meta: { job: jobId, ref: 'main', commit: job.attributes.commit },
      });
      expect(xml).toContain('due-date="2026-12-01T00:00:00Z"');
    }
    // The XLIFF is exactly the job file's.
    const files = unzipSync(
      new Uint8Array(
        (await binary(`/translations/exports/${jobId}/file`)).body as Buffer,
      ),
    );
    for (const lang of ['de', 'fr']) {
      const folder = lang === 'de' ? de : fr;
      expect(
        strFromU8(
          entries[
            `${folder}/translation files/translation-${jobId}-${lang}.xlf`
          ] as Uint8Array,
        ),
      ).toBe(
        strFromU8(files[`translation-${jobId}-${lang}.xlf`] as Uint8Array),
      );
    }
  });

  it('comes back and is checked exactly as its XLIFF would be', async () => {
    t.actAs(translator());
    const back = returned(entries);
    const plain = await upload(
      zipSync({
        'de.xlf': strToU8(back.xliff['de'] as string),
        'fr.xlf': strToU8(back.xliff['fr'] as string),
      }),
    );
    expect(plain.status).toBe(201);
    const fromPackage = await upload(back.package);
    expect(fromPackage.status).toBe(201);
    const a = TranslationImportDocument.parse(plain.body).data;
    const b = TranslationImportDocument.parse(fromPackage.body).data;
    expect(b.relationships.job.data?.id).toBe(jobId);
    expect(b.attributes.languages).toEqual(a.attributes.languages);
    expect(b.meta.counts).toEqual(a.meta.counts);
    expect(b.meta.report).toEqual(a.meta.report);
    expect(b.meta.counts).toMatchObject({ units: 3, ok: 3 });

    // Applied: one change set with the translations, and the job returned.
    const applied = await t.post(`/translations/imports/${b.id}/apply`);
    expect(applied.status).toBe(200);
    const doc = TranslationImportDocument.parse(applied.body);
    const branch = `change-sets/${doc.data.relationships.changeSet.data?.id}`;
    const fr = parseModule(show(branch, 'modules/fr/charging.adoc'), {
      id: 'charging',
    });
    expect(fr.blocks.find((x) => x.id === 'photo')).toMatchObject({
      alt: 'Le chargeur',
    });
    const job = await t.get(`/translations/exports/${jobId}`);
    expect(TranslationJobDocument.parse(job.body).data.attributes.state).toBe(
      'returned',
    );
  });

  it('refuses a package of an unknown job, of a cancelled one, or of another job than its XLIFF', async () => {
    t.actAs(translator());
    const job = await exportCharging(['fr']);
    const fresh = await packageOf(job.id);
    const swap = (from: string, to: string, stripJob = false) =>
      zipSync(
        Object.fromEntries(
          Object.entries(fresh).map(([path, bytes]) => {
            let text = strFromU8(bytes);
            if (path.endsWith('/COTI.xml')) text = text.replaceAll(from, to);
            else if (stripJob) text = text.replace(/ ccms:job="[^"]+"/, '');
            return [path, strToU8(text)];
          }),
        ),
      );
    const unknown = await upload(
      swap(`="${job.id}"`, '="00000000-0000-7000-8000-000000000000"', true),
    );
    expect(unknown.status).toBe(404);
    expect(error(unknown.body)?.code).toBe('unknown-job');
    const mismatch = await upload(
      swap(`="${job.id}"`, '="00000000-0000-7000-8000-000000000000"'),
    );
    expect(mismatch.status).toBe(422);
    expect(error(mismatch.body)?.code).toBe('coti-job-mismatch');
    // A source tag that is none: refused like any other mismatch, never a crash.
    const badTag = await upload(
      zipSync(
        Object.fromEntries(
          Object.entries(fresh).map(([path, bytes]) => [
            path,
            path.endsWith('.xlf')
              ? strToU8(
                  strFromU8(bytes).replace('srcLang="en"', 'srcLang="en us"'),
                )
              : bytes,
          ]),
        ),
      ),
    );
    expect(badTag.status).toBe(422);
    expect(error(badTag.body)?.code).toBe('language-mismatch');
    const languages = await upload(
      swap('target-language="fr-FR"', 'target-language="fr-CA"'),
    );
    expect(languages.status).toBe(422);
    expect(error(languages.body)?.code).toBe('language-mismatch');

    expect(
      (await t.post(`/translations/exports/${job.id}/cancel`)).status,
    ).toBe(200);
    const cancelled = await upload(zipSync(fresh));
    expect(cancelled.status).toBe(409);
    expect(error(cancelled.body)?.code).toBe('job-not-open');
    const download = await t.get(`/translations/exports/${job.id}/package`);
    expect(download.status).toBe(409);
    expect(error(download.body)?.code).toBe('job-not-open');
  });
});

describe('an unsafe package', () => {
  const project = 'p_en-US_fr-FR';
  const description = (fileRef: string, prolog = '') =>
    `${prolog}<coti xmlns="http://www.dercom.de/COTI/2013/1.0/namespace" version="1.1" level="1" creator="x" creation-date="2026-01-01T00:00:00Z" package-id="00000000-0000-7000-8000-000000000000"><project name="p" project-id="p" checkout-date="2026-01-01T00:00:00Z" proposal="no"><translation name="t" source-language="en-US" target-language="fr-FR"><translation-file file-ref="${fileRef}" mime-type="application/xliff+xml"/></translation></project></coti>`;
  /** A ZIP with entries as given, names unchecked (fflate writes what it is handed). */
  const zipOf = (entries: Record<string, string | Uint8Array>) =>
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([p, v]) => [
          p,
          typeof v === 'string' ? strToU8(v) : v,
        ]),
      ),
    );

  it('is refused before anything is looked up, with a stable code', async () => {
    t.actAs(translator());
    const cases: [Uint8Array, string, string?][] = [
      // Zip slip: an entry leaving its folder.
      [
        zipOf({ '../evil/COTI.xml': description('a.xlf') }),
        'invalid-archive',
        'unsafe-path',
      ],
      // A bomb: unpacks far past the upload limit.
      [
        zipOf({
          [`${project}/COTI.xml`]: description('a.xlf'),
          [`${project}/translation files/big.xlf`]: new Uint8Array(
            8 * 1024 * 1024,
          ),
        }),
        'invalid-archive',
        'too-large',
      ],
      // A file reference leaving the project's folder.
      [
        zipOf({
          [`${project}/COTI.xml`]: description('../../outside.xlf'),
          'outside.xlf': '<xliff/>',
        }),
        'invalid-coti',
        'invalid-coti',
      ],
      // Entity expansion and external entities: no DTD is read at all.
      [
        zipOf({
          [`${project}/COTI.xml`]: description(
            '&x;',
            '<!DOCTYPE coti [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
          ),
        }),
        'invalid-coti',
        'dtd-forbidden',
      ],
      // Another encoding.
      [
        zipOf({
          [`${project}/COTI.xml`]: description(
            'a.xlf',
            '<?xml version="1.0" encoding="ISO-8859-1"?>',
          ),
        }),
        'invalid-coti',
        'unsupported-encoding',
      ],
      // A listed file the package does not hold.
      [
        zipOf({
          [`${project}/COTI.xml`]: description('translation files/a.xlf'),
        }),
        'invalid-coti',
        'missing-file',
      ],
    ];
    for (const [bytes, code, reason] of cases) {
      const res = await upload(bytes);
      expect([code, res.status]).toEqual([code, 422]);
      const refused = error(res.body);
      expect(refused?.code).toBe(code);
      if (reason) expect(refused?.meta?.['reason']).toBe(reason);
    }
  });

  it('is a 400 for a query parameter the package route does not take, and 404 for no job', async () => {
    t.actAs(translator());
    const query = await t.get(
      '/translations/exports/00000000-0000-7000-8000-000000000000/package?lang=de',
    );
    expect(query.status).toBe(400);
    expect(error(query.body)?.code).toBe('unsupported-parameter');
    const missing = await t.get(
      '/translations/exports/00000000-0000-7000-8000-000000000000/package',
    );
    expect(missing.status).toBe(404);
    expect(error(missing.body)?.code).toBe('not-found');
  });
});
