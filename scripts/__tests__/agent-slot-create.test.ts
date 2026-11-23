// `agent-slot` create, list and remove end to end in throwaway repositories: an `origin` (bare)
// and a main checkout cloned from it. Install and setup are fakes (no pnpm, no network); git,
// the registry lock and the slot records are the real ones.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { create } from '@/scripts/agent-slot-create.mjs';
import { listLines, remove } from '@/scripts/agent-slot-remove.mjs';
import { gitEnv } from '@/scripts/run-git.mjs';
import { readSlots } from '@/scripts/slot-file.mjs';

// Dozens of git processes per test: a loaded full run can stretch past the default 5 s.
vi.setConfig({ testTimeout: 60_000 });

const SCRIPT = path.resolve(import.meta.dirname, '..', 'agent-slot.mjs');
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const dirs: string[] = [];

function git(cwd: string, ...args: string[]) {
  const out = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...gitEnv(), ...IDENTITY },
  });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

/** origin with `main` (and `agent/pushed`, one more commit) and a fresh clone of it. */
function setup() {
  const top = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'agent-slot-create-')),
  );
  dirs.push(top);
  const origin = path.join(top, 'origin.git');
  const seed = path.join(top, 'seed');
  const main = path.join(top, 'main');
  git(top, 'init', '-q', '--bare', '-b', 'main', origin);
  git(top, 'init', '-q', '-b', 'main', seed);
  writeFileSync(path.join(seed, 'README.md'), 'base\n');
  // As the repository's own: a worktree's settings and dependencies are not work.
  writeFileSync(path.join(seed, '.gitignore'), '.env.*\nnode_modules/\n');
  git(seed, 'add', 'README.md', '.gitignore');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'agent/pushed');
  writeFileSync(path.join(seed, 'pushed.txt'), 'work\n');
  git(seed, 'add', 'pushed.txt');
  git(seed, 'commit', '-q', '-m', 'pushed work');
  git(seed, 'push', '-q', 'origin', 'agent/pushed');
  git(top, 'clone', '-q', origin, main);
  return main;
}

/** The steps a real create runs after the worktree exists, as fakes: setup writes the .env.local. */
function fakeSteps() {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      install: (worktree: string) => calls.push(`install ${worktree}`),
      setup: (worktree: string) => {
        calls.push(`setup ${worktree}`);
        writeFileSync(
          path.join(worktree, '.env.local'),
          'CCMS_API_TOKEN=abc\nPORT=3100\n',
        );
      },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('create, list and remove', () => {
  it('makes a slot, lists it and removes it, leaving the branch', () => {
    const main = setup();
    const { steps, calls } = fakeSteps();

    const slot = create(main, 'alpha', [], steps, {});
    const worktree = path.join(main, '.claude', 'worktrees', 'alpha');

    // The worktree, on its own branch from origin/main.
    expect(slot).toMatchObject({
      name: 'alpha',
      branch: 'agent/alpha',
      base: 'origin/main',
      worktree,
    });
    // The first free PORT of the block, normally 3101 (a busy one is skipped): never 3100.
    const port = slot.port;
    expect(port).toBeGreaterThan(3100);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'agent/alpha',
    );
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(
      git(main, 'rev-parse', 'origin/main'),
    );
    // Dependencies, then the worktree's own settings with the slot's PORT and no Nx daemon.
    expect(calls).toEqual([`install ${worktree}`, `setup ${worktree}`]);
    expect(readFileSync(path.join(worktree, '.env.local'), 'utf8')).toBe(
      `CCMS_API_TOKEN=abc\nPORT=${port}\nNX_DAEMON=false\n`,
    );
    // The record, as the hook and the merge tooling read it; no reservation left in it.
    const [record] = readSlots(main);
    expect(record).toEqual(slot);
    expect(Object.keys(record).sort()).toEqual(
      ['base', 'branch', 'created', 'name', 'port', 'worktree'].sort(),
    );
    expect(new Date(record.created).toISOString()).toBe(record.created);
    // The brief was printed for the coordinator.
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]));
    expect(printed.some((line) => line.startsWith('----- slot brief'))).toBe(
      true,
    );
    expect(printed.some((line) => line.includes(`PORT: ${port}`))).toBe(true);

    // A second slot gets the next PORT.
    const second = create(main, 'beta', [], fakeSteps().steps, {});
    expect(second.port).toBeGreaterThan(port);
    expect(listLines(main).sort()).toEqual([
      `alpha\tagent/alpha\tPORT ${port}\t${worktree}`,
      `beta\tagent/beta\tPORT ${second.port}\t${path.join(main, '.claude', 'worktrees', 'beta')}`,
    ]);

    remove(main, 'alpha');
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(path.join(main, '.claude', 'stacks', 'alpha'))).toBe(
      false,
    );
    expect(readSlots(main).map((other) => other.name)).toEqual(['beta']);
    expect(git(main, 'branch', '--list', 'agent/alpha')).toContain(
      'agent/alpha',
    );
    expect(git(main, 'worktree', 'list')).not.toContain('alpha');

    // Its bucket on the local S3 service goes too, named by the worktree.
    const dropped: string[][] = [];
    remove(main, 'beta', {
      dropBucket: (root: string, at: string) => {
        dropped.push([root, at]);
        return true;
      },
    });
    expect(dropped).toEqual([
      [main, path.join(main, '.claude', 'worktrees', 'beta')],
    ]);
    expect(listLines(main)).toEqual(['No slots.']);
  });

  it('drops the slot`s databases while its worktree (and settings) are still there', () => {
    const main = setup();
    create(main, 'alpha', [], fakeSteps().steps, {});
    const worktree = path.join(main, '.claude', 'worktrees', 'alpha');
    const calls: unknown[] = [];
    const dropDatabases = (
      root: string,
      name: string,
      at: string,
      options?: { dryRun?: boolean },
    ) => {
      calls.push([root, name, at, options, existsSync(at)]);
      return true;
    };

    // A dry run changes nothing: the worktree and the record stay.
    remove(main, 'alpha', { dryRun: true, dropDatabases });
    expect(calls).toEqual([[main, 'alpha', worktree, { dryRun: true }, true]]);
    expect(existsSync(worktree)).toBe(true);
    expect(readSlots(main).map((slot) => slot.name)).toEqual(['alpha']);

    calls.length = 0;
    remove(main, 'alpha', { dropDatabases });
    expect(calls).toEqual([[main, 'alpha', worktree, undefined, true]]);
    expect(existsSync(worktree)).toBe(false);
  });

  it('a failed database drop is a note; the slot is still removed', () => {
    const main = setup();
    create(main, 'alpha', [], fakeSteps().steps, {});
    remove(main, 'alpha', { dropDatabases: () => false });
    expect(readSlots(main)).toEqual([]);
    expect(
      vi.mocked(console.log).mock.calls.map((call) => String(call[0])),
    ).toContain(
      "Not all of the slot's databases were dropped; later: pnpm slot prune-databases",
    );
  });

  it('refuses to remove a worktree with uncommitted work unless forced', () => {
    const main = setup();
    create(main, 'alpha', [], fakeSteps().steps, {});
    const worktree = path.join(main, '.claude', 'worktrees', 'alpha');
    writeFileSync(path.join(worktree, 'wip.txt'), 'unsaved\n');

    expect(() => remove(main, 'alpha')).toThrow(/uncommitted changes/);
    expect(existsSync(worktree)).toBe(true);
    expect(readSlots(main)).toHaveLength(1);

    remove(main, 'alpha', { force: true });
    expect(existsSync(worktree)).toBe(false);
    expect(readSlots(main)).toEqual([]);
  });

  it('does not count the worktree`s ignored files (.env.local, node_modules) as work', () => {
    const main = setup();
    create(main, 'alpha', ['--offline'], fakeSteps().steps, {});
    const worktree = path.join(main, '.claude', 'worktrees', 'alpha');
    mkdirSync(path.join(worktree, 'node_modules'));
    writeFileSync(path.join(worktree, 'node_modules', 'x.js'), '');

    remove(main, 'alpha');
    expect(existsSync(worktree)).toBe(false);
  });

  it('takes --base, --branch and BASE_BRANCH', () => {
    const main = setup();
    git(main, 'branch', 'sprint', 'origin/main');
    writeFileSync(path.join(main, 'sprint.txt'), 'sprint\n');
    git(main, 'checkout', '-q', 'sprint');
    git(main, 'add', 'sprint.txt');
    git(main, 'commit', '-q', '-m', 'sprint work');
    git(main, 'checkout', '-q', 'main');

    const viaArg = create(
      main,
      'one',
      ['--base=sprint', '--branch', 'feature/one', '--offline'],
      fakeSteps().steps,
      {},
    );
    expect(viaArg).toMatchObject({ branch: 'feature/one', base: 'sprint' });
    expect(git(viaArg.worktree, 'rev-parse', 'HEAD')).toBe(
      git(main, 'rev-parse', 'sprint'),
    );

    const viaEnv = create(main, 'two', ['--offline'], fakeSteps().steps, {
      BASE_BRANCH: 'sprint',
    });
    expect(viaEnv.base).toBe('sprint');
  });

  it('goes on from a branch that is only on GitHub, never from the base', () => {
    const main = setup();
    const slot = create(main, 'pushed', [], fakeSteps().steps, {});
    expect(existsSync(path.join(slot.worktree, 'pushed.txt'))).toBe(true);
    expect(git(slot.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(
      'origin/agent/pushed',
    );
  });

  it('refuses a missing base before it makes anything', () => {
    const main = setup();
    expect(() =>
      create(main, 'alpha', ['--base', 'origin/nope'], fakeSteps().steps, {}),
    ).toThrow(/origin\/nope \(from --base\) is not here/);
    expect(existsSync(path.join(main, '.claude', 'worktrees', 'alpha'))).toBe(
      false,
    );
    expect(existsSync(path.join(main, '.claude', 'stacks', 'alpha'))).toBe(
      false,
    );
  });

  it('refuses a name that is taken, and a name that is not one', () => {
    const main = setup();
    create(main, 'alpha', [], fakeSteps().steps, {});
    expect(() => create(main, 'alpha', [], fakeSteps().steps, {})).toThrow(
      /already exists/,
    );
    expect(() => remove(main, 'ghost')).toThrow(/No slot "ghost"/);
  });

  it('replaces the reservation of a create that died before its worktree existed', () => {
    const main = setup();
    const stackDir = path.join(main, '.claude', 'stacks', 'alpha');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(
      path.join(stackDir, 'slot.json'),
      JSON.stringify({
        name: 'alpha',
        worktree: path.join(main, '.claude', 'worktrees', 'alpha'),
        port: 3101,
        creating: 2 ** 22 + 1, // no such pid
      }),
    );
    // Its PORT is free again for the new create.
    const slot = create(main, 'alpha', [], fakeSteps().steps, {});
    expect(slot.port).toBeLessThanOrEqual(3101 + 1);
    expect(readSlots(main)).toEqual([slot]);
  });

  it('keeps the slot and says how to remove it when a step fails', () => {
    const main = setup();
    const steps = {
      install: () => {
        throw new Error('pnpm install failed');
      },
      setup: () => {},
    };
    expect(() => create(main, 'alpha', [], steps, {})).toThrow(
      /pnpm install failed[\s\S]*remove alpha --force/,
    );
    expect(readSlots(main)).toHaveLength(1);
    remove(main, 'alpha', { force: true });
    expect(readSlots(main)).toEqual([]);
  });
});

describe('the command line', () => {
  it('lists slots from inside the main checkout and refuses a bad name', () => {
    const main = setup();
    const env = { ...gitEnv(), ...IDENTITY };
    const list = spawnSync('node', [SCRIPT, 'list'], {
      cwd: main,
      encoding: 'utf8',
      env,
    });
    expect(list.status).toBe(0);
    expect(list.stdout.trim()).toBe('No slots.');

    const bad = spawnSync('node', [SCRIPT, 'create', 'Bad Name'], {
      cwd: main,
      encoding: 'utf8',
      env,
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/not a slot name/);

    const usage = spawnSync('node', [SCRIPT], {
      cwd: main,
      encoding: 'utf8',
      env,
    });
    expect(usage.status).toBe(2);
  });
});
