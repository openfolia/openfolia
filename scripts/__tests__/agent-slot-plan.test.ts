import { describe, expect, it } from 'vitest';

import {
  machineLoadWarnings,
  optionValue,
  pickPort,
  remoteBranch,
  resolveBase,
  slotName,
  slotPaths,
  withPort,
  worktreeAddArgs,
} from '@/scripts/agent-slot-plan.mjs';

describe('slotName', () => {
  it('accepts lower-case letters, digits and dashes', () => {
    for (const name of ['a', 'agent-1', '0day', 'x'.repeat(31)])
      expect(slotName(name)).toBe(name);
  });

  it('refuses everything else', () => {
    for (const name of [
      '',
      '-a',
      'A',
      'a b',
      'a/b',
      '../x',
      'x'.repeat(32),
      undefined,
    ]) {
      expect(() => slotName(name as string), String(name)).toThrow(
        /not a slot name/,
      );
    }
  });
});

describe('optionValue', () => {
  it('reads the value after the key, or after "="', () => {
    expect(optionValue(['--base', 'origin/dev'], '--base')).toBe('origin/dev');
    expect(optionValue(['--base=origin/dev'], '--base')).toBe('origin/dev');
  });

  it('is undefined without a value', () => {
    expect(optionValue([], '--base')).toBeUndefined();
    expect(optionValue(['--base'], '--base')).toBeUndefined();
    expect(optionValue(['--base', '--offline'], '--base')).toBeUndefined();
  });
});

describe('resolveBase', () => {
  it('prefers --base, then BASE_BRANCH, then origin/main', () => {
    expect(
      resolveBase(['--base', 'origin/a'], { BASE_BRANCH: 'origin/b' }),
    ).toEqual({
      ref: 'origin/a',
      source: 'arg',
    });
    expect(resolveBase([], { BASE_BRANCH: 'origin/b' })).toEqual({
      ref: 'origin/b',
      source: 'env',
    });
    expect(resolveBase([], {})).toEqual({
      ref: 'origin/main',
      source: 'default',
    });
  });
});

describe('remoteBranch', () => {
  const lsRemote = (stdout: string, status = 0) => ({ status, stdout });

  it('finds the branch in the live ls-remote answer', () => {
    const out = lsRemote('abc123\trefs/heads/agent/x\n');
    expect(
      remoteBranch({ branch: 'agent/x', local: false, lsRemote: out }),
    ).toBe(true);
    expect(
      remoteBranch({ branch: 'agent/y', local: false, lsRemote: out }),
    ).toBe(false);
    expect(
      remoteBranch({ branch: 'agent/x', local: false, lsRemote: lsRemote('') }),
    ).toBe(false);
  });

  it('does not ask GitHub for a local branch or offline', () => {
    expect(remoteBranch({ branch: 'b', local: true, lsRemote: null })).toBe(
      false,
    );
    expect(
      remoteBranch({
        branch: 'b',
        local: false,
        lsRemote: null,
        offline: true,
      }),
    ).toBe(false);
  });

  it('throws when ls-remote failed, instead of starting from the base', () => {
    expect(() =>
      remoteBranch({ branch: 'b', local: false, lsRemote: lsRemote('', 128) }),
    ).toThrow(/--offline/);
  });
});

describe('worktreeAddArgs', () => {
  const common = { worktree: '/w', branch: 'agent/x', base: 'origin/main' };

  it('uses the local branch, else the pushed one, else a new one from the base', () => {
    expect(worktreeAddArgs({ ...common, local: true, remote: false })).toEqual([
      '/w',
      'agent/x',
    ]);
    expect(worktreeAddArgs({ ...common, local: false, remote: true })).toEqual([
      '--track',
      '-b',
      'agent/x',
      '/w',
      'origin/agent/x',
    ]);
    expect(worktreeAddArgs({ ...common, local: false, remote: false })).toEqual(
      ['-b', 'agent/x', '/w', 'origin/main'],
    );
  });
});

describe('slotPaths', () => {
  it('puts the worktree and the record under .claude of the main checkout', () => {
    expect(slotPaths('/repo', 'a')).toEqual({
      worktree: '/repo/.claude/worktrees/a',
      stackDir: '/repo/.claude/stacks/a',
      slotFile: '/repo/.claude/stacks/a/slot.json',
      branch: 'agent/a',
    });
  });
});

describe('pickPort', () => {
  const free = () => false;

  it('starts at 3101, never 3100', () => {
    expect(pickPort([], free)).toBe(3101);
  });

  it('skips the other slots` ports and the ones in use', () => {
    expect(pickPort([3101, 3102], free)).toBe(3103);
    expect(pickPort([3101], (port) => port === 3102)).toBe(3103);
  });

  it('throws when the block is full', () => {
    expect(() => pickPort([], () => true)).toThrow(/No free PORT in 3101–3200/);
  });
});

describe('withPort', () => {
  it('replaces the PORT line and leaves the rest', () => {
    expect(withPort('A=1\nPORT=3100\nHOST=x\n', 3105)).toBe(
      'A=1\nPORT=3105\nHOST=x\n',
    );
  });

  it('adds the line when there is none, also to a file without a final newline', () => {
    expect(withPort('', 3105)).toBe('PORT=3105\n');
    expect(withPort('A=1', 3105)).toBe('A=1\nPORT=3105\n');
  });

  it('does not touch a setting that merely ends in PORT', () => {
    expect(withPort('SMTP_PORT=25\n', 3105)).toBe('SMTP_PORT=25\nPORT=3105\n');
  });
});

describe('machineLoadWarnings', () => {
  it('warns above the core count only', () => {
    expect(machineLoadWarnings({ load1: 9.5, cores: 8 })).toHaveLength(1);
    expect(machineLoadWarnings({ load1: 8, cores: 8 })).toEqual([]);
    expect(machineLoadWarnings({ load1: Number.NaN, cores: 8 })).toEqual([]);
  });
});
