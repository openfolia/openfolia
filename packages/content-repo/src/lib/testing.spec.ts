import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printPageDesign, validateModule } from '@openfolia/content-model';
import {
  addSamplePageDesigns,
  addSampleRtlLanguages,
  addSampleTerms,
  createBareSampleRepo,
  SAMPLE_PAGE_DESIGNS,
  SAMPLE_RTL_LANGUAGES,
  SAMPLE_TERMS,
} from '../testing.js';
import { ContentError, ContentRepo } from './snapshot.js';
import { GitWriter } from './writer.js';

describe('createBareSampleRepo', () => {
  it('makes a bare copy of the sample, with its branches and tag', async () => {
    const { dir, commits } = createBareSampleRepo();
    const repo = ContentRepo.open(dir);
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
      expect(git('rev-parse', '--is-bare-repository')).toBe('true');
      expect(git('remote')).toBe('');
      expect((await repo.at('main'))?.commit).toBe(commits.main);
      expect((await repo.at('draft'))?.commit).toBe(commits.draft);
      expect((await repo.at('v1'))?.commit).toBe(commits.v1);
      // Nothing is checked out, so the writer may move any branch.
      await new GitWriter(dir).createBranch('x', commits.main);
      expect((await repo.at('x'))?.commit).toBe(commits.main);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fills an empty target and refuses one that is not empty', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openfolia-target-'));
    try {
      const target = join(parent, 'content.git');
      expect(createBareSampleRepo(target).dir).toBe(target);
      expect(() => createBareSampleRepo(target)).toThrow('is not empty');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('addSampleTerms', () => {
  it(
    'adds the terms and a module using a forbidden variant, all readable',
    { timeout: 30_000 },
    async () => {
      const { dir, commits } = createBareSampleRepo();
      const repo = ContentRepo.open(dir);
      try {
        const commit = await addSampleTerms(dir);
        const snap = await repo.at('main');
        expect(snap?.commit).toBe(commit);
        expect(await snap?.terms()).toEqual(Object.keys(SAMPLE_TERMS).sort());
        const charger = await snap?.term('charger');
        expect(charger?.languages['en']?.forbidden[0]?.term).toBe('loader');
        expect((await snap?.term('power-pack'))?.replacedBy).toBe('battery');
        expect(await snap?.term('nothing')).toBeUndefined();
        expect(await snap?.term('../openfolia')).toBeUndefined();
        expect(await snap?.term('export')).toBeUndefined();
        const storage = await snap?.module('storage', 'en');
        expect(JSON.stringify(storage?.blocks)).toContain('loader');
        // It links two terms, which the operating manual's glossary lists (#245).
        expect((await snap?.manifest('operating'))?.glossary).toBe(true);
        const resolved = await snap?.resolve(
          'operating',
          { model: 'large' },
          'en',
        );
        expect(resolved?.manual.terms?.map((t) => t.id)).toEqual([
          'battery',
          'charger',
        ]);
        // Earlier commits have none.
        expect(await (await repo.at(commits.main))?.terms()).toEqual([]);
      } finally {
        repo.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('throws ContentError for a file that is no term', async () => {
    const { dir, commits } = createBareSampleRepo();
    const repo = ContentRepo.open(dir);
    try {
      await new GitWriter(dir).commit({
        branch: 'main',
        parent: commits.main,
        changes: [{ path: 'terms/broken.yaml', content: 'status: [\n' }],
        message: 'broken',
        author: { name: 'T', email: 't@example.com' },
      });
      const snap = await repo.at('main');
      expect(await snap?.terms()).toEqual(['broken']);
      await expect(snap?.term('broken')).rejects.toThrow(ContentError);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('addSamplePageDesigns', () => {
  it(
    'adds the page designs, each readable at design/<id>.yaml',
    { timeout: 30_000 },
    async () => {
      const { dir, commits } = createBareSampleRepo();
      const repo = ContentRepo.open(dir);
      try {
        const commit = await addSamplePageDesigns(dir);
        const snap = await repo.at('main');
        expect(snap?.commit).toBe(commit);
        expect(await snap?.pageDesigns()).toEqual(['classic', 'minimal']);
        const classic = await snap?.pageDesign('classic');
        expect(classic?.name).toBe('Classic');
        expect(classic && printPageDesign(classic)).toBe(
          SAMPLE_PAGE_DESIGNS['classic'],
        );
        expect((await snap?.pageDesign('minimal'))?.preset).toBe('minimal');
        expect(await snap?.pageDesign('nothing')).toBeUndefined();
        expect(await snap?.pageDesign('../openfolia')).toBeUndefined();
        // Earlier commits have none.
        expect(await (await repo.at(commits.main))?.pageDesigns()).toEqual([]);
      } finally {
        repo.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('throws ContentError for a file that is no design', async () => {
    const { dir, commits } = createBareSampleRepo();
    const repo = ContentRepo.open(dir);
    try {
      await new GitWriter(dir).commit({
        branch: 'main',
        parent: commits.main,
        changes: [{ path: 'design/broken.yaml', content: 'preset: [\n' }],
        message: 'broken',
        author: { name: 'T', email: 't@example.com' },
      });
      const snap = await repo.at('main');
      expect(await snap?.pageDesigns()).toEqual(['broken']);
      await expect(snap?.pageDesign('broken')).rejects.toThrow(ContentError);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('addSampleRtlLanguages', () => {
  it(
    'adds Arabic and Hebrew, valid translations of a module and a manual of it',
    { timeout: 30_000 },
    async () => {
      const { dir } = createBareSampleRepo();
      const repo = ContentRepo.open(dir);
      try {
        const commit = await addSampleRtlLanguages(dir);
        const snap = await repo.at('main');
        expect(snap?.commit).toBe(commit);
        const config = await snap!.config();
        expect(config.languages.targets).toEqual(['de', 'fr', 'ar', 'he']);
        // Nothing but the tags: the direction comes from the script.
        expect(config.languages.direction).toBeUndefined();
        for (const lang of ['en', ...SAMPLE_RTL_LANGUAGES]) {
          const module = await snap!.module('display', lang);
          expect(module?.meta.lang).toBe(lang);
          expect(validateModule(module!, config)).toEqual([]);
        }
        for (const lang of SAMPLE_RTL_LANGUAGES) {
          const resolved = await snap!.resolve(
            'quick-start',
            { model: 'large' },
            lang,
          );
          expect(resolved?.manual.directions?.[lang]).toBe('rtl');
          expect(resolved?.manual.entries[0]).toMatchObject({ lang });
          expect(resolved?.issues).toEqual([]);
        }
      } finally {
        repo.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
