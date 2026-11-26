import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  compareWithRecord,
  translationRecordOf,
} from '@openfolia/content-model';
import {
  createBareSampleRepo,
  createSampleRepo,
  PNG,
  PNG_HASH,
} from '../testing.js';
import { GitRepo, isSafeRef } from './git.js';
import { ContentError, ContentRepo } from './snapshot.js';
import { GitWriter } from './writer.js';

const { dir, commits } = createSampleRepo();
const repo = ContentRepo.open(dir);
afterAll(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('refs', () => {
  it('resolves branches, annotated tags and commit IDs', async () => {
    expect((await repo.at('main'))?.commit).toBe(commits.main);
    expect((await repo.at('v1'))?.commit).toBe(commits.v1);
    expect((await repo.at('draft'))?.commit).toBe(commits.draft);
    expect((await repo.at(commits.v1))?.commit).toBe(commits.v1);
    expect(await repo.at('nope')).toBeUndefined();
  });

  it('resolves several refs as each alone, from one ref listing (atEach)', async () => {
    const git = new GitRepo(dir);
    const runs = vi.spyOn(
      git as unknown as { git: (args: string[]) => Promise<unknown> },
      'git',
    );
    const refs = ['v1', 'main', 'nope', 'refs/tags/v1', 'draft', '--x', 'v1'];
    const each = await git.resolveRefs(refs);
    const subcommands = runs.mock.calls.map(([args]) => args[0]);
    expect(subcommands).toEqual(['for-each-ref']);
    expect(each).toEqual(
      await Promise.all(refs.map((ref) => new GitRepo(dir).resolveRef(ref))),
    );
    expect(each).toEqual([
      commits.v1,
      commits.main,
      undefined,
      commits.v1,
      commits.draft,
      undefined,
      commits.v1,
    ]);
    // None to resolve: nothing listed.
    runs.mockClear();
    expect(await git.resolveRefs([])).toEqual([]);
    expect(runs).not.toHaveBeenCalled();
    git.close();
    const snapshots = await repo.atEach(['v1', 'nope', 'main']);
    expect(snapshots.map((s) => s?.commit)).toEqual([
      commits.v1,
      undefined,
      commits.main,
    ]);
  });

  it('looks a full commit ID up once, and anything else every time', async () => {
    const git = new GitRepo(dir);
    const runs = vi.spyOn(
      git as unknown as { git: (args: string[]) => Promise<unknown> },
      'git',
    );
    expect(await git.resolveRef(commits.v1)).toBe(commits.v1);
    const once = runs.mock.calls.length;
    expect(await git.resolveRef(commits.v1)).toBe(commits.v1);
    expect(runs.mock.calls.length).toBe(once);
    // An abbreviated ID is looked up again, so is one naming no commit.
    expect(await git.resolveRef(commits.v1.slice(0, 12))).toBe(commits.v1);
    expect(runs.mock.calls.length).toBeGreaterThan(once);
    const missing = 'f'.repeat(40);
    expect(await git.resolveRef(missing)).toBeUndefined();
    const after = runs.mock.calls.length;
    expect(await git.resolveRef(missing)).toBeUndefined();
    expect(runs.mock.calls.length).toBeGreaterThan(after);
    git.close();
  });

  it('rejects options and revision syntax', async () => {
    for (const ref of [
      '--help',
      '-n',
      'main~1',
      'main^',
      'v1:openfolia.yaml',
      'main@{1}',
      'a..b',
      'HEAD@{0}',
      '',
      'a b',
    ]) {
      expect(isSafeRef(ref)).toBe(false);
      expect(await repo.at(ref)).toBeUndefined();
    }
  });

  it('lists branches and tags', async () => {
    expect(await repo.git.refs()).toEqual({
      branches: [
        { name: 'draft', commit: commits.draft },
        { name: 'main', commit: commits.main },
      ],
      tags: [{ name: 'v1', commit: commits.v1 }],
    });
  });

  it('lists tags newest first', async () => {
    expect(await repo.git.tagsNewestFirst()).toEqual([
      { name: 'v1', commit: commits.v1 },
    ]);
  });

  it('names the branch HEAD points to', async () => {
    expect(await repo.git.headBranch()).toBe('main');
  });

  it('lists the refs whose history contains a commit', async () => {
    expect(await repo.git.refsContaining(commits.v1)).toEqual([
      'refs/heads/draft',
      'refs/heads/main',
      'refs/tags/v1',
    ]);
    expect(await repo.git.refsContaining(commits.draft)).toEqual([
      'refs/heads/draft',
    ]);
    await expect(repo.git.refsContaining('main')).rejects.toThrow(
      'not a commit ID',
    );
  });
});

describe('GitRepo.countAhead', () => {
  const git = new GitRepo(dir);

  it('counts the commits one history has that another has not, up to a limit', async () => {
    const ahead = await git.countAhead(commits.main, commits.v1, 1000);
    expect(ahead).toBeGreaterThan(0);
    expect(await git.countAhead(commits.v1, commits.main, 1000)).toBe(0);
    expect(await git.countAhead(commits.main, commits.main, 1000)).toBe(0);
    expect(await git.countAhead(commits.main, commits.v1, 1)).toBe(1);
    await expect(git.countAhead('main', commits.v1, 1)).rejects.toThrow(
      /not a commit ID/,
    );
    await expect(git.countAhead(commits.main, commits.v1, 0)).rejects.toThrow(
      /invalid count/,
    );
  });
});

describe('GitRepo.isAncestor', () => {
  const git = new GitRepo(dir);

  it('tells a commit in the history from one that is not', async () => {
    expect(await git.isAncestor(commits.v1, commits.main)).toBe(true);
    expect(await git.isAncestor(commits.main, commits.main)).toBe(true);
    expect(await git.isAncestor(commits.main, commits.v1)).toBe(false);
    expect(await git.isAncestor(commits.draft, commits.main)).toBe(false);
  });

  it('answers false for an ID that names no commit, and refuses what is not an ID', async () => {
    expect(await git.isAncestor('0'.repeat(40), commits.main)).toBe(false);
    await expect(git.isAncestor('main', commits.main)).rejects.toThrow(
      /not a commit ID/,
    );
  });
});

describe('snapshots', () => {
  it('read content as it was at each commit', async () => {
    const text = async (ref: string) =>
      JSON.stringify(
        (await (await repo.at(ref))?.module('charging', 'en'))?.blocks[0],
      );
    expect(await text('v1')).toContain('charges itself.');
    expect(await text('main')).toContain('charges automatically.');
  });

  it('reads config, module lists, manifests, assets and symbols', async () => {
    const snap = await repo.at('main');
    expect((await snap?.config())?.languages.source).toBe('en');
    expect(await snap?.modules('de')).toEqual([{ id: 'charging', lang: 'de' }]);
    expect((await snap?.modules())?.length).toBe(4);
    expect(await snap?.manifests()).toEqual(['operating', 'service']);
    expect((await snap?.manifest('operating'))?.title).toBe('Operating manual');
    expect(await snap?.asset(PNG_HASH)).toEqual(PNG);
    expect(await snap?.asset('../openfolia.yaml')).toBeUndefined();
    expect(await snap?.symbols()).toEqual(
      new Map([['w001', 'symbols/w001.svg']]),
    );
  });

  it('names a module file by its blob, equal where the file is', async () => {
    const [v1, main, draft] = await Promise.all(
      ['v1', 'main', 'draft'].map((ref) => repo.at(ref)),
    );
    const at = (snap: typeof v1, id: string, lang = 'en') =>
      snap?.moduleRevision(id, lang);
    // `charging` changed after v1; the German one did not.
    expect(await at(v1, 'charging')).toMatch(/^[0-9a-f]{40}$/);
    expect(await at(v1, 'charging')).not.toBe(await at(main, 'charging'));
    expect(await at(v1, 'charging', 'de')).toBe(
      await at(main, 'charging', 'de'),
    );
    expect(await at(main, 'charging')).toBe(await at(draft, 'charging'));
    expect(await at(main, 'broken')).toBeUndefined();
    expect(await at(draft, 'broken')).toMatch(/^[0-9a-f]{40}$/);
    expect(await at(main, '../openfolia')).toBeUndefined();
    expect(await at(main, 'charging', 'DE')).toBeUndefined();
  });

  it('returns undefined for missing or invalid names instead of touching other paths', async () => {
    const snap = await repo.at('main');
    expect(await snap?.module('nope', 'en')).toBeUndefined();
    expect(await snap?.module('../openfolia', 'en')).toBeUndefined();
    expect(await snap?.module('charging', 'DE')).toBeUndefined();
    expect(await snap?.manifest('../openfolia')).toBeUndefined();
  });

  it('reports broken files as content errors', async () => {
    const snap = await repo.at('draft');
    await expect(snap?.module('broken', 'en')).rejects.toBeInstanceOf(
      ContentError,
    );
    await expect(snap?.module('broken', 'en')).rejects.toThrow(
      /^modules\/en\/broken\.adoc: /,
    );
  });

  it('reads a translation record next to its module, which no module list names', async () => {
    const [v1, main] = await Promise.all(['v1', 'main'].map((r) => repo.at(r)));
    expect(await v1?.translationRecord('charging', 'de')).toBeUndefined();
    const record = await main?.translationRecord('charging', 'de');
    expect(record?.sourceCommit).toBe(commits.v1);
    // Made from v1's English text: the intro changed since, the image did not.
    const source = await main?.module('charging', 'en');
    if (!source) throw new Error('no source');
    expect(compareWithRecord(source, record)).toEqual([
      { blockId: 'intro', state: 'outdated' },
      { blockId: 'photo', state: 'up-to-date' },
    ]);
    const old = await v1?.module('charging', 'en');
    if (!old) throw new Error('no source');
    expect(record).toEqual(translationRecordOf(old, commits.v1));
    expect(await main?.translationRecord('charging', 'fr')).toBeUndefined();
    expect(await main?.translationRecord('../x', 'de')).toBeUndefined();
    expect(await main?.translationRecord('charging', 'DE')).toBeUndefined();
    expect(await main?.modules('de')).toEqual([{ id: 'charging', lang: 'de' }]);
  });

  it('reports a broken translation record as a content error', async () => {
    const bare = createBareSampleRepo();
    const own = ContentRepo.open(bare.dir);
    try {
      await new GitWriter(bare.dir).commit({
        branch: 'main',
        parent: bare.commits.main,
        changes: [
          {
            path: 'modules/de/charging.translation.yaml',
            content: 'schemaVersion: 1\nblocks: nope\n',
          },
        ],
        message: 'Break the record',
        author: { name: 'Test', email: 'test@example.com' },
      });
      const snap = await own.at('main');
      await expect(snap?.translationRecord('charging', 'de')).rejects.toThrow(
        /^modules\/de\/charging\.translation\.yaml: /,
      );
      await expect(
        snap?.translationRecord('charging', 'de'),
      ).rejects.toBeInstanceOf(ContentError);
    } finally {
      own.close();
      rmSync(bare.dir, { recursive: true, force: true });
    }
  });

  // A clone, 200 files and a push: more than the default 5 s on a loaded machine.
  it(
    'reads a page design’s own template: its folder’s regular files only, weighed first (#396)',
    { timeout: 60_000 },
    async () => {
      const bare = createBareSampleRepo();
      const work = mkdtempSync(join(tmpdir(), 'openfolia-template-'));
      const own = ContentRepo.open(bare.dir);
      try {
        const git = (...args: string[]) =>
          execFileSync('git', ['-C', work, ...args], {
            encoding: 'utf8',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'Test',
              GIT_AUTHOR_EMAIL: 'test@example.com',
              GIT_COMMITTER_NAME: 'Test',
              GIT_COMMITTER_EMAIL: 'test@example.com',
              GIT_CONFIG_GLOBAL: '/dev/null',
            },
          }).trim();
        git('clone', '-q', bare.dir, '.');
        const put = (path: string, text: string) => {
          mkdirSync(dirname(join(work, path)), { recursive: true });
          writeFileSync(join(work, path), text);
        };
        put('templates/house/manual.typ', '#let manual(..a, b) = b\n');
        put('templates/house/parts/notice.typ', '#let n = 1\n');
        put('templates/other/manual.typ', '// another\n');
        put('templates/empty/readme.txt', 'no entry\n');
        // A symbolic link in the folder (to a host file) is no file of the template.
        symlinkSync('/etc/passwd', join(work, 'templates/house/secret'));
        // An entry file that is a symbolic link: no template at all.
        mkdirSync(join(work, 'templates/linked'), { recursive: true });
        symlinkSync('/etc/passwd', join(work, 'templates/linked/manual.typ'));
        for (let i = 0; i < 201; i++) {
          put(`templates/many/${i === 0 ? 'manual' : `f${i}`}.typ`, '\n');
        }
        git('add', '-A');
        git('commit', '-q', '-m', 'Templates');
        const commit = git('rev-parse', 'HEAD');
        git('push', '-q', 'origin', 'HEAD:main');
        const snap = await own.at(commit);
        const files = await snap?.designTemplate('house');
        expect(Object.keys(files ?? {}).sort()).toEqual([
          'manual.typ',
          'parts/notice.typ',
        ]);
        expect(files?.['manual.typ']?.toString()).toBe(
          '#let manual(..a, b) = b\n',
        );
        expect(await snap?.designTemplateIds()).toEqual([
          'house',
          'many',
          'other',
        ]);
        // No manual.typ, no such folder, no slug: none.
        expect(await snap?.designTemplate('empty')).toBeUndefined();
        expect(await snap?.designTemplate('missing')).toBeUndefined();
        expect(await snap?.designTemplate('../modules')).toBeUndefined();
        // The editor's listing and one file (#396): regular files only, by path in the folder.
        expect(await snap?.designTemplateListing('house')).toEqual([
          { path: 'manual.typ', size: 24 },
          { path: 'parts/notice.typ', size: 11 },
        ]);
        expect(await snap?.designTemplateListing('missing')).toEqual([]);
        expect(await snap?.designTemplateListing('../modules')).toEqual([]);
        expect(
          (
            await snap?.designTemplateFile('house', 'parts/notice.typ')
          )?.toString(),
        ).toBe('#let n = 1\n');
        expect(
          await snap?.designTemplateFile('house', 'secret'),
        ).toBeUndefined();
        expect(
          await snap?.designTemplateFile('linked', 'manual.typ'),
        ).toBeUndefined();
        expect(
          await snap?.designTemplateFile('house', '../other/manual.typ'),
        ).toBeUndefined();
        // Listed however many files the folder holds: the editor still opens it.
        expect(await snap?.designTemplateListing('many')).toHaveLength(201);
        // Too many files: refused from the listing, before reading.
        await expect(snap?.designTemplate('many')).rejects.toMatchObject({
          code: 'template-too-large',
          path: 'templates/many',
        });
      } finally {
        own.close();
        rmSync(work, { recursive: true, force: true });
        rmSync(bare.dir, { recursive: true, force: true });
      }
    },
  );

  it('handles many concurrent reads', async () => {
    const git = new GitRepo(dir);
    const paths = Array.from({ length: 200 }, (_, i) =>
      i % 3 === 0
        ? 'openfolia.yaml'
        : i % 3 === 1
          ? 'nope'
          : `assets/${PNG_HASH}`,
    );
    const results = await Promise.all(
      paths.map((p) => git.readFile(commits.main, p)),
    );
    expect(results.filter((r) => r === undefined)).toHaveLength(67);
    expect(results[2]).toEqual(PNG);
    git.close();
  });
});

describe('the configuration under its earlier name (ccms.yaml, read for one release)', () => {
  const sample = createSampleRepo();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', sample.dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }).trim();
  const original = readFileSync(join(sample.dir, 'openfolia.yaml'), 'utf8');
  // Only the old name: the sample's configuration renamed back.
  git('checkout', '-q', '-b', 'legacy', 'main');
  git('mv', 'openfolia.yaml', 'ccms.yaml');
  git('commit', '-q', '-m', 'old name');
  const legacyOnly = git('rev-parse', 'HEAD');
  // Both names: the new one with other target languages, the old one as it was.
  writeFileSync(
    join(sample.dir, 'openfolia.yaml'),
    original.replace('targets: [de, fr]', 'targets: [de]'),
  );
  git('add', 'openfolia.yaml');
  git('commit', '-q', '-m', 'both');
  const both = git('rev-parse', 'HEAD');
  afterAll(() => rmSync(sample.dir, { recursive: true, force: true }));

  const warnings = () =>
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  afterEach(() => vi.restoreAllMocks());

  it('holds the sample as the test expects', () => {
    expect(original).toContain('targets: [de, fr]');
  });

  it('reads ccms.yaml when openfolia.yaml is missing, with one deprecation warning', async () => {
    const warn = warnings();
    const legacy = ContentRepo.open(sample.dir);
    try {
      const snap = await legacy.at(legacyOnly);
      expect((await snap?.config())?.languages.targets).toEqual(['de', 'fr']);
      await snap?.config();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(
        /read from ccms\.yaml.*Rename it to openfolia\.yaml/,
      );
      expect(warn.mock.calls[0]?.[1]).toEqual({
        type: 'DeprecationWarning',
        code: 'OPENFOLIA_LEGACY_CONFIG',
      });
    } finally {
      legacy.close();
    }
  });

  it('reads openfolia.yaml when both exist, and warns once that ccms.yaml is ignored', async () => {
    const warn = warnings();
    const legacy = ContentRepo.open(sample.dir);
    try {
      const snap = await legacy.at(both);
      expect((await snap?.config())?.languages.targets).toEqual(['de']);
      await snap?.config();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(
        /ccms\.yaml is ignored: openfolia\.yaml is beside it/,
      );
    } finally {
      legacy.close();
    }
  });

  it('warns about nothing when there is only openfolia.yaml', async () => {
    const warn = warnings();
    const current = ContentRepo.open(sample.dir);
    try {
      expect(
        (await (await current.at(sample.commits.main))?.config())?.languages
          .source,
      ).toBe('en');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      current.close();
    }
  });

  it('says the configuration is missing, by its new name, when neither exists', async () => {
    git('checkout', '-q', '-b', 'neither', legacyOnly);
    git('rm', '-q', 'ccms.yaml');
    git('commit', '-q', '-m', 'none');
    const none = git('rev-parse', 'HEAD');
    const empty = ContentRepo.open(sample.dir);
    try {
      await expect((await empty.at(none))?.config()).rejects.toThrow(
        /^openfolia\.yaml: missing$/,
      );
    } finally {
      empty.close();
    }
  });
});

describe('resolve', () => {
  it('loads referenced modules and resolves the manual', async () => {
    const snap = await repo.at('main');
    const result = await snap?.resolve('operating', { model: 'large' }, 'en');
    const text = JSON.stringify(result?.manual.entries);
    expect(text).toContain('The Model A charges automatically.');
    expect(text).toContain('Let it cool down.');
    expect(text).not.toContain('Internal only.');
    expect(result?.issues.map((i) => i.code)).toEqual(['above-audience']);
  });

  it('uses the translation when there is one and falls back otherwise', async () => {
    const result = await (
      await repo.at('main')
    )?.resolve('operating', { model: 'small' }, 'de');
    const text = JSON.stringify(result?.manual.entries);
    expect(text).toContain('Das Model B lädt sich selbst.');
    expect(result?.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-translation',
        module: 'safety-note',
      }),
    );
  });

  it('reports invalid modules as such, not as missing', async () => {
    const result = await (
      await repo.at('draft')
    )?.resolve('operating', { model: 'small' }, 'en');
    const codes = result?.issues
      .filter((i) => i.module === 'broken')
      .map((i) => i.code);
    expect(codes).toEqual(['invalid-module']);
  });

  it('leaves out modules the reader may not see, without following them', async () => {
    const result = await (
      await repo.at('main')
    )?.resolve('operating', { model: 'large' }, 'en', {
      visible: (m) => m.id !== 'charging',
    });
    const text = JSON.stringify(result?.manual.entries);
    expect(text).not.toContain('charges');
    // Only charging refers to the safety note: not followed, so not there.
    expect(text).not.toContain('Let it cool down.');
    expect(result?.issues).toContainEqual(
      expect.objectContaining({ code: 'outside-scope', module: 'charging' }),
    );
  });

  it('falls back to the source version when the translation may not be seen', async () => {
    const result = await (
      await repo.at('main')
    )?.resolve('operating', { model: 'large' }, 'de', {
      visible: (m) => m.meta.lang === 'en',
    });
    const text = JSON.stringify(result?.manual.entries);
    expect(text).toContain('charges automatically');
    expect(text).not.toContain('lädt');
    expect(result?.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-translation',
        module: 'charging',
      }),
    );
  });

  it('resolves the manifest it is given instead of the stored one', async () => {
    const snap = await repo.at('draft');
    const stored = await snap?.manifest('operating');
    if (!stored) throw new Error('no manifest');
    const all = await snap?.resolve('operating', { model: 'large' }, 'en');
    // `unlabelled`'s condition uses an attribute the variant does not set.
    expect(all?.issues.map((i) => i.code)).toContain(
      'missing-variant-attribute',
    );
    const manifest = {
      ...stored,
      entries: stored.entries.filter((e) => 'module' in e),
    };
    const result = await snap?.resolve('operating', { model: 'large' }, 'en', {
      manifest,
    });
    expect(result?.manifest).toBe(manifest);
    expect(JSON.stringify(result?.manual.entries)).not.toContain('unlabelled');
    expect(result?.issues.map((i) => i.code)).not.toContain(
      'missing-variant-attribute',
    );
  });

  it('takes a stand-in for a module, and the file where it has none', async () => {
    const snap = await repo.at('main');
    const charging = await snap?.module('charging', 'en');
    if (!charging) throw new Error('no module');
    const result = await snap?.resolve('operating', { model: 'large' }, 'en', {
      standIn: async (id, lang) =>
        id === 'charging' && lang === 'en'
          ? {
              ...charging,
              blocks: [
                {
                  type: 'paragraph',
                  id: 'typed',
                  content: [{ type: 'text', text: 'Not committed yet.' }],
                },
              ],
            }
          : undefined,
    });
    const text = JSON.stringify(result?.manual.entries);
    expect(text).toContain('Not committed yet.');
    expect(text).not.toContain('charges automatically');
    // The safety note only the committed text refers to is not followed.
    expect(text).not.toContain('Let it cool down.');
  });

  it('names a module a cross-reference links to outside the manual by its title (#796)', async () => {
    const snap = await repo.at('main');
    const stored = await snap?.manifest('operating');
    const note = await snap?.module('safety-note', 'en');
    if (!stored || !note) throw new Error('no manifest');
    const manifest = { ...stored, entries: [{ module: 'safety-note' }] };
    const linking = {
      ...note,
      blocks: [
        {
          type: 'paragraph' as const,
          id: 'see',
          content: [
            { type: 'xref' as const, module: 'charging' },
            { type: 'xref' as const, module: 'internals' },
            { type: 'xref' as const, module: 'nope' },
          ],
        },
      ],
    };
    const titles = async (lang: string) =>
      (
        await snap?.resolve('operating', { model: 'large' }, lang, {
          manifest,
          standIn: async (id, l) =>
            id === 'safety-note' && l === 'en' ? linking : undefined,
        })
      )?.manual.xrefTitles;
    // Read for the title only: the internal module stays an ID in a public manual.
    expect(await titles('en')).toEqual({ charging: 'Charging' });
    expect(await titles('de')).toEqual({ charging: 'Laden' });
    const hidden = await snap?.resolve('operating', { model: 'large' }, 'en', {
      manifest,
      standIn: async (id, l) =>
        id === 'safety-note' && l === 'en' ? linking : undefined,
      visible: (m) => m.id !== 'charging',
    });
    expect(hidden?.manual.xrefTitles).toEqual({});
    // A link is no inclusion: nothing is reported about the modules it names.
    expect(hidden?.issues.map((i) => i.module)).not.toContain('charging');
  });

  it('returns undefined for unknown manuals', async () => {
    expect(
      await (await repo.at('main'))?.resolve('nope', {}, 'en'),
    ).toBeUndefined();
  });
});

describe('parsed files', () => {
  it('parses a file once for every commit holding the same blob', async () => {
    const own = ContentRepo.open(dir);
    try {
      const [v1, main] = await Promise.all([own.at('v1'), own.at('main')]);
      const a = await v1?.module('safety-note', 'en');
      const b = await main?.module('safety-note', 'en');
      expect(a).toBeDefined();
      expect(b).toBe(a);
      // Changed between the two commits: two files, two parses.
      const c1 = await v1?.module('charging', 'en');
      const c2 = await main?.module('charging', 'en');
      expect(c2).not.toBe(c1);
      expect(c2?.meta.title).not.toBe(undefined);
    } finally {
      own.close();
    }
  });

  it('shares one parse between callers asking at once', async () => {
    const own = ContentRepo.open(dir);
    try {
      const main = await own.at('main');
      const all = await Promise.all(
        Array.from({ length: 8 }, () => main?.module('charging', 'en')),
      );
      expect(new Set(all).size).toBe(1);
      const errors = await Promise.all(
        Array.from({ length: 3 }, () =>
          (async () => (await own.at('draft'))?.module('broken', 'en'))().catch(
            (e: unknown) => e,
          ),
        ),
      );
      for (const e of errors) expect(e).toBeInstanceOf(ContentError);
      // Known missing: still missing, without asking git again.
      expect(await main?.module('nope', 'en')).toBeUndefined();
      expect(await main?.module('nope', 'en')).toBeUndefined();
    } finally {
      own.close();
    }
  });

  it('reads correctly with a cache too small to keep anything', async () => {
    const own = ContentRepo.open(dir, { parsedCacheBytes: 1 });
    try {
      const main = await own.at('main');
      const a = await main?.module('charging', 'en');
      const b = await main?.module('charging', 'en');
      expect(b).toEqual(a);
      expect(b).not.toBe(a);
    } finally {
      own.close();
    }
  });
});

describe('ref listings', () => {
  /** A git that logs each `for-each-ref` and takes 300 ms over it. */
  function slowListingGit(): { binary: string; log: string; dir: string } {
    const tools = mkdtempSync(join(tmpdir(), 'openfolia-slow-git-'));
    const log = join(tools, 'listings.log');
    const binary = join(tools, 'git');
    writeFileSync(
      binary,
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        `  if [ "$a" = for-each-ref ]; then echo x >> '${log}'; sleep 0.3; fi`,
        'done',
        'exec git "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(binary, 0o755);
    writeFileSync(log, '');
    return { binary, log, dir: tools };
  }
  const listings = (log: string) =>
    readFileSync(log, 'utf8').split('\n').filter(Boolean).length;

  it('shares one listing between callers asking at once', async () => {
    const slow = slowListingGit();
    const git = new GitRepo(dir, slow.binary);
    try {
      const [a, b, main] = await Promise.all([
        git.refs(),
        git.refs(),
        git.resolveRef('main'),
      ]);
      expect(b).toEqual(a);
      expect(main).toBe(commits.main);
      expect(listings(slow.log)).toBe(1);
      // Done: the next caller lists again.
      await git.refs();
      expect(listings(slow.log)).toBe(2);
    } finally {
      git.close();
      rmSync(slow.dir, { recursive: true, force: true });
    }
  });

  it('never shares a listing begun before it was told to forget it (another process wrote)', async () => {
    const bare = createBareSampleRepo();
    const slow = slowListingGit();
    const git = new GitRepo(bare.dir, slow.binary);
    try {
      const before = git.refs();
      git.forgetListings();
      const after = git.refs();
      // Shared again from then on.
      const shared = git.refs();
      await Promise.all([before, after, shared]);
      expect(listings(slow.log)).toBe(2);
    } finally {
      git.close();
      rmSync(bare.dir, { recursive: true, force: true });
      rmSync(slow.dir, { recursive: true, force: true });
    }
  });

  it('never shares a listing begun before a write of this process', async () => {
    const bare = createBareSampleRepo();
    const slow = slowListingGit();
    const git = new GitRepo(bare.dir, slow.binary);
    try {
      const before = git.refs();
      await new GitWriter(bare.dir).createBranch('fresh', bare.commits.main);
      // The listing begun before the write may not know the branch; one
      // asked for after it must.
      expect(await git.resolveRef('fresh')).toBe(bare.commits.main);
      await before;
      expect(listings(slow.log)).toBe(2);
    } finally {
      git.close();
      rmSync(bare.dir, { recursive: true, force: true });
      rmSync(slow.dir, { recursive: true, force: true });
    }
  });
});
