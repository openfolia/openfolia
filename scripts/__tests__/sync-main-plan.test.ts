import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  baseName,
  dirtyPaths,
  dirtyReason,
  lockfileNote,
  postMergeSteps,
  syncDecision,
  triageOutput,
} from '@/scripts/sync-main-plan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('a checkout is clean', () => {
  it('reads tracked changes, renames and untracked files', () => {
    expect(
      dirtyPaths(' M a.ts\nM  b.ts\n?? new.ts\nR  old.ts -> moved.ts\n'),
    ).toEqual(['a.ts', 'b.ts', 'new.ts', 'moved.ts']);
    expect(dirtyPaths('')).toEqual([]);
    expect(dirtyReason({ where: 'X', dir: '/m', porcelain: '' })).toBeNull();
  });

  it('reads output whose first line lost its leading space to a trim', () => {
    expect(dirtyPaths('M a.ts\n M b.ts\n?? c.ts')).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
    expect(
      dirtyReason({
        where: 'X',
        dir: '/w',
        porcelain: ' M pnpm-lock.yaml\n'.trim(),
      }),
    ).toMatch(/local changes \(pnpm-lock\.yaml\)/);
  });

  it('refuses local changes, naming them, without discarding anything', () => {
    const reason = dirtyReason({
      where: 'The main checkout',
      dir: '/m',
      porcelain: '?? x.ts\n',
    });
    expect(reason).toMatch(
      /The main checkout \(\/m\) has local changes \(x\.ts\)/,
    );
    expect(reason).toMatch(/nothing is discarded/);
  });
});

describe('syncDecision', () => {
  const ok = {
    base: 'main',
    branch: 'main',
    dirty: null,
    head: 'a',
    target: 'b',
    ancestor: true,
  };

  it('fast-forwards a clean checkout on the base that is behind', () => {
    expect(syncDecision(ok)).toEqual({ action: 'fast-forward' });
    expect(syncDecision({ ...ok, target: 'a' })).toEqual({ action: 'current' });
  });

  it('refuses another branch, local changes, a missing remote ref and a diverged base', () => {
    expect(syncDecision({ ...ok, branch: 'feat/x' })).toMatchObject({
      action: 'refuse',
      reason: expect.stringMatching(/on feat\/x, not main/),
    });
    expect(syncDecision({ ...ok, branch: null }).action).toBe('refuse');
    expect(syncDecision({ ...ok, dirty: 'dirty!' })).toEqual({
      action: 'refuse',
      reason: 'dirty!',
    });
    expect(syncDecision({ ...ok, target: null }).action).toBe('refuse');
    expect(syncDecision({ ...ok, ancestor: false })).toMatchObject({
      action: 'refuse',
      reason: expect.stringMatching(/can't fast-forward/),
    });
  });

  it('reads the base however it is named', () => {
    expect(baseName('origin/sprint-2')).toBe('sprint-2');
    expect(baseName('refs/heads/main')).toBe('main');
    expect(baseName(undefined)).toBe('main');
  });
});

describe('postMergeSteps: what .githooks/post-merge runs', () => {
  it('installs dependencies first when the lockfile changed', () => {
    const { steps } = postMergeSteps({
      nodeModules: true,
      head: 'a',
      target: 'b',
      lockfileChanged: true,
    });
    expect(steps.map((step) => step.args)).toEqual([
      ['install', '--frozen-lockfile'],
      ['check:changed', '--base=a', '--head=b'],
    ]);
  });

  it('runs check:changed over what the fast-forward brought in', () => {
    expect(
      postMergeSteps({
        nodeModules: true,
        head: 'aaa',
        target: 'bbb',
      }).steps.map((s) => [s.cmd, ...s.args].join(' ')),
    ).toEqual(['pnpm check:changed --base=aaa --head=bbb']);
  });

  it('is the command the hook itself runs (a change to one fails here)', () => {
    const hook = readFileSync(path.join(ROOT, '.githooks/post-merge'), 'utf8');
    const steps = postMergeSteps({
      nodeModules: true,
      head: 'ORIG_HEAD',
      target: 'HEAD',
    }).steps;
    for (const step of steps)
      expect(hook).toContain([step.cmd, ...step.args].join(' '));
  });

  it('runs nothing without node_modules, and says so', () => {
    expect(
      postMergeSteps({ nodeModules: false, head: 'a', target: 'b' }),
    ).toEqual({
      steps: [],
      note: expect.stringMatching(/pnpm install/),
    });
  });

  it('notes a changed lockfile', () => {
    expect(lockfileNote(['a.ts', 'pnpm-lock.yaml'])).toMatch(/installed/);
    expect(lockfileNote(['a.ts', 'package-lock.json'])).toBeNull();
  });
});

describe('triageOutput: which failed step the timeout triage reads', () => {
  const { steps } = postMergeSteps({
    nodeModules: true,
    head: 'a',
    target: 'b',
    lockfileChanged: true,
  });
  const [install, check] = steps;

  it('reads the check when the install before it succeeded (#627)', () => {
    expect(
      triageOutput([
        { step: install, status: 0, output: 'Done in 1.2s' },
        { step: check, status: 1, output: 'check output' },
      ]),
    ).toBe('check output');
    expect(
      triageOutput([{ step: check, status: 1, output: 'check output' }]),
    ).toBe('check output');
  });

  it('reads nothing when the install failed, nothing failed, or the failure was not the check', () => {
    expect(
      triageOutput([
        { step: install, status: 1, output: 'install output' },
        { step: check, status: 1, output: 'check output' },
      ]),
    ).toBeNull();
    expect(
      triageOutput([
        { step: install, status: 1, output: 'install output' },
        { step: check, status: 0, output: '' },
      ]),
    ).toBeNull();
    expect(
      triageOutput([
        { step: install, status: 0, output: '' },
        { step: check, status: 0, output: '' },
      ]),
    ).toBeNull();
  });
});
