import { COTI_NAMESPACE, cotiSchemaErrors, readCoti } from '@openfolia/xliff';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import type { TranslationJob } from '../core/translation-job.js';
import { CotiPackageExchange } from './coti-package-exchange.js';

const JOB: TranslationJob = {
  id: '01938a2e-7d3c-7b11-8a00-000000000001',
  sourceLang: 'en',
  languages: ['de', 'pt-BR'],
  subject: { type: 'manual', manualId: 'operating-manual' },
  ref: 'main',
  commit: 'c'.repeat(40),
  released: true,
  dueDate: '2026-12-01',
  state: 'sent',
  createdBy: { kind: 'user', id: 'someone' },
  createdAt: new Date('2026-11-20T09:00:00.500Z'),
  counts: { modules: 1, units: 2, words: 4 },
  perLanguage: [],
};
const AT = new Date('2026-11-20T09:30:15Z');
const XLIFF = (lang: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="2.0" srcLang="en" trgLang="${lang}"/>`;
const FILES = [
  { lang: 'de', xliff: XLIFF('de') },
  { lang: 'pt-BR', xliff: XLIFF('pt-BR') },
];

const exchange = new CotiPackageExchange();
const unzipped = (bytes: Uint8Array) =>
  new Map(Object.entries(unzipSync(bytes)));
const files = (entries: Record<string, string | Uint8Array>) =>
  new Map(
    Object.entries(entries).map(([path, v]) => [
      path,
      typeof v === 'string' ? strToU8(v) : v,
    ]),
  );

const DE = `${JOB.id}-de_en-US_de-DE`;
const coti = (translation: string, root = `package-id="${JOB.id}"`) =>
  `<coti xmlns="${COTI_NAMESPACE}" version="1.1" level="1" creator="x" creation-date="2026-01-01T00:00:00Z" ${root}><project name="p" project-id="${JOB.id}-de" checkout-date="2026-01-01T00:00:00Z" proposal="no"><translation name="t" source-language="en-US" target-language="de-DE">${translation}</translation></project></coti>`;
const listing = (ref: string, mime = 'application/xliff+xml') =>
  `<translation-file file-ref="${ref}" mime-type="${mime}"/>`;

describe('CotiPackageExchange.pack', () => {
  const made = exchange.pack(JOB, FILES, AT);
  const entries = unzipped(made.bytes);

  it('names the package by its time and the job', () => {
    expect(made.fileName).toBe(`2026-11-20T093015Z_translation-${JOB.id}.coti`);
    expect(made.mediaType).toBe('application/zip');
  });

  it('holds one project per target language: its COTI.xml and the job’s XLIFF', () => {
    expect([...entries.keys()].sort()).toEqual([
      `${DE}/COTI.xml`,
      `${DE}/translation files/translation-${JOB.id}-de.xlf`,
      `${JOB.id}-pt-BR_en-US_pt-BR/COTI.xml`,
      `${JOB.id}-pt-BR_en-US_pt-BR/translation files/translation-${JOB.id}-pt-BR.xlf`,
    ]);
    expect(
      strFromU8(
        entries.get(`${DE}/translation files/translation-${JOB.id}-de.xlf`)!,
      ),
    ).toBe(XLIFF('de'));
  });

  it('describes each project as the standard’s schema takes it, from the job', () => {
    const xml = strFromU8(entries.get(`${DE}/COTI.xml`)!);
    expect(cotiSchemaErrors(xml)).toEqual([]);
    expect(readCoti(xml)).toMatchObject({
      level: '1',
      version: '1.1',
      packageId: JOB.id,
      projectId: `${JOB.id}-de`,
      sourceLanguage: 'en-US',
      targetLanguage: 'de-DE',
      status: 'none',
      meta: { job: JOB.id, ref: 'main', commit: JOB.commit },
      files: [
        {
          fileRef: `translation files/translation-${JOB.id}-de.xlf`,
          mimeType: 'application/xliff+xml',
        },
      ],
    });
    expect(xml).toContain('checkout-date="2026-11-20T09:00:00Z"');
    expect(xml).toContain('due-date="2026-12-01T00:00:00Z"');
    expect(xml).toContain('creation-date="2026-11-20T09:30:15Z"');
    expect(xml).toContain('<subject>Manual operating-manual</subject>');
  });

  it('leaves the due date out of a job without one', () => {
    const xml = strFromU8(
      unzipped(exchange.pack({ ...JOB, dueDate: null }, FILES, AT).bytes).get(
        `${DE}/COTI.xml`,
      )!,
    );
    expect(xml).not.toContain('due-date');
    expect(cotiSchemaErrors(xml)).toEqual([]);
  });

  it('reads back what it packed', () => {
    expect(exchange.unpack(entries)).toEqual([
      {
        path: `${DE}/translation files/translation-${JOB.id}-de.xlf`,
        bytes: strToU8(XLIFF('de')),
        envelope: {
          jobId: JOB.id,
          sourceLanguage: 'en-US',
          targetLanguage: 'de-DE',
        },
      },
      {
        path: `${JOB.id}-pt-BR_en-US_pt-BR/translation files/translation-${JOB.id}-pt-BR.xlf`,
        bytes: strToU8(XLIFF('pt-BR')),
        envelope: {
          jobId: JOB.id,
          sourceLanguage: 'en-US',
          targetLanguage: 'pt-BR',
        },
      },
    ]);
  });
});

describe('CotiPackageExchange.unpack', () => {
  const refusal = (entries: Map<string, Uint8Array>) => {
    try {
      exchange.unpack(entries);
    } catch (error) {
      return error as { code: string; meta: { reason: string; path?: string } };
    }
    throw new Error('not refused');
  };

  it('is no package without a COTI.xml at a project’s top', () => {
    expect(exchange.unpack(files({ 'de.xlf': XLIFF('de') }))).toBeUndefined();
    expect(
      exchange.unpack(files({ 'a/b/COTI.xml': coti(listing('x.xlf')) })),
    ).toBeUndefined();
  });

  it('reads only the files a description lists; reference files and the rest are left alone', () => {
    const read = exchange.unpack(
      files({
        [`${DE}/COTI.xml`]: coti(
          `${listing('translation files/de.xlf')}<reference-file file-ref="reference files/a.pdf" mime-type="application/pdf" external="no" type="other"/>`,
        ),
        [`${DE}/translation files/de.xlf`]: XLIFF('de'),
        [`${DE}/translation files/other.xlf`]: XLIFF('de'),
        [`${DE}/reference files/a.pdf`]: '%PDF',
        'stray.xlf': XLIFF('fr'),
      }),
    );
    expect(read?.map((d) => d.path)).toEqual([
      `${DE}/translation files/de.xlf`,
    ]);
  });

  it('takes a project at the package’s top, and the job from a meta entry without a package-id', () => {
    const xml = coti(listing('de.xlf'), '').replace(
      '<translation ',
      `<meta name="job" value="${JOB.id}"/><translation `,
    );
    const read = exchange.unpack(
      files({ 'coti.xml': xml, 'de.xlf': XLIFF('de') }),
    );
    expect(read?.[0]?.envelope.jobId).toBe(JOB.id);
  });

  it('refuses a description that is unsafe or broken, naming it', () => {
    const cases: [Record<string, string | Uint8Array>, string][] = [
      [
        {
          [`${DE}/COTI.xml`]: `<!DOCTYPE coti [<!ENTITY a "a">]>${coti(listing('de.xlf'))}`,
        },
        'dtd-forbidden',
      ],
      [{ [`${DE}/COTI.xml`]: '<coti' }, 'not-well-formed'],
      [
        { [`${DE}/COTI.xml`]: new Uint8Array([0x3c, 0xff, 0xfe]) },
        'unsupported-encoding',
      ],
      [{ [`${DE}/COTI.xml`]: '<coti/>' }, 'not-coti'],
      [
        { [`${DE}/COTI.xml`]: coti(listing('../../etc/passwd.xlf')) },
        'invalid-coti',
      ],
      [
        { [`${DE}/COTI.xml`]: coti(listing('/etc/passwd.xlf')) },
        'invalid-coti',
      ],
      [{ [`${DE}/COTI.xml`]: coti(listing('de.xlf'), '') }, 'no-job'],
      [{ [`${DE}/COTI.xml`]: coti(listing('de.xlf')) }, 'missing-file'],
      [
        {
          [`${DE}/COTI.xml`]: coti(listing('de.docx', 'application/msword')),
          [`${DE}/de.docx`]: 'x',
        },
        'unsupported-file',
      ],
      [
        {
          [`${DE}/COTI.xml`]: coti(listing('de.xlf') + listing('de.xlf')),
          [`${DE}/de.xlf`]: XLIFF('de'),
        },
        'duplicate-file',
      ],
      [
        {
          [`${DE}/COTI.xml`]: coti(listing('de.xlf')),
          [`${DE}/coti.XML`]: coti(listing('de.xlf')),
          [`${DE}/de.xlf`]: XLIFF('de'),
        },
        'duplicate-description',
      ],
    ];
    for (const [entries, reason] of cases) {
      const error = refusal(files(entries));
      expect(error.code).toBe('invalid-coti');
      expect(error.meta.reason).toBe(reason);
      expect(error.meta.path).toBeDefined();
    }
  });

  it('refuses a description too large to be one before decoding it', () => {
    const error = refusal(
      files({ [`${DE}/COTI.xml`]: new Uint8Array(4 * 1024 * 1024 + 1) }),
    );
    expect(error.meta.reason).toBe('too-large');
  });

  it('writes languages as COTI codes', () => {
    expect(exchange.languageCode('de')).toBe('de-DE');
    expect(exchange.languageCode('pt-BR')).toBe('pt-BR');
    // An uploaded XLIFF's tag that is none matches no code, instead of throwing.
    expect(exchange.languageCode('en us')).toBe('en us');
  });

  it('refuses a description naming two jobs', () => {
    const xml = coti(listing('de.xlf')).replace(
      '<translation ',
      '<meta name="job" value="another"/><translation ',
    );
    const error = refusal(
      files({ [`${DE}/COTI.xml`]: xml, [`${DE}/de.xlf`]: XLIFF('de') }),
    );
    expect(error.code).toBe('coti-job-mismatch');
  });
});
