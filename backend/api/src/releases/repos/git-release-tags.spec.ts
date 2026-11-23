import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { createBareSampleRepo } from '@openfolia/content-repo/testing';
import { ConflictError, UnprocessableError } from '../../base/core/errors.js';
import type { Env } from '../../config/env.js';
import { DEFAULT_RELEASE_TAG } from '../core/release-tags.js';
import { GitReleaseTags } from './git-release-tags.js';

describe('GitReleaseTags', () => {
  let sample: ReturnType<typeof createBareSampleRepo>;
  const actor = { kind: 'user' as const, id: 'sample-publisher' };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', sample.dir, ...args], {
      encoding: 'utf8',
    }).trim();
  const tags = (pattern = DEFAULT_RELEASE_TAG) => {
    const settings: Partial<Env> = {
      CCMS_CONTENT_DIR: sample.dir,
      CCMS_RELEASE_TAG: pattern,
    };
    return new GitReleaseTags({
      get: (key: keyof Env) => settings[key],
    } as unknown as ConfigService<Env, true>);
  };
  const release = (more: object = {}) => ({
    product: 'x-200',
    revision: '1.2.0',
    commit: sample.commits.main,
    message: 'Release 1.2.0',
    actor,
    ...more,
  });

  beforeEach(() => {
    sample = createBareSampleRepo();
  });
  afterEach(
    () => sample && rmSync(sample.dir, { recursive: true, force: true }),
  );

  it('tags the exact commit under the configured name, with the actor as tagger', async () => {
    const made = await tags().create(release());
    expect(made).toEqual({
      name: 'release/x-200/1.2.0',
      tag: git('rev-parse', 'refs/tags/release/x-200/1.2.0'),
      commit: sample.commits.main,
    });
    expect(git('cat-file', 'tag', made.tag)).toMatch(
      new RegExp(
        [
          `^object ${sample.commits.main}`,
          'type commit',
          'tag release/x-200/1.2.0',
          'tagger sample-publisher <sample-publisher@user\\.openfolia\\.invalid> \\d+ \\+0000',
          '',
          'Release 1\\.2\\.0',
          '',
          'Product: x-200',
          'Revision: 1\\.2\\.0',
          'Actor: user/sample-publisher$',
        ].join('\n'),
      ),
    );
    const other = await tags('{product}/releases/{revision}').create(release());
    expect(other.name).toBe('x-200/releases/1.2.0');
  });

  it('never re-creates or moves a release', async () => {
    const first = await tags().create(release());
    await expect(
      tags().create(release({ commit: sample.commits.v1 })),
    ).rejects.toThrow(ConflictError);
    await expect(
      tags().create(release({ product: 'X-200' })),
    ).rejects.toMatchObject({ code: 'release-exists' });
    expect(git('rev-parse', 'refs/tags/release/x-200/1.2.0')).toBe(first.tag);
  });

  it('refuses names, commits and messages that can never be tagged', async () => {
    const before = git('for-each-ref');
    const code = (more: object) =>
      tags()
        .create(release(more))
        .then(
          () => 'ok',
          (e: unknown) =>
            e instanceof UnprocessableError || e instanceof ConflictError
              ? e.code
              : String(e),
        );
    expect(await code({ product: 'a/b' })).toBe('invalid-release-name');
    expect(await code({ revision: '1..2' })).toBe('invalid-release-name');
    expect(await code({ commit: '0'.repeat(40) })).toBe('invalid-commit');
    expect(await code({ commit: 'main' })).toBe('invalid-commit');
    expect(await code({ message: 'Release\n\nRevision: 9' })).toBe(
      'invalid-message',
    );
    expect(git('for-each-ref')).toBe(before);
  });

  it('reads a tag back by its exact name, with its date and its message without trailers', async () => {
    const date = new Date('2026-05-06T07:08:09Z');
    const made = await tags().create(
      release({ message: 'Release x-200 1.2.0\n\nWhat changed.', date }),
    );
    expect(await tags().find(made.name)).toEqual({
      ...made,
      taggedAt: date,
      message: 'Release x-200 1.2.0\n\nWhat changed.',
    });
    expect(tags().nameOf('x-200', '1.2.0')).toBe(made.name);
    expect(await tags().find('release/x-200')).toBeUndefined();
    expect(await tags().find('release/x-200/9')).toBeUndefined();
    expect(() => tags().nameOf('a/b', '1')).toThrow(UnprocessableError);
  });
});
