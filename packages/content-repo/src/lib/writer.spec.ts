import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBareSampleRepo,
  createSampleRepo,
  PNG,
  PNG_HASH,
} from '../testing.js';
import { GitRepo } from './git.js';
import { ContentRepo } from './snapshot.js';
import {
  GitWriter,
  isWritablePath,
  RefConflictError,
  WriteError,
  type CommitRequest,
} from './writer.js';

// Git runs a process per step; on a loaded machine that adds up.
vi.setConfig({ testTimeout: 30_000 });

const IMAGE = Buffer.from('another image');
const IMAGE_HASH = createHash('sha256').update(IMAGE).digest('hex');
const ACTOR = { name: 'Ada Author', email: 'ada@example.com' };
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

/** A new sample repository with a working tree. */
function sample() {
  const repo = createSampleRepo();
  cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
  return repo;
}

/**
 * A bare copy of the sample (what the API runs on), new for each test, so
 * no test depends on another's writes: copied, with no `git clone` of its
 * own (#727).
 */
function bareSample() {
  const repo = createBareSampleRepo();
  cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
  return repo;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function request(
  parent: string | null,
  changes: CommitRequest['changes'],
  more: Partial<CommitRequest> = {},
): CommitRequest {
  return {
    branch: 'main',
    parent,
    changes,
    message: 'Edit',
    author: ACTOR,
    ...more,
  };
}

describe('commit', () => {
  it('writes, replaces and deletes files on top of the parent', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const { commit, tree } = await writer.commit(
      request(commits.main, [
        { path: 'modules/en/new.adoc', content: 'new\n' },
        { path: 'openfolia.yaml', content: 'changed: true\n' },
        { path: 'modules/en/internals.adoc', delete: true },
        { path: `assets/${IMAGE_HASH}`, content: IMAGE },
      ]),
    );
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(commit);
    expect(git(dir, 'rev-parse', `${commit}^{tree}`)).toBe(tree);
    expect(git(dir, 'rev-parse', `${commit}^`)).toBe(commits.main);
    expect(git(dir, 'show', `${commit}:modules/en/new.adoc`)).toBe('new');
    expect(git(dir, 'show', `${commit}:openfolia.yaml`)).toBe('changed: true');
    expect(
      git(dir, 'ls-tree', '-r', '--name-only', commit, 'modules/en/'),
    ).toBe(
      [
        'modules/en/charging.adoc',
        'modules/en/new.adoc',
        'modules/en/safety-note.adoc',
      ].join('\n'),
    );
    // Untouched entries keep their objects.
    expect(git(dir, 'rev-parse', `${commit}:assets/${PNG_HASH}`)).toBe(
      git(dir, 'rev-parse', `${commits.main}:assets/${PNG_HASH}`),
    );
    expect(git(dir, 'rev-parse', `${commit}:modules/de`)).toBe(
      git(dir, 'rev-parse', `${commits.main}:modules/de`),
    );
    expect(
      execFileSync('git', [
        '-C',
        dir,
        'cat-file',
        'blob',
        `${commit}:assets/${IMAGE_HASH}`,
      ]),
    ).toEqual(IMAGE);
  });

  it('removes folders that end up empty', async () => {
    const { dir, commits } = bareSample();
    const { commit } = await new GitWriter(dir).commit(
      request(commits.main, [
        { path: 'modules/de/charging.adoc', delete: true },
        { path: 'modules/de/charging.translation.yaml', delete: true },
      ]),
    );
    expect(git(dir, 'ls-tree', '--name-only', commit, 'modules/')).toBe(
      'modules/en',
    );
  });

  it('records author, committer, date and trailers', async () => {
    const { dir, commits } = bareSample();
    const { commit } = await new GitWriter(dir).commit(
      request(commits.main, [{ path: 'openfolia.yaml', content: 'x: 1\n' }], {
        message: 'Update the configuration\n\nWhy it changed.',
        committer: { name: 'OpenFolia', email: 'openfolia@example.com' },
        date: new Date('2026-01-02T03:04:05Z'),
        trailers: [
          { key: 'Approved-by', value: 'One <one@example.com>' },
          { key: 'Approved-by', value: 'Two <two@example.com>' },
          { key: 'Change-set', value: '42' },
        ],
      }),
    );
    expect(
      git(dir, 'log', '-1', '--format=%an|%ae|%cn|%ce|%at|%ct', commit),
    ).toBe(
      'Ada Author|ada@example.com|OpenFolia|openfolia@example.com|1767323045|1767323045',
    );
    expect(git(dir, 'log', '-1', '--format=%B', commit)).toBe(
      'Update the configuration\n\nWhy it changed.\n\n' +
        'Approved-by: One <one@example.com>\n' +
        'Approved-by: Two <two@example.com>\n' +
        'Change-set: 42',
    );
    expect(
      git(
        dir,
        'log',
        '-1',
        '--format=%(trailers:key=Approved-by,valueonly,separator=%x2C)',
        commit,
      ),
    ).toBe('One <one@example.com>,Two <two@example.com>');
  });

  it.each([
    'Edit\n\nApproved-by: Mallory <m@example.com>',
    'Edit\n\nSome text.\nSigned-off-by: x\nApproved-by: Mallory',
    'Edit\n\nApproved-by: Mallory\n\n# a comment line',
    'Edit\n\nApproved-by: Mallory\n---\nmore',
    'Edit\n\nApproved-by : Mallory',
    'Edit\n\nApproved-by: Mallory\n \t\n',
  ])('refuses a body git would read as trailers: %j', async (message) => {
    const { dir, commits } = bareSample();
    for (const trailers of [[], [{ key: 'Change-set', value: '1' }]]) {
      await expect(
        new GitWriter(dir).commit(
          request(
            commits.main,
            [{ path: 'openfolia.yaml', content: 'a: 1\n' }],
            {
              message,
              trailers,
            },
          ),
        ),
      ).rejects.toMatchObject({ name: 'WriteError', code: 'invalid-message' });
    }
    expect(git(dir, 'rev-parse', 'main')).toBe(commits.main);
  });

  it('takes trailers only from the trailers argument', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    let parent = commits.main;
    for (const [i, message] of [
      'Fix: typo',
      'Fix: typo\nApproved-by: in the subject paragraph',
      'Edit\n\nApproved-by: Mallory, in prose.\nAnd more prose.',
    ].entries()) {
      const { commit } = await writer.commit(
        request(parent, [{ path: 'openfolia.yaml', content: `n: ${i}\n` }], {
          message,
          trailers: [{ key: 'Approved-by', value: 'Real <r@example.com>' }],
        }),
      );
      parent = commit;
      const parsed = execFileSync(
        'git',
        ['-C', dir, 'interpret-trailers', '--parse'],
        { input: git(dir, 'log', '-1', '--format=%B', commit) + '\n' },
      )
        .toString()
        .trim();
      expect(parsed).toBe('Approved-by: Real <r@example.com>');
    }
  });

  it('records identities as git does and returns them as recorded', async () => {
    const { dir, commits } = bareSample();
    const result = await new GitWriter(dir).commit(
      request(commits.main, [{ path: 'openfolia.yaml', content: 'a: 1\n' }], {
        author: { name: ' Ada Smith Jr. ', email: '"ada@example.com"' },
        committer: { name: "'t Hart", email: 'hart@example.com' },
      }),
    );
    expect(result.author).toEqual({
      name: 'Ada Smith Jr',
      email: 'ada@example.com',
    });
    expect(result.committer).toEqual({
      name: 't Hart',
      email: 'hart@example.com',
    });
    expect(
      git(dir, 'log', '-1', '--format=%an|%ae|%cn|%ce', result.commit),
    ).toBe('Ada Smith Jr|ada@example.com|t Hart|hart@example.com');
  });

  it('makes the first commit of a new branch with parent null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfolia-empty-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    git(dir, 'init', '-q', '--bare', '-b', 'main');
    const writer = new GitWriter(dir);
    const { commit } = await writer.commit(
      request(null, [{ path: 'openfolia.yaml', content: 'a: 1\n' }]),
    );
    expect(git(dir, 'rev-parse', 'main')).toBe(commit);
    expect(git(dir, 'rev-list', '--count', 'main')).toBe('1');
    // A second "first commit" is a conflict, not an overwrite.
    await expect(
      writer.commit(
        request(null, [{ path: 'openfolia.yaml', content: 'b: 2\n' }]),
      ),
    ).rejects.toBeInstanceOf(RefConflictError);
    expect(git(dir, 'rev-parse', 'main')).toBe(commit);
  });

  it('refuses a stale parent with a typed conflict and leaves the branch alone', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const first = await writer.commit(
      request(commits.main, [{ path: 'openfolia.yaml', content: 'a: 1\n' }]),
    );
    const error = await writer
      .commit(
        request(commits.main, [{ path: 'openfolia.yaml', content: 'b: 2\n' }]),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefConflictError);
    expect(error).toMatchObject({
      ref: 'refs/heads/main',
      expected: commits.main,
      actual: first.commit,
    });
    expect(git(dir, 'rev-parse', 'main')).toBe(first.commit);
  });

  it('refuses a parent on a branch that does not exist', async () => {
    const { dir, commits } = bareSample();
    await expect(
      new GitWriter(dir).commit(
        request(commits.main, [{ path: 'openfolia.yaml', content: 'a\n' }], {
          branch: 'nope',
        }),
      ),
    ).rejects.toMatchObject({ name: 'RefConflictError', actual: undefined });
    expect(git(dir, 'branch', '--list', 'nope')).toBe('');
  });

  it('refuses changes that change nothing', async () => {
    const { dir, commits } = bareSample();
    const same = git(dir, 'show', `${commits.main}:openfolia.yaml`) + '\n';
    await expect(
      new GitWriter(dir).commit(
        request(commits.main, [{ path: 'openfolia.yaml', content: same }]),
      ),
    ).rejects.toMatchObject({ code: 'no-changes' });
    await expect(
      new GitWriter(dir).commit(request(commits.main, [])),
    ).rejects.toMatchObject({ code: 'no-changes' });
  });

  it.each([
    ['../openfolia.yaml', 'invalid-path'],
    ['modules/../openfolia.yaml', 'invalid-path'],
    ['/etc/passwd', 'invalid-path'],
    ['.git/config', 'invalid-path'],
    ['modules/.git/config', 'invalid-path'],
    ['modules/en/.hidden', 'invalid-path'],
    ['modules\\en\\x.adoc', 'invalid-path'],
    ['modules//x.adoc', 'invalid-path'],
    ['modules/en/', 'invalid-path'],
    ['modules', 'invalid-path'],
    ['README.md', 'invalid-path'],
    ['templates/other.typ', 'invalid-path'],
    ['templates/House/manual.typ', 'invalid-path'],
    ['templates/house/.hidden.typ', 'invalid-path'],
    ['templates/house/../manual.typ', 'invalid-path'],
    ['templates/house/', 'invalid-path'],
    [`templates/house/${'a/'.repeat(9)}x.typ`, 'invalid-path'],
    ['src/evil.js', 'invalid-path'],
    [`modules/${'a'.repeat(256)}`, 'invalid-path'],
  ])('refuses the path %s', async (path, code) => {
    expect(isWritablePath(path)).toBe(false);
    const { dir, commits } = bareSample();
    await expect(
      new GitWriter(dir).commit(
        request(commits.main, [{ path, content: 'x' }]),
      ),
    ).rejects.toMatchObject({ name: 'WriteError', code });
    expect(git(dir, 'rev-parse', 'main')).toBe(commits.main);
  });

  it('accepts the layout paths', () => {
    for (const path of [
      'openfolia.yaml',
      'templates/manual.typ',
      'templates/house/manual.typ',
      'templates/house/parts/notice.typ',
      'templates/house/logo.png',
      'modules/en/x.adoc',
      'manuals/m.yaml',
      'terms/charger.yaml',
      `assets/${PNG_HASH}`,
      'symbols/w002.svg',
    ]) {
      expect(isWritablePath(path)).toBe(true);
    }
  });

  it('refuses path conflicts, duplicates and deletes of missing files', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const refused = (changes: CommitRequest['changes']) =>
      writer
        .commit(request(commits.main, changes))
        .catch((e: WriteError) => e.code);
    expect(
      await refused([{ path: 'modules/en/charging.adoc/x', content: 'x' }]),
    ).toBe('path-conflict');
    expect(await refused([{ path: 'modules/en', content: 'x' }])).toBe(
      'path-conflict',
    );
    expect(
      await refused([
        { path: 'modules/en/a', content: 'x' },
        { path: 'modules/en/a/b', content: 'x' },
      ]),
    ).toBe('path-conflict');
    expect(
      await refused([
        { path: 'modules/en/a', content: 'x' },
        { path: 'modules/en/a', delete: true },
      ]),
    ).toBe('duplicate-path');
    expect(
      await refused([{ path: 'modules/en/nope.adoc', delete: true }]),
    ).toBe('not-found');
    expect(await refused([{ path: 'modules/en', delete: true }])).toBe(
      'path-conflict',
    );
    expect(git(dir, 'rev-parse', 'main')).toBe(commits.main);
  });

  it('refuses symlinks on the way to a path', async () => {
    const { dir, commits } = bareSample();
    // A commit whose `modules/link` is a symlink to `..`.
    const link = execFileSync(
      'git',
      ['-C', dir, 'hash-object', '-w', '--stdin'],
      { input: '..' },
    )
      .toString()
      .trim();
    const modules = git(dir, 'rev-parse', `${commits.main}:modules`);
    const withLink = execFileSync('git', ['-C', dir, 'mktree'], {
      input: git(dir, 'ls-tree', modules) + `\n120000 blob ${link}\tlink\n`,
    })
      .toString()
      .trim();
    const root = execFileSync('git', ['-C', dir, 'mktree'], {
      input: git(dir, 'ls-tree', commits.main)
        .split('\n')
        .map((l) =>
          l.endsWith('\tmodules') ? `040000 tree ${withLink}\tmodules` : l,
        )
        .join('\n'),
    })
      .toString()
      .trim();
    const parent = git(
      dir,
      'commit-tree',
      root,
      '-p',
      commits.main,
      '-m',
      'link',
    );
    git(dir, 'update-ref', 'refs/heads/main', parent, commits.main);

    await expect(
      new GitWriter(dir).commit(
        request(parent, [
          { path: 'modules/link/openfolia.yaml', content: 'x' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'path-conflict' });
    // Writing over the link replaces it with a regular file.
    const { commit } = await new GitWriter(dir).commit(
      request(parent, [{ path: 'modules/link', content: 'file' }]),
    );
    expect(git(dir, 'ls-tree', commit, 'modules/link')).toMatch(
      /^100644 blob /,
    );
  });

  it('keeps untouched entries with names that are not UTF-8', async () => {
    const { dir, commits } = bareSample();
    const blob = execFileSync(
      'git',
      ['-C', dir, 'hash-object', '-w', '--stdin'],
      {
        input: 'x',
      },
    )
      .toString()
      .trim();
    const enTree = git(dir, 'rev-parse', `${commits.main}:modules/en`);
    // A name with a latin1 byte (0xE9), as an old import might have left.
    const listing = execFileSync('git', ['-C', dir, 'ls-tree', '-z', enTree]);
    const withOdd = Buffer.concat([
      listing,
      Buffer.from(`100644 blob ${blob}\t`),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x00]),
    ]);
    const newEn = execFileSync('git', ['-C', dir, 'mktree', '-z'], {
      input: withOdd,
    })
      .toString()
      .trim();
    const modules = execFileSync('git', ['-C', dir, 'mktree'], {
      input: git(dir, 'ls-tree', `${commits.main}:modules`).replace(
        /tree \S+\ten$/m,
        `tree ${newEn}\ten`,
      ),
    })
      .toString()
      .trim();
    const root = execFileSync('git', ['-C', dir, 'mktree'], {
      input: git(dir, 'ls-tree', commits.main).replace(
        /tree \S+\tmodules$/m,
        `tree ${modules}\tmodules`,
      ),
    })
      .toString()
      .trim();
    const parent = git(
      dir,
      'commit-tree',
      root,
      '-p',
      commits.main,
      '-m',
      'odd',
    );
    git(dir, 'update-ref', 'refs/heads/main', parent, commits.main);

    const { commit } = await new GitWriter(dir).commit(
      request(parent, [{ path: 'modules/en/added.adoc', content: 'a' }]),
    );
    const names = execFileSync('git', [
      '-C',
      dir,
      'ls-tree',
      '-z',
      '--name-only',
      `${commit}:modules/en`,
    ]);
    expect(names.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x00]))).toBe(
      true,
    );
  });

  it('refuses changes that are not exactly a write or a delete', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    for (const change of [
      { path: 'openfolia.yaml', content: 'x', delete: false },
      { path: 'openfolia.yaml', content: 'x', delete: true },
      { path: 'openfolia.yaml', delete: false },
      { path: 'openfolia.yaml' },
      { path: 'openfolia.yaml', content: 42 },
    ]) {
      await expect(
        writer.commit(
          request(commits.main, [
            change as unknown as CommitRequest['changes'][0],
          ]),
        ),
      ).rejects.toMatchObject({ code: 'invalid-change' });
    }
    expect(git(dir, 'rev-parse', 'main')).toBe(commits.main);
  });

  it('keeps assets content-addressed', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    await expect(
      writer.commit(
        request(commits.main, [
          { path: `assets/${'b'.repeat(64)}`, content: PNG },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'invalid-asset' });
    await expect(
      writer.commit(
        request(commits.main, [{ path: 'assets/x.png', content: PNG }]),
      ),
    ).rejects.toMatchObject({ code: 'invalid-path' });
    // Deleting an asset needs no content to check.
    await writer.commit(
      request(commits.main, [{ path: `assets/${PNG_HASH}`, delete: true }]),
    );
  });

  it('refuses an annotated tag as parent', async () => {
    const { dir } = bareSample();
    const tag = git(dir, 'rev-parse', 'refs/tags/v1');
    await expect(
      new GitWriter(dir).commit(
        request(tag, [{ path: 'openfolia.yaml', content: 'x\n' }], {
          branch: 'v1x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-commit' });
  });

  it('enforces size and count limits', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir, {
      limits: { maxFileBytes: 10, maxCommitBytes: 15, maxChanges: 2 },
    });
    const code = (changes: CommitRequest['changes']) =>
      writer
        .commit(request(commits.main, changes))
        .catch((e: WriteError) => e.code);
    expect(
      await code([{ path: 'modules/en/a', content: 'x'.repeat(11) }]),
    ).toBe('too-large');
    expect(
      await code([
        { path: 'modules/en/a', content: 'x'.repeat(10) },
        { path: 'modules/en/b', content: 'x'.repeat(10) },
      ]),
    ).toBe('too-large');
    expect(
      await code([
        { path: 'modules/en/a', content: 'a' },
        { path: 'modules/en/b', content: 'b' },
        { path: 'modules/en/c', content: 'c' },
      ]),
    ).toBe('too-many-changes');
  });

  it.each([
    [
      { author: { name: 'Eve <x@y>', email: 'eve@example.com' } },
      'invalid-identity',
    ],
    [
      { author: { name: 'Eve\nX', email: 'eve@example.com' } },
      'invalid-identity',
    ],
    [{ author: { name: '', email: 'eve@example.com' } }, 'invalid-identity'],
    [
      { author: { name: 'Eve', email: 'eve>@example.com' } },
      'invalid-identity',
    ],
    [{ author: { name: 'Eve', email: 'not an email' } }, 'invalid-identity'],
    [{ committer: { name: 'Eve', email: '' } }, 'invalid-identity'],
    [{ message: '  ' }, 'invalid-message'],
    [{ message: 'a\0b' }, 'invalid-message'],
    [{ trailers: [{ key: 'Bad Key', value: 'x' }] }, 'invalid-trailer'],
    [
      { trailers: [{ key: 'Key', value: 'x\nInjected: y' }] },
      'invalid-trailer',
    ],
    [
      { trailers: [{ key: 'Key', value: 'x\rInjected: y' }] },
      'invalid-trailer',
    ],
    [{ trailers: [{ key: 'Key\nX', value: 'x' }] }, 'invalid-trailer'],
    [{ message: 'Edit\u000bbody' }, 'invalid-message'],
    [{ branch: 'refs/heads/main' }, 'invalid-ref'],
    [{ branch: 'foo.' }, 'invalid-ref'],
    [{ branch: 'deadbeef' }, 'invalid-ref'],
    [{ branch: 'cafe123' }, 'invalid-ref'],
    [{ author: { name: '...', email: 'a@example.com' } }, 'invalid-identity'],
    [{ author: { name: 'Ada', email: '"@"' } }, 'invalid-identity'],
    [{ branch: 'a./b' }, 'invalid-ref'],
    [{ branch: 'refs/tags/v1' }, 'invalid-ref'],
    [{ trailers: [{ key: 'Key', value: ' ' }] }, 'invalid-trailer'],
    [{ branch: '--force' }, 'invalid-ref'],
    [{ branch: 'main~1' }, 'invalid-ref'],
    [{ branch: 'HEAD' }, 'invalid-ref'],
    [{ branch: 'a/.b' }, 'invalid-ref'],
    [{ branch: 'a.lock/b' }, 'invalid-ref'],
    [{ branch: 'f'.repeat(40) }, 'invalid-ref'],
    [{ parent: 'main' }, 'invalid-commit'],
    [{ parent: 'f'.repeat(40) }, 'invalid-commit'],
    // A tree ID, not a commit.
    [{ parent: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }, 'invalid-commit'],
  ] as [Partial<CommitRequest>, string][])(
    'refuses invalid input %j',
    async (more, code) => {
      const { dir, commits } = bareSample();
      await expect(
        new GitWriter(dir).commit(
          request(
            commits.main,
            [{ path: 'openfolia.yaml', content: 'a: 1\n' }],
            more,
          ),
        ),
      ).rejects.toMatchObject({ name: 'WriteError', code });
      expect(git(dir, 'rev-parse', 'main')).toBe(commits.main);
    },
  );

  it('never touches the working tree or the index', async () => {
    const { dir, commits } = sample();
    // Local, uncommitted state in the checkout: a staged and an unstaged edit.
    writeFileSync(join(dir, 'openfolia.yaml'), 'staged: true\n');
    git(dir, 'add', 'openfolia.yaml');
    writeFileSync(join(dir, 'manuals/operating.yaml'), 'unstaged: true\n');
    const snapshot = () => ({
      index: createHash('sha256')
        .update(readFileSync(join(dir, '.git/index')))
        .digest('hex'),
      files: git(dir, 'ls-files', '-s'),
      config: readFileSync(join(dir, 'openfolia.yaml'), 'utf8'),
      manual: readFileSync(join(dir, 'manuals/operating.yaml'), 'utf8'),
      untracked: git(dir, 'ls-files', '--others', '--exclude-standard'),
    });
    const before = snapshot();

    const writer = new GitWriter(dir);
    const { commit } = await writer.commit(
      request(
        commits.draft,
        [
          { path: 'openfolia.yaml', content: 'written: true\n' },
          { path: 'modules/en/added.adoc', content: 'added\n' },
        ],
        { branch: 'draft' },
      ),
    );
    await writer.createBranch('side', commit);
    await writer.deleteBranch('side', commit);

    expect(git(dir, 'rev-parse', 'draft')).toBe(commit);
    expect(snapshot()).toEqual(before);
  });

  it('refuses to move or delete a branch checked out in a worktree', async () => {
    const { dir, commits } = sample();
    const writer = new GitWriter(dir);
    await expect(
      writer.commit(
        request(commits.main, [{ path: 'openfolia.yaml', content: 'x\n' }]),
      ),
    ).rejects.toMatchObject({ code: 'checked-out' });
    const linked = mkdtempSync(join(tmpdir(), 'openfolia-wt-'));
    cleanups.push(() => rmSync(linked, { recursive: true, force: true }));
    git(dir, 'worktree', 'add', '-q', join(linked, 'wt'), 'draft');
    await expect(
      writer.deleteBranch('draft', commits.draft),
    ).rejects.toMatchObject({ code: 'checked-out' });
    expect(git(dir, 'rev-parse', 'main')).toBe(commits.main);
    expect(git(dir, 'rev-parse', 'draft')).toBe(commits.draft);
  });

  it('never reads or writes a repository above a folder that is not one', async () => {
    const { dir, commits } = sample();
    const reader = ContentRepo.open(join(dir, 'modules'));
    cleanups.push(() => reader.close());
    await expect(reader.at('draft')).rejects.toThrow(/not a git repository/i);
    const writer = new GitWriter(join(dir, 'modules'));
    await expect(
      writer.commit(
        request(commits.draft, [{ path: 'openfolia.yaml', content: 'x\n' }], {
          branch: 'draft',
        }),
      ),
    ).rejects.toThrow(/not a git repository/i);
    expect(git(dir, 'rev-parse', 'draft')).toBe(commits.draft);
  });

  it('is visible to readers right after the ref moves', async () => {
    const { dir, commits } = bareSample();
    const reader = ContentRepo.open(dir);
    cleanups.push(() => reader.close());
    // Start the reader's long-running cat-file process before the write.
    expect(await (await reader.at('main'))?.manifests()).toEqual([
      'operating',
      'service',
    ]);
    expect((await reader.at('main'))?.commit).toBe(commits.main);

    const manual = git(dir, 'show', `${commits.main}:manuals/operating.yaml`);
    const { commit } = await new GitWriter(dir).commit(
      request(commits.main, [
        {
          path: 'manuals/operating.yaml',
          content: manual.replace('Operating manual', 'Written manual') + '\n',
        },
      ]),
    );
    const snap = await reader.at('main');
    expect(snap?.commit).toBe(commit);
    expect((await snap?.manifest('operating'))?.title).toBe('Written manual');
  });
});

describe('prepareCommit and commitPrepared', () => {
  it('builds the tree first, moving nothing, then commits exactly that tree', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const change = [{ path: 'openfolia.yaml', content: 'prepared: true\n' }];
    const { tree } = await writer.prepareCommit(request(commits.main, change));
    expect(git(dir, 'cat-file', '-t', tree)).toBe('tree');
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(commits.main);
    // The same changes on the same parent make the same tree.
    expect(
      (await writer.prepareCommit(request(commits.main, change))).tree,
    ).toBe(tree);
    const made = await writer.commitPrepared({
      ...request(commits.main, []),
      tree,
    });
    expect(made.tree).toBe(tree);
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(made.commit);
    expect(git(dir, 'rev-parse', `${made.commit}^{tree}`)).toBe(tree);

    const [entry] = await new GitRepo(dir).history(made.commit, 1);
    expect(entry).toMatchObject({
      commit: made.commit,
      parent: commits.main,
      parents: 1,
      tree,
    });
  });

  it('checks the request before writing anything, as commit does', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const change = [{ path: 'openfolia.yaml', content: 'x: 1\n' }];
    await expect(
      writer.prepareCommit(
        request(commits.main, change, { message: 'Edit\n\nApproved-by: M' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-message' });
    await expect(
      writer.prepareCommit(request(commits.main, [])),
    ).rejects.toMatchObject({ code: 'no-changes' });
    await expect(
      writer.prepareCommit(request(commits.main, change, { branch: 'a..b' })),
    ).rejects.toMatchObject({ code: 'invalid-ref' });
  });

  it('refuses a stale parent, a tree that is none and an unchanged tree', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const { tree } = await writer.prepareCommit(
      request(commits.main, [{ path: 'openfolia.yaml', content: 'y: 1\n' }]),
    );
    await writer.commit(
      request(commits.main, [{ path: 'openfolia.yaml', content: 'z: 1\n' }]),
    );
    await expect(
      writer.commitPrepared({ ...request(commits.main, []), tree }),
    ).rejects.toBeInstanceOf(RefConflictError);
    const head = git(dir, 'rev-parse', 'refs/heads/main');
    await expect(
      writer.commitPrepared({ ...request(head, []), tree: head }),
    ).rejects.toMatchObject({ code: 'invalid-commit' });
    await expect(
      writer.commitPrepared({
        ...request(head, []),
        tree: git(dir, 'rev-parse', `${head}^{tree}`),
      }),
    ).rejects.toMatchObject({ code: 'no-changes' });
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(head);
  });
});

describe('branches', () => {
  it('refuses a new branch named like a tag, however it is made', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    await expect(writer.createBranch('v1', commits.main)).rejects.toMatchObject(
      {
        code: 'invalid-ref',
      },
    );
    await expect(
      writer.commit(
        request(null, [{ path: 'openfolia.yaml', content: 'a: 1\n' }], {
          branch: 'v1',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-ref' });
    expect(
      git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/v1'),
    ).toBe('');
  });

  it('changes a ref only by its exact name', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    // Another case of an existing name is a different, missing ref, never
    // an alias (on a case-insensitive file system it would be one).
    await expect(
      writer.deleteBranch('DRAFT', commits.draft),
    ).rejects.toMatchObject({
      name: 'RefConflictError',
      actual: undefined,
    });
    await expect(
      writer.commit(
        request(commits.main, [{ path: 'openfolia.yaml', content: 'x\n' }], {
          branch: 'Main',
        }),
      ),
    ).rejects.toBeInstanceOf(RefConflictError);
    for (const name of ['Main', 'V1', 'main/x', 'draft/sub']) {
      await expect(
        writer.createBranch(name, commits.main),
      ).rejects.toMatchObject({
        code: 'invalid-ref',
      });
    }
    await writer.createBranch('feature/x', commits.main);
    await expect(
      writer.createBranch('feature', commits.main),
    ).rejects.toMatchObject({ code: 'invalid-ref' });
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(commits.main);
  });

  it('refuses hex branch names the reader would read as commit IDs', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    for (const name of ['cafe123', 'f'.repeat(40), 'a'.repeat(64)]) {
      await expect(
        writer.createBranch(name, commits.main),
      ).rejects.toMatchObject({ code: 'invalid-ref' });
    }
    // Shorter, or longer than any ID, they are plain names.
    await writer.createBranch('cafe12', commits.main);
    await writer.createBranch('a'.repeat(65), commits.main);
    const reader = ContentRepo.open(dir);
    cleanups.push(() => reader.close());
    expect((await reader.at('cafe12'))?.commit).toBe(commits.main);
  });

  it('refuses to move or delete through a symbolic ref', async () => {
    const { dir, commits } = bareSample();
    git(dir, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/draft');
    const writer = new GitWriter(dir);
    await expect(
      writer.deleteBranch('alias', commits.draft),
    ).rejects.toMatchObject({
      code: 'invalid-ref',
    });
    await expect(
      writer.commit(
        request(commits.draft, [{ path: 'openfolia.yaml', content: 'x\n' }], {
          branch: 'alias',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-ref' });
    expect(git(dir, 'rev-parse', 'refs/heads/draft')).toBe(commits.draft);
    expect(git(dir, 'symbolic-ref', 'refs/heads/alias')).toBe(
      'refs/heads/draft',
    );
  });

  it('matches a 40-character ID in a SHA-256 repository against objects only', async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'openfolia-sha256-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    try {
      git(dir, 'init', '-q', '--bare', '--object-format=sha256', '-b', 'main');
    } catch (e) {
      // Skip only where this git has no SHA-256 support.
      const stderr = String((e as { stderr?: unknown }).stderr ?? '');
      if (!/object.format|sha256/i.test(stderr)) throw e;
      ctx.skip();
    }
    const writer = new GitWriter(dir);
    const first = await writer.commit(
      request(null, [{ path: 'openfolia.yaml', content: 'a: 1\n' }]),
    );
    const second = await writer.commit(
      request(first.commit, [{ path: 'openfolia.yaml', content: 'a: 2\n' }]),
    );
    expect(second.commit).toMatch(/^[0-9a-f]{64}$/);
    const prefix = second.commit.slice(0, 40);
    git(dir, 'update-ref', `refs/${prefix}`, first.commit);
    const reader = ContentRepo.open(dir);
    cleanups.push(() => reader.close());
    expect((await reader.at(prefix))?.commit).toBe(second.commit);
    expect((await reader.at(second.commit))?.commit).toBe(second.commit);
  });

  it('refuses to delete a configured protected branch', async () => {
    const { dir, commits } = bareSample();
    await expect(
      new GitWriter(dir, { protectedBranches: ['draft'] }).deleteBranch(
        'draft',
        commits.draft,
      ),
    ).rejects.toMatchObject({ code: 'protected-ref' });
    expect(git(dir, 'rev-parse', 'draft')).toBe(commits.draft);
  });

  it('lets readers resolve a branch and a tag of the same name without ambiguity', async () => {
    const { dir, commits } = bareSample();
    // Made outside the writer, as an import or a push might.
    git(dir, 'update-ref', 'refs/heads/v1', commits.draft);
    const reader = ContentRepo.open(dir);
    cleanups.push(() => reader.close());
    expect((await reader.at('v1'))?.commit).toBe(commits.draft);
    expect((await reader.at('main'))?.commit).toBe(commits.main);
    expect((await reader.at('HEAD'))?.commit).toBe(commits.main);
    expect((await reader.at(commits.v1))?.commit).toBe(commits.v1);
    expect((await reader.at(commits.v1.slice(0, 10)))?.commit).toBe(commits.v1);
    expect((await reader.at('refs/heads/v1'))?.commit).toBe(commits.draft);
    expect((await reader.at('refs/tags/v1'))?.commit).toBe(commits.v1);
    expect(await reader.at('refs/remotes/v1')).toBeUndefined();
    // An abbreviation is an object prefix only, never a ref of that name.
    const prefix = commits.main.slice(0, 12);
    git(dir, 'update-ref', `refs/remotes/${prefix}`, commits.v1);
    git(dir, 'update-ref', `refs/${prefix}`, commits.v1);
    expect((await reader.at(prefix))?.commit).toBe(commits.main);
    expect(await reader.at('0000ffff')).toBeUndefined();
    expect((await reader.at(commits.main.slice(0, 7)))?.commit).toBe(
      commits.main,
    );
    // Shorter is a name only: a missing hex-named branch is not found.
    expect(await reader.at(commits.main.slice(0, 6))).toBeUndefined();
    expect(await reader.at(commits.main.slice(0, 4))).toBeUndefined();
    // A full ID is matched against objects too, never a ref of that name.
    git(dir, 'update-ref', `refs/${commits.main}`, commits.v1);
    expect((await reader.at(commits.main))?.commit).toBe(commits.main);
    // A tag with no branch of that name still resolves (peeled).
    git(dir, 'update-ref', '-d', 'refs/heads/v1');
    expect((await reader.at('v1'))?.commit).toBe(commits.v1);
  });

  it('creates a branch only if it does not exist', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    await writer.createBranch('feature/x', commits.v1);
    expect(git(dir, 'rev-parse', 'feature/x')).toBe(commits.v1);
    await expect(
      writer.createBranch('feature/x', commits.main),
    ).rejects.toMatchObject({
      name: 'RefConflictError',
      expected: undefined,
      actual: commits.v1,
    });
    expect(git(dir, 'rev-parse', 'feature/x')).toBe(commits.v1);
  });

  it('refuses a branch at a missing commit or named like a tag', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    await expect(
      writer.createBranch('x', 'f'.repeat(40)),
    ).rejects.toMatchObject({ code: 'invalid-commit' });
    const tree = git(dir, 'rev-parse', `${commits.main}^{tree}`);
    await expect(writer.createBranch('x', tree)).rejects.toMatchObject({
      code: 'invalid-commit',
    });
    await expect(writer.createBranch('v1', commits.main)).rejects.toMatchObject(
      {
        code: 'invalid-ref',
      },
    );
  });

  it('deletes a branch only if it still points where the caller expects', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    await expect(
      writer.deleteBranch('draft', commits.main),
    ).rejects.toMatchObject({
      name: 'RefConflictError',
      expected: commits.main,
      actual: commits.draft,
    });
    expect(git(dir, 'rev-parse', 'draft')).toBe(commits.draft);
    await writer.deleteBranch('draft', commits.draft);
    expect(git(dir, 'branch', '--list', 'draft')).toBe('');
    await expect(
      writer.deleteBranch('draft', commits.draft),
    ).rejects.toMatchObject({ name: 'RefConflictError', actual: undefined });
  });

  it('refuses to delete the default branch', async () => {
    const { dir, commits } = bareSample();
    await expect(
      new GitWriter(dir).deleteBranch('main', commits.main),
    ).rejects.toMatchObject({ code: 'protected-ref' });
    expect(git(dir, 'rev-parse', 'main')).toBe(commits.main);
  });
});

describe('concurrent writers', () => {
  const N = 16;

  it('let exactly one of N writers on the same parent win; the rest get conflicts', async () => {
    const { dir, commits } = bareSample();
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        new GitWriter(dir).commit(
          request(commits.main, [
            { path: `modules/en/w${i}.adoc`, content: `writer ${i}\n` },
          ]),
        ),
      ),
    );
    const won = results.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    const lost = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason] : [],
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(N - 1);
    for (const e of lost) expect(e).toBeInstanceOf(RefConflictError);
    expect(git(dir, 'rev-parse', 'main')).toBe(won[0]?.commit);
  });

  it('end with every commit or an explicit conflict, never a lost commit', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const landed: string[] = [];
    let conflicts = 0;
    // Each writer retries on conflict, rebuilding on the new head, up to a
    // bound: every attempt ends as a landed commit or a typed conflict.
    const writerLoop = async (i: number) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const head = git(dir, 'rev-parse', 'main');
        try {
          const { commit } = await writer.commit(
            request(head, [
              { path: `modules/en/w${i}.adoc`, content: `writer ${i}\n` },
            ]),
          );
          landed.push(commit);
          return true;
        } catch (e) {
          if (!(e instanceof RefConflictError)) throw e;
          conflicts++;
        }
      }
      return false;
    };
    // Fewer writers than above: each conflict costs a full retry.
    const writers = 8;
    const done = await Promise.all(
      Array.from({ length: writers }, (_, i) => writerLoop(i)),
    );

    const succeeded = done.filter(Boolean).length;
    expect(landed).toHaveLength(succeeded);
    expect(conflicts).toBeGreaterThan(0);
    // History is linear and holds exactly the landed commits on top of main.
    const history = git(dir, 'rev-list', `${commits.main}..main`)
      .split('\n')
      .filter(Boolean);
    expect(new Set(history)).toEqual(new Set(landed));
    expect(git(dir, 'rev-list', '--merges', 'main')).toBe('');
    // Every landed writer's file is in the final tree.
    const files = git(dir, 'ls-tree', '--name-only', 'main', 'modules/en/');
    for (let i = 0; i < writers; i++) {
      expect(files.includes(`modules/en/w${i}.adoc`)).toBe(done[i]);
    }
    expect(succeeded).toBe(writers);
  }, 60_000);

  it('let exactly one of N racing creates of a branch win', async () => {
    const { dir, commits } = bareSample();
    const targets = [commits.v1, commits.main, commits.draft];
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        new GitWriter(dir).createBranch('shared', targets[i % 3] as string),
      ),
    );
    const won = results.flatMap((r, i) =>
      r.status === 'fulfilled' ? [targets[i % 3]] : [],
    );
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(RefConflictError);
      }
    }
    expect(git(dir, 'rev-parse', 'shared')).toBe(won[0]);
  });

  it('never let a delete drop a commit the deleter has not seen', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    await writer.createBranch('shared', commits.main);
    const seen = git(dir, 'rev-parse', 'shared');
    // Commits race a delete based on what the deleter read before them.
    const results = await Promise.allSettled([
      ...Array.from({ length: N }, (_, i) =>
        writer.commit({
          ...request(seen, [{ path: `manuals/w${i}.yaml`, content: `${i}\n` }]),
          branch: 'shared',
        }),
      ),
      writer.deleteBranch('shared', seen),
    ]);
    const landed = results.filter((r) => r.status === 'fulfilled');
    // Exactly one operation wins: one commit, or the delete.
    expect(landed).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(RefConflictError);
      }
    }
    const tip = git(
      dir,
      'branch',
      '--list',
      '--format=%(objectname)',
      'shared',
    );
    const deleted = results[N]?.status === 'fulfilled';
    if (deleted) {
      expect(tip).toBe('');
    } else {
      expect(tip).toBe(
        (landed[0] as PromiseFulfilledResult<{ commit: string }>).value.commit,
      );
    }
  });
});

describe('reading back what was written', () => {
  it('lists first-parent history with trailers, and the paths a commit changed', async () => {
    const { dir, commits } = bareSample();
    const writer = new GitWriter(dir);
    const first = await writer.commit(
      request(
        commits.main,
        [
          { path: 'modules/en/new.adoc', content: 'new\n' },
          { path: 'modules/en/internals.adoc', delete: true },
        ],
        {
          message: 'First\n\nA body: with a colon.',
          trailers: [
            { key: 'Change-set', value: '42' },
            { key: 'Actor', value: 'user/sample-author' },
          ],
        },
      ),
    );
    const second = await writer.commit(
      request(first.commit, [{ path: 'openfolia.yaml', content: 'x: 1\n' }]),
    );
    const repo = new GitRepo(dir);
    const history = await repo.history(second.commit, 3);
    expect(history).toEqual([
      {
        commit: second.commit,
        parent: first.commit,
        parents: 1,
        tree: second.tree,
        authorEmail: ACTOR.email,
        trailers: [],
      },
      {
        commit: first.commit,
        parent: commits.main,
        parents: 1,
        tree: first.tree,
        authorEmail: ACTOR.email,
        trailers: [
          { key: 'Change-set', value: '42' },
          { key: 'Actor', value: 'user/sample-author' },
        ],
      },
      expect.objectContaining({ commit: commits.main }),
    ]);
    expect(await repo.history(second.commit, 1)).toHaveLength(1);
    expect(
      (await repo.changedPaths(commits.main, first.commit)).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    ).toEqual([
      { path: 'modules/en/internals.adoc', deleted: true },
      { path: 'modules/en/new.adoc', deleted: false },
    ]);
    await expect(repo.history('main', 1)).rejects.toThrow('not a commit ID');
    await expect(repo.history(second.commit, 0)).rejects.toThrow(
      'invalid count',
    );
    repo.close();
  });
});
