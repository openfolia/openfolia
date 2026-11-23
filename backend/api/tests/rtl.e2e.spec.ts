import { execFileSync } from 'node:child_process';
import { addSampleRtlLanguages } from '@openfolia/content-repo/testing';
import { ProjectConfigDocument } from '../src/project/api/project.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Right-to-left languages (#458) through the API, over the sample repository with Arabic and
 * Hebrew added (`addSampleRtlLanguages`: their direction from their script, nothing else
 * configured; the `display` module in both and the `quick-start` manual of it).
 */
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  await addSampleRtlLanguages(process.env['CCMS_CONTENT_DIR'] as string);
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

describe('right-to-left languages through the API (#458)', () => {
  it('needs nothing in the configuration but the languages', async () => {
    t.actAs(READER);
    const res = await t.get('/config');
    expect(res.status).toBe(200);
    const config = ProjectConfigDocument.parse(res.body).data.attributes;
    expect(config.languages.targets).toEqual(['de', 'fr', 'ar', 'he']);
    expect(config.languages.direction).toBeUndefined();
  });

  it.each(['ar', 'he'])(
    'previews the %s manual and module right to left, code isolated left to right',
    async (lang) => {
      t.actAs(READER);
      const manual = await t.get(
        `/manuals/quick-start/variants/model=large/${lang}/html`,
      );
      expect(manual.status).toBe(200);
      expect(manual.text).toContain(`<html lang="${lang}" dir="rtl">`);
      expect(manual.text).toContain(
        `<article class="of-content of-manual" lang="${lang}" dir="rtl">`,
      );
      expect(manual.text).toContain(
        '<code class="of-code" dir="ltr">E-104</code>',
      );
      // The product name the variant fills in stays in the text, in its place.
      expect(manual.text).toContain('Model A');

      const module = await t.get(`/modules/${lang}/display/preview`);
      expect(module.status).toBe(200);
      expect(module.text).toContain(`<html lang="${lang}" dir="rtl">`);
      expect(module.text).toContain(`lang="${lang}" dir="rtl"`);
    },
  );

  it('previews a left-to-right language left to right', async () => {
    t.actAs(READER);
    const res = await t.get(
      '/manuals/quick-start/variants/model=large/en/html',
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<html lang="en" dir="ltr">');
    expect(res.text).not.toContain('dir="rtl"');
  });

  it.each([
    ['ar', 'NotoSansArabic-'],
    ['he', 'NotoSansHebrew-'],
  ])(
    'renders the %s PDF under PDF/UA-1 in its script’s font',
    { timeout: 60_000 },
    async (lang, font) => {
      t.actAs(READER);
      const res = await t
        .get(`/manuals/quick-start/variants/model=large/${lang}/pdf`)
        .set('Accept', 'application/pdf')
        .buffer(true);
      expect(res.status).toBe(200);
      const pdf = (res.body as Buffer).toString('latin1');
      expect(pdf).toMatch(new RegExp(`/Lang \\(${lang}\\)`));
      expect(pdf).toMatch(new RegExp(`/BaseFont\\s*/(?:[A-Z]{6}\\+)?${font}`));
      expect(res.headers['x-ccms-issues']).toBe('0');
    },
  );
});

describe('a direction for a language not configured (#396)', () => {
  const git = (args: string[], input?: string) =>
    execFileSync(
      'git',
      ['-C', process.env['CCMS_CONTENT_DIR'] as string, ...args],
      {
        encoding: 'utf8',
        ...(input !== undefined && { input }),
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      },
    ).trim();

  it('is reported as a finding of the configuration, never refused', async () => {
    // A branch of its own whose configuration, edited by hand, sets `fa` (not configured).
    const config = git(['show', 'main:openfolia.yaml']);
    const targets = '  targets: [de, fr, ar, he]\n';
    expect(config).toContain(targets);
    const blob = git(
      ['hash-object', '-w', '--stdin'],
      config.replace(
        targets,
        `${targets}  direction:\n    fa: rtl\n    he: ltr\n`,
      ) + '\n',
    );
    const tree = git(
      ['mktree'],
      git(['ls-tree', 'main'])
        .split('\n')
        .map((line) =>
          line.endsWith('\topenfolia.yaml')
            ? `100644 blob ${blob}\topenfolia.yaml`
            : line,
        )
        .join('\n') + '\n',
    );
    const commit = git([
      'commit-tree',
      tree,
      '-p',
      'main',
      '-m',
      'A direction for a language not configured',
    ]);
    git(['update-ref', 'refs/heads/orphan-direction', commit]);

    t.actAs(actorWith(['content.read', 'content.read.draft']));
    const res = await t.get('/config?ref=orphan-direction');
    expect(res.status).toBe(200);
    const { attributes, meta } = ProjectConfigDocument.parse(res.body).data;
    expect(attributes.languages.direction).toEqual({ fa: 'rtl', he: 'ltr' });
    expect(meta?.directionIssues).toEqual([
      {
        code: 'unknown-direction-language',
        path: 'languages.direction.fa',
        message: expect.stringContaining('"fa"'),
      },
    ]);

    // Main has none: no finding, and no `meta` at all.
    const main = await t.get('/config');
    expect(ProjectConfigDocument.parse(main.body).data.meta).toBeUndefined();
  });
});
