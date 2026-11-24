// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { publish } from '@/scripts/docs-publish.mjs';
import {
  DEFAULT_PLATFORMS,
  imageRepository,
  parseArgs,
  planPublish,
} from '@/scripts/docs-publish-plan.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const clean = { sha: SHA, dirty: false };
const dev = { DOCS_SITE_URL: 'https://docs.example.org' };
const LOCK = 'ghcr.io/openfolia/openfolia/api:v1.2.3@sha256:' + 'a'.repeat(64);
const release = { ...dev, DOCS_RELEASE_DIGESTS: LOCK };

const plan = (argv: string[], env: Record<string, string>, git = clean) =>
  planPublish({ args: parseArgs(argv), env, git });

/** The value after a flag in the docker arguments, each time it is given. */
const values = (docker: string[], flag: string) =>
  docker.flatMap((arg, i) => (arg === flag ? [docker[i + 1]] : []));

describe('docs:publish arguments', () => {
  it('takes no arguments: a local build of the development docs', () => {
    expect(parseArgs([])).toEqual({
      release: null,
      push: false,
      tag: null,
      platforms: null,
    });
  });

  it('takes --release, --push, --tag and --platform', () => {
    expect(
      parseArgs([
        '--release',
        'v1.2.3',
        '--push',
        '--tag',
        'preview',
        '--platform',
        'linux/arm64',
      ]),
    ).toEqual({
      release: 'v1.2.3',
      push: true,
      tag: 'preview',
      platforms: ['linux/arm64'],
    });
  });

  it.each([
    [['--release', '1.2.3'], /release's tag such as v1.2.3/],
    [['--release', 'v1.2.3-rc.1'], /release's tag/],
    [['--release'], /needs a value/],
    [['--release', '--push'], /needs a value/],
    [['--tag', 'has space'], /Docker tag/],
    [['--tag', 'sha-abc'], /sets itself/],
    [['--tag', 'v1.2.3'], /sets itself/],
    [['--platform', 'arm64'], /comma-separated list/],
    [['--platform', 'linux/arm64,linux/arm64'], /twice/],
    [['--push', '--push'], /given twice/],
    [['--dry-run'], /unexpected argument/],
    [['push'], /unexpected argument/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('docs:publish settings', () => {
  it('refuses the development docs without DOCS_SITE_URL', () => {
    expect(() => plan([], {})).toThrow(
      /DOCS_SITE_URL must be set for the development docs/,
    );
    expect(() =>
      plan([], { ...dev, DOCS_SITE_URL: 'docs.example.org' }),
    ).toThrow(/absolute http\(s\) URL/);
  });

  it("refuses a release's docs without DOCS_RELEASE_DIGESTS, and takes the signatures when set", () => {
    expect(() => plan(['--release', 'v1.2.3'], dev)).toThrow(
      /DOCS_RELEASE_DIGESTS must be set/,
    );
    expect(() =>
      plan(['--release', 'v1.2.3'], { DOCS_RELEASE_DIGESTS: LOCK }),
    ).toThrow(/DOCS_SITE_URL must be set for a release's docs/);
    const signed = plan(['--release', 'v1.2.3'], {
      ...release,
      DOCS_RELEASE_SIGNATURES: `${'b'.repeat(64)}  trusted_root.json`,
    });
    expect(signed.buildEnv).toEqual({
      DOCS_RELEASE: 'v1.2.3',
      NX_LOAD_DOT_ENV_FILES: 'false',
    });
  });

  it("refuses a release's settings without --release, and DOCS_RELEASE set by hand", () => {
    expect(() => plan([], release)).toThrow(
      /DOCS_RELEASE_DIGESTS belong to a release's docs/,
    );
    expect(() => plan([], { ...dev, DOCS_RELEASE_SIGNATURES: 'x' })).toThrow(
      /DOCS_RELEASE_SIGNATURES belong/,
    );
    expect(() =>
      plan(['--release', 'v1.2.3'], { ...release, DOCS_RELEASE: 'v1.2.3' }),
    ).toThrow(/pass --release vX.Y.Z instead/);
  });

  it('refuses to push a working tree with changes, and tags a local build of one as such', () => {
    const dirty = { sha: SHA, dirty: true };
    expect(() => plan(['--push'], dev, dirty)).toThrow(
      /the working tree has changes/,
    );
    expect(plan([], dev, dirty).tags).toEqual(['latest', 'sha-0123456-dirty']);
  });

  it("pushes a release's docs only from its tag, and only with an https site", () => {
    expect(() => plan(['--release', 'v1.2.3', '--push'], release)).toThrow(
      /check out v1.2.3 \(git checkout v1.2.3\)/,
    );
    expect(() =>
      plan(['--release', 'v1.2.3', '--push'], release, {
        ...clean,
        tags: ['v1.2.2'],
      }),
    ).toThrow(/HEAD is not tagged v1.2.3/);
    expect(
      plan(['--release', 'v1.2.3', '--push'], release, {
        ...clean,
        tags: ['v1.2.3'],
      }).tags,
    ).toEqual(['latest', 'v1.2.3', 'sha-0123456']);
    // A local build to try it needs no tag.
    expect(plan(['--release', 'v1.2.3'], release).tags).toContain('v1.2.3');
    expect(() =>
      plan(['--release', 'v1.2.3'], {
        ...release,
        DOCS_SITE_URL: 'http://docs.example.org',
      }),
    ).toThrow(/https:\/\/ URL for a release's docs/);
  });

  describe("a release's push from a commit after its tag", () => {
    const after = (changedSinceTag: string[], tagIsAncestor = true) => ({
      ...clean,
      tags: [],
      tagIsAncestor,
      changedSinceTag,
    });
    const push = (git: Parameters<typeof plan>[2]) =>
      plan(['--release', 'v1.2.3', '--push'], release, git);

    it('takes a commit that differs only in the changelog', () => {
      expect(
        push(after(['CHANGELOG.md', 'changelog/v1.2.3.json'])).tags,
      ).toEqual(['latest', 'v1.2.3', 'sha-0123456']);
      expect(push(after([])).labels).toMatchObject({
        'org.opencontainers.image.revision': SHA,
      });
    });

    it('refuses any other file, naming it', () => {
      expect(() =>
        push(after(['CHANGELOG.md', 'backend/api/src/x.ts'])),
      ).toThrow(/more than the changelog.*backend\/api\/src\/x\.ts/);
    });

    it('refuses a HEAD that does not descend from the tag', () => {
      expect(() => push(after([], false))).toThrow(/does not descend from it/);
    });
  });

  it('refuses a missing commit', () => {
    expect(() => plan([], dev, { sha: '', dirty: false })).toThrow(
      /no commit to publish/,
    );
  });
});

describe('docs:publish image', () => {
  it('names ghcr.io/<owner>/openfolia-docs after the repository, as DOCS_IMAGES does', () => {
    expect(imageRepository({})).toBe('ghcr.io/openfolia/openfolia-docs');
    expect(
      imageRepository({
        DOCS_REPOSITORY_URL: 'https://github.com/Some-Fork/openfolia',
      }),
    ).toBe('ghcr.io/some-fork/openfolia-docs');
    expect(
      imageRepository({ DOCS_REPOSITORY_URL: 'https://git.example.org/a/b' }),
    ).toBe('ghcr.io/openfolia/openfolia-docs');
    expect(
      imageRepository({
        DOCS_PUBLISH_IMAGE: 'registry.example.org:5000/docs/site',
      }),
    ).toBe('registry.example.org:5000/docs/site');
    expect(() =>
      imageRepository({ DOCS_PUBLISH_IMAGE: 'ghcr.io/openfolia/docs:latest' }),
    ).toThrow(/without a tag/);
  });

  it('tags latest and sha-<short>, plus the release with --release; --tag replaces latest', () => {
    expect(plan([], dev).references).toEqual([
      'ghcr.io/openfolia/openfolia-docs:latest',
      'ghcr.io/openfolia/openfolia-docs:sha-0123456',
    ]);
    expect(plan(['--release', 'v1.2.3'], release).tags).toEqual([
      'latest',
      'v1.2.3',
      'sha-0123456',
    ]);
    expect(plan(['--tag', 'preview'], dev).tags).toEqual([
      'preview',
      'sha-0123456',
    ]);
  });

  it('labels the image with its source, licence, revision and version', () => {
    const { labels } = plan(['--release', 'v1.2.3'], release);
    expect(labels).toMatchObject({
      'org.opencontainers.image.source':
        'https://github.com/openfolia/openfolia',
      'org.opencontainers.image.licenses': 'AGPL-3.0-only',
      'org.opencontainers.image.revision': SHA,
      'org.opencontainers.image.version': 'v1.2.3',
      'org.opencontainers.image.url': 'https://docs.example.org',
    });
  });

  it('passes no build arguments: the image allows no API origin (#858)', () => {
    expect(values(plan([], dev).docker, '--build-arg')).toEqual([]);
  });

  it('loads a local build for the machine, and pushes arm64 and amd64 with --push', () => {
    const local = plan([], dev).docker;
    expect(local).toContain('--load');
    expect(local).not.toContain('--push');
    expect(local).not.toContain('--platform');
    expect(values(local, '--build-context')).toEqual([
      'site=frontend/docs/out',
    ]);
    expect(values(local, '--file')).toEqual(['deploy/docker/docs/Dockerfile']);

    const pushed = plan(['--push'], dev).docker;
    expect(DEFAULT_PLATFORMS[0]).toBe('linux/arm64');
    expect(values(pushed, '--platform')).toEqual(['linux/arm64,linux/amd64']);
    expect(pushed).toContain('--push');
    expect(pushed).not.toContain('--load');

    expect(
      values(
        plan(['--push', '--platform', 'linux/arm64'], dev).docker,
        '--platform',
      ),
    ).toEqual(['linux/arm64']);
    expect(
      values(plan(['--platform', 'linux/amd64'], dev).docker, '--platform'),
    ).toEqual(['linux/amd64']);
  });
});

describe('docs:publish steps', () => {
  const git = (dirty: boolean) =>
    vi.fn((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return `${SHA}\n`;
      if (command === 'git' && args[0] === 'status')
        return dirty ? ' M x\n' : '';
      if (command === 'git' && args[0] === 'tag') return 'v1.2.3\n';
      return 'buildx v0\n';
    });

  it('builds nothing when a check refuses', () => {
    const run = vi.fn();
    expect(() =>
      publish({
        argv: ['--push'],
        env: dev,
        cwd: '/repo',
        read: git(true),
        run,
        log: () => {},
      }),
    ).toThrow(/working tree has changes/);
    expect(run).not.toHaveBeenCalled();
  });

  it('builds the site with DOCS_RELEASE, then the image, and prints the digest', () => {
    const run = vi.fn();
    const lines: string[] = [];
    const { digest } = publish({
      argv: ['--release', 'v1.2.3', '--push'],
      env: release,
      cwd: '/repo',
      read: git(false),
      run,
      log: (line: string) => lines.push(line),
      readMetadata: () => ({
        'containerimage.digest': `sha256:${'c'.repeat(64)}`,
      }),
    });
    expect(run).toHaveBeenCalledTimes(2);
    const [site, image] = run.mock.calls;
    expect(site[0]).toBe('pnpm');
    expect(site[1]).toEqual([
      'nx',
      'run',
      'docs:build',
      '--output-style=static',
    ]);
    expect(site[2].env).toMatchObject({ ...release, DOCS_RELEASE: 'v1.2.3' });
    expect(image[0]).toBe('docker');
    expect(image[1].at(-1)).toBe('.');
    expect(image[1]).toContain('--metadata-file');
    expect(digest).toBe(`sha256:${'c'.repeat(64)}`);
    expect(lines.join('\n')).toContain(
      `ghcr.io/openfolia/openfolia-docs@sha256:${'c'.repeat(64)}`,
    );
  });

  it('gathers the tag relation for a release pushed from a later commit', () => {
    const calls: string[][] = [];
    const read = vi.fn((command: string, args: string[]) => {
      if (command === 'git') calls.push(args);
      if (args[0] === 'rev-parse') return `${SHA}\n`;
      if (args[0] === 'status') return '';
      if (args[0] === 'tag') return '';
      if (args[0] === 'diff') return 'CHANGELOG.md\nchangelog/v1.2.3.json\n';
      return '';
    });
    const run = vi.fn();
    publish({
      argv: ['--release', 'v1.2.3', '--push'],
      env: release,
      cwd: '/repo',
      read,
      run,
      log: () => {},
      readMetadata: () => ({}),
    });
    expect(calls).toContainEqual([
      'merge-base',
      '--is-ancestor',
      'refs/tags/v1.2.3',
      'HEAD',
    ]);
    // Renames list both paths, so a moved source file cannot pass as a changelog file.
    expect(calls).toContainEqual([
      'diff',
      '--name-only',
      '--no-renames',
      'refs/tags/v1.2.3',
      'HEAD',
      '--',
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    // Not a descendant: git exits non-zero, nothing is built.
    const refuse = vi.fn((command: string, args: string[]) => {
      if (args[0] === 'merge-base') throw new Error('exit 1');
      return read(command, args);
    });
    run.mockClear();
    expect(() =>
      publish({
        argv: ['--release', 'v1.2.3', '--push'],
        env: release,
        cwd: '/repo',
        read: refuse,
        run,
        log: () => {},
      }),
    ).toThrow(/does not descend/);
    expect(run).not.toHaveBeenCalled();
  });

  it('builds the development docs without DOCS_RELEASE in their environment', () => {
    const run = vi.fn();
    publish({
      argv: [],
      env: dev,
      cwd: '/repo',
      read: git(false),
      run,
      log: () => {},
      readMetadata: () => ({}),
    });
    const { env } = run.mock.calls[0][2];
    expect('DOCS_RELEASE' in env).toBe(false);
    expect(env['NX_LOAD_DOT_ENV_FILES']).toBe('false');
  });
});
