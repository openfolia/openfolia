import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COTI_NAMESPACE,
  CotiReadError,
  CotiWriteError,
  cotiLanguage,
  cotiName,
  cotiProjectFolder,
  cotiTimestamp,
  isRelativeFileRef,
  readCoti,
  writeCoti,
  type CotiProject,
} from './coti.js';
import { cotiSchemaErrors } from './coti-schema.js';

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/coti/${name}`, import.meta.url)),
    'utf8',
  );

const PROJECT: CotiProject = {
  creator: 'Example CMS',
  creationDate: new Date('2026-11-20T09:30:15.250Z'),
  packageId: '01938a2e-7d3c-7b11-8a00-000000000001',
  name: 'Translation job 01938a2e',
  projectId: '01938a2e-7d3c-7b11-8a00-000000000001-de',
  checkoutDate: new Date('2026-11-20T09:00:00Z'),
  dueDate: new Date('2026-12-01T00:00:00Z'),
  subject: 'Modules charging & storage <draft>',
  meta: [
    { name: 'job', value: '01938a2e-7d3c-7b11-8a00-000000000001' },
    { name: 'commit', value: 'a'.repeat(40) },
  ],
  translationName: 'translation-01938a2e-de',
  sourceLanguage: 'en-US',
  targetLanguage: 'de-DE',
  status: 'none',
  files: [
    {
      fileRef: 'translation files/translation-01938a2e-de.xlf',
      mimeType: 'application/xliff+xml',
      encoding: 'UTF-8',
      creationDate: new Date('2026-11-20T09:30:15Z'),
    },
  ],
};

describe('cotiLanguage', () => {
  it('writes language and region, the likely region where the tag has none', () => {
    expect(cotiLanguage('de')).toBe('de-DE');
    expect(cotiLanguage('en')).toBe('en-US');
    expect(cotiLanguage('pt-BR')).toBe('pt-BR');
    expect(cotiLanguage('ar')).toBe('ar-EG');
    expect(cotiLanguage('zh-Hant-TW')).toBe('zh-TW');
    expect(cotiLanguage('sr-Latn')).toMatch(/^sr-[A-Z]{2}$/);
  });
});

describe('names', () => {
  it('times a package in UTC without separators in the time', () => {
    expect(cotiTimestamp(new Date('2009-11-13T10:39:35.999Z'))).toBe(
      '2009-11-13T103935Z',
    );
  });

  it('keeps only the characters a project folder may hold', () => {
    expect(cotiName('job 1/ä:x+y_z-1')).toBe('job-1---x+y_z-1');
    expect(
      cotiProjectFolder({
        projectId: '4711',
        sourceLanguage: 'de-DE',
        targetLanguage: 'en-GB',
      }),
    ).toBe('4711_de-DE_en-GB');
  });

  it('tells a relative path inside the folder from one that leaves it', () => {
    expect(isRelativeFileRef('translation files/a.xlf')).toBe(true);
    for (const ref of [
      '../a.xlf',
      'translation files/../../a.xlf',
      '/etc/passwd',
      'C:/a.xlf',
      'a\\b.xlf',
      'a//b.xlf',
      './a.xlf',
      '',
    ]) {
      expect(isRelativeFileRef(ref)).toBe(false);
    }
  });
});

describe('writeCoti', () => {
  it('writes a project description the standard’s schema takes', () => {
    const xml = writeCoti(PROJECT);
    expect(cotiSchemaErrors(xml)).toEqual([]);
    expect(xml).toContain(
      `<coti xmlns="${COTI_NAMESPACE}" version="1.1" level="1"`,
    );
    expect(xml).toContain('creation-date="2026-11-20T09:30:15Z"');
    expect(xml).toContain('due-date="2026-12-01T00:00:00Z"');
    expect(xml).toContain(
      '<subject>Modules charging &amp; storage &lt;draft&gt;</subject>',
    );
    expect(xml).toContain('proposal="no"');
  });

  it('reads back what it wrote', () => {
    expect(readCoti(writeCoti(PROJECT))).toEqual({
      level: '1',
      version: '1.1',
      packageId: PROJECT.packageId,
      projectId: PROJECT.projectId,
      meta: expect.objectContaining({ job: PROJECT.packageId }),
      sourceLanguage: 'en-US',
      targetLanguage: 'de-DE',
      status: 'none',
      files: [
        {
          fileRef: 'translation files/translation-01938a2e-de.xlf',
          mimeType: 'application/xliff+xml',
        },
      ],
    });
  });

  it('leaves out what a project does not have, still valid', () => {
    const {
      dueDate: _d,
      subject: _s,
      meta: _m,
      status: _st,
      ...bare
    } = PROJECT;
    const xml = writeCoti({
      ...bare,
      files: [{ fileRef: 'a.xlf', mimeType: 'application/xliff+xml' }],
    });
    expect(cotiSchemaErrors(xml)).toEqual([]);
    expect(xml).not.toContain('due-date');
    expect(xml).not.toContain('<subject>');
  });

  it('escapes attribute values', () => {
    const xml = writeCoti({ ...PROJECT, name: 'A "quoted" <name> & more' });
    expect(xml).toContain(
      'name="A &quot;quoted&quot; &lt;name&gt; &amp; more"',
    );
    expect(cotiSchemaErrors(xml)).toEqual([]);
  });

  it('refuses what the schema would', () => {
    expect(() => writeCoti({ ...PROJECT, targetLanguage: 'de' })).toThrow(
      CotiWriteError,
    );
    expect(() => writeCoti({ ...PROJECT, files: [] })).toThrow(CotiWriteError);
    expect(() =>
      writeCoti({
        ...PROJECT,
        files: [{ fileRef: '../x.xlf', mimeType: 'application/xliff+xml' }],
      }),
    ).toThrow(CotiWriteError);
    expect(() =>
      writeCoti({
        ...PROJECT,
        files: [
          { fileRef: 'x'.repeat(256), mimeType: 'application/xliff+xml' },
        ],
      }),
    ).toThrow(CotiWriteError);
    expect(() =>
      writeCoti({
        ...PROJECT,
        files: [{ fileRef: 'a.xlf', mimeType: 'xliff' }],
      }),
    ).toThrow(CotiWriteError);
  });
});

describe('readCoti', () => {
  it('reads a description as a translation system returns it (its ID and status set, reference files added)', () => {
    const xml = fixture('returned-COTI.xml');
    expect(cotiSchemaErrors(xml)).toEqual([]);
    expect(readCoti(xml)).toMatchObject({
      level: '1',
      packageId: '01938a2e-7d3c-7b11-8a00-000000000001',
      projectId: '01938a2e-7d3c-7b11-8a00-000000000001-de',
      sourceLanguage: 'en-US',
      targetLanguage: 'de-DE',
      status: 'final',
      files: [
        {
          fileRef:
            'translation files/translation-01938a2e-7d3c-7b11-8a00-000000000001-de.xlf',
          mimeType: 'application/xliff+xml',
        },
      ],
    });
  });

  const refused = (xml: string) => {
    try {
      readCoti(xml);
    } catch (error) {
      expect(error).toBeInstanceOf(CotiReadError);
      return (error as CotiReadError).reason;
    }
    throw new Error('not refused');
  };
  const wrap = (translation: string, root = 'level="1" version="1.1"') =>
    `<coti xmlns="${COTI_NAMESPACE}" ${root} creator="x" creation-date="2026-01-01T00:00:00Z"><project name="p" project-id="1" checkout-date="2026-01-01T00:00:00Z" proposal="no">${translation}</project></coti>`;
  const FILE =
    '<translation-file file-ref="translation files/a.xlf" mime-type="application/xliff+xml"/>';
  const translation = (attrs: string, files = FILE) =>
    `<translation name="t" ${attrs}>${files}</translation>`;
  const LANGS = 'source-language="en-US" target-language="de-DE"';

  it('takes a well-formed one', () => {
    expect(readCoti(wrap(translation(LANGS))).projectId).toBe('1');
  });

  it('refuses a DTD, so no entity is ever declared or expanded', () => {
    expect(
      refused(
        `<?xml version="1.0"?><!DOCTYPE coti [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>${wrap(translation(LANGS))}`,
      ),
    ).toBe('dtd-forbidden');
    expect(
      refused(
        `<!DOCTYPE coti SYSTEM "http://example.invalid/coti.dtd">${wrap(translation(LANGS))}`,
      ),
    ).toBe('dtd-forbidden');
    expect(
      refused(wrap(translation(LANGS)).replace('name="p"', 'name="&x;"')),
    ).toBe('dtd-forbidden');
  });

  it('refuses another encoding, a document too large or too deep', () => {
    expect(
      refused(
        `<?xml version="1.0" encoding="ISO-8859-1"?>${wrap(translation(LANGS))}`,
      ),
    ).toBe('unsupported-encoding');
    expect(refused(`<a>${' '.repeat(1024 * 1024)}</a>`)).toBe('too-large');
    expect(refused(`${'<a>'.repeat(9)}${'</a>'.repeat(9)}`)).toBe('too-deep');
    expect(refused('<coti')).toBe('not-well-formed');
  });

  it('refuses what is no COTI document', () => {
    expect(refused('<coti level="1"/>')).toBe('not-coti');
    expect(
      refused('<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0"/>'),
    ).toBe('not-coti');
  });

  it('refuses one missing what every one has', () => {
    for (const xml of [
      wrap(translation(LANGS), 'version="1.1"'),
      wrap(translation(LANGS), 'level="7" version="1.1"'),
      wrap(translation('source-language="en-US" target-language="de"')),
      wrap(translation('source-language="en-US"')),
      wrap(translation(LANGS, '')),
      wrap(
        translation(
          LANGS,
          '<translation-file file-ref="../../a.xlf" mime-type="text/xml"/>',
        ),
      ),
      wrap(
        translation(
          LANGS,
          '<translation-file file-ref="/a.xlf" mime-type="text/xml"/>',
        ),
      ),
      wrap(translation(LANGS, '<translation-file file-ref="a.xlf"/>')),
      wrap(translation(`${LANGS} status="done"`)),
      wrap(''),
      wrap(translation(LANGS) + translation(LANGS)),
      wrap(translation(LANGS)).replace(' project-id="1"', ''),
    ]) {
      expect(refused(xml)).toBe('invalid-coti');
    }
  });

  it('reads a meta entry named like an object’s own members as data', () => {
    const xml = wrap(
      `<meta name="__proto__" value="x"/><meta name="job" value="j"/>${translation(LANGS)}`,
    );
    const read = readCoti(xml);
    expect(read.meta['job']).toBe('j');
    expect(read.meta['__proto__']).toBe('x');
    expect(Object.getPrototypeOf(read.meta)).toBeNull();
  });
});

describe('cotiSchemaErrors', () => {
  it('names what the schema refuses', () => {
    const valid = writeCoti(PROJECT);
    expect(cotiSchemaErrors(valid.replace(' proposal="no"', ''))).toEqual([
      expect.stringContaining('lacks the attribute "proposal"'),
    ]);
    expect(
      cotiSchemaErrors(
        valid.replace(
          'checkout-date="2026-11-20T09:00:00Z"',
          'checkout-date="2026-11-20"',
        ),
      ),
    ).toEqual([expect.stringContaining('checkout-date')]);
    expect(
      cotiSchemaErrors(
        valid.replace('<subject>', '<meta name="a" value="b"/><subject>'),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('does not take <subject>'),
      ]),
    );
    expect(
      cotiSchemaErrors(
        valid.replace('version="1.1"', 'version="1.1" extra="x"'),
      ),
    ).toEqual([expect.stringContaining('no attribute "extra"')]);
  });
});
