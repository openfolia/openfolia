import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REVIEW_DIFF_FILE,
  pickBase,
  reviewHeader,
  reviewHowTo,
} from '@/scripts/review-diff-plan.mjs';
import { gitEnv } from '@/scripts/run-git.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('review:diff', () => {
  it('writes to a git-ignored path, so the diff never lists itself or gets committed', () => {
    const ignored = spawnSync('git', ['check-ignore', '-q', REVIEW_DIFF_FILE], {
      cwd: ROOT,
      env: gitEnv(),
    });
    expect(ignored.status).toBe(0);
  });

  it('picks the base: --base, BASE_BRANCH, the slot, else origin/main', () => {
    expect(
      pickBase(['--base', 'origin/sprint-2'], { BASE_BRANCH: 'x' }, 'y'),
    ).toEqual({
      ref: 'origin/sprint-2',
      source: 'arg',
    });
    expect(pickBase(['--base=main'], {})).toEqual({
      ref: 'main',
      source: 'arg',
    });
    expect(pickBase([], { BASE_BRANCH: 'origin/sprint-3' }, 'y').source).toBe(
      'env',
    );
    expect(pickBase([], {}, 'origin/sprint-4')).toEqual({
      ref: 'origin/sprint-4',
      source: 'slot',
    });
    expect(pickBase([], {})).toEqual({ ref: 'origin/main', source: 'default' });
    expect(() => pickBase(['--base'], {})).toThrow(/needs a ref/);
    expect(() => pickBase([], { BASE_BRANCH: '--output=x' })).toThrow(
      /not a ref/,
    );
  });

  it('heads the file with the worktree, branch, head and merge-base', () => {
    const header = reviewHeader({
      worktree: '/w',
      branch: 'agent/a',
      base: 'origin/main',
      mergeBase: 'b'.repeat(40),
      head: 'h'.repeat(40),
      untracked: ['new.ts'],
    });
    expect(header).toContain('# Review diff of /w');
    expect(header).toContain(
      `agent/a at ${'h'.repeat(40)}; against origin/main`,
    );
    expect(header).toContain(
      `git diff ${'b'.repeat(12)}...HEAD, plus 1 untracked new file(s)`,
    );
  });

  it('says how to point both reviews at the file, and what it left out', () => {
    const text = reviewHowTo({
      file: '/w/.review/diff.patch',
      worktree: '/w',
      branch: 'agent/a',
      files: ['a.ts', 'b.ts'],
      uncommitted: ['c.ts'],
    });
    expect(text).toContain('/code-review high /w/.review/diff.patch');
    expect(text).toMatch(
      /\/security-review.*Review only the diff in \/w\/\.review\/diff\.patch/,
    );
    expect(text).toMatch(/a\.ts[\s\S]*b\.ts/);
    expect(text).toMatch(/not committed\): c\.ts/);
  });
});
