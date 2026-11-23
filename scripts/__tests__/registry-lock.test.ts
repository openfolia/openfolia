// The slot registry's lock (scripts/registry-lock.mjs): held across a slow worktree add, so its
// age never makes a live holder's lock stale; a dead holder's lock is taken over at once.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { lockIsStale, withRegistryLock } from '@/scripts/registry-lock.mjs';

const roots: string[] = [];
afterAll(() =>
  roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

/** A root whose lock already exists, named for `pid`, `ageS` seconds old. */
function lockedRoot(pid: number | null, ageS: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'registry-lock-'));
  roots.push(root);
  const lock = path.join(root, '.claude', 'stacks', '.lock');
  mkdirSync(lock, { recursive: true });
  if (pid !== null) writeFileSync(path.join(lock, 'pid'), String(pid));
  const at = Date.now() / 1000 - ageS;
  utimesSync(lock, at, at);
  return { root, lock };
}

describe('lockIsStale', () => {
  it('never takes over a live holder, however old its lock', () => {
    expect(
      lockIsStale({ holder: 42, ageMs: 3_600_000, isAlive: () => true }),
    ).toBe(false);
  });

  it('takes over a dead holder at once', () => {
    expect(lockIsStale({ holder: 42, ageMs: 10, isAlive: () => false })).toBe(
      true,
    );
  });

  it('falls back to the age when the lock names no holder', () => {
    expect(lockIsStale({ holder: null, ageMs: 1_000 })).toBe(false);
    expect(lockIsStale({ holder: null, ageMs: 121_000 })).toBe(true);
  });
});

describe('withRegistryLock', () => {
  it('runs fn holding the lock, names itself in it, and releases it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'registry-lock-'));
    roots.push(root);
    const lock = path.join(root, '.claude', 'stacks', '.lock');
    const seen = withRegistryLock(root, () =>
      existsSync(path.join(lock, 'pid')),
    );
    expect(seen).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("takes over a crashed holder's lock", () => {
    // A pid that has exited.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const { root, lock } = lockedRoot(dead ?? 999_999, 1);
    expect(withRegistryLock(root, () => 'ran')).toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('withRegistryLock: two waiters, a hung holder', () => {
  const DEAD = 111;
  const LIVE = 222;
  const isAlive = (pid: number) => pid === LIVE;
  const pidIn = (dir: string) => readFileSync(path.join(dir, 'pid'), 'utf8');
  const name = (dir: string, pid: number) => {
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'pid'), String(pid));
  };

  it('never renames away the fresh lock another waiter took after both saw the dead holder', () => {
    const { root, lock } = lockedRoot(DEAD, 1);
    const seen: string[] = [];
    let raced = false;
    let sleeps = 0;
    const result = withRegistryLock(root, () => 'ran', {
      isAlive,
      // Between this waiter finding the lock stale and its takeover, the other waiter takes
      // the lock over and holds a fresh one.
      beforeTakeover: () => {
        if (raced) return;
        raced = true;
        rmSync(lock, { recursive: true, force: true });
        name(lock, LIVE);
      },
      sleep: () => {
        seen.push(pidIn(lock));
        // The other waiter releases after a while.
        if (++sleeps === 3) rmSync(lock, { recursive: true, force: true });
      },
      log: () => {},
    });
    expect(result).toBe('ran');
    expect(seen).toEqual([String(LIVE), String(LIVE), String(LIVE)]);
    // No tombstone or mutex left behind.
    expect(readdirSync(path.dirname(lock))).toEqual([]);
  });

  it('waits while another waiter holds the takeover, then takes the stale lock over', () => {
    const { root, lock } = lockedRoot(DEAD, 1);
    name(`${lock}.takeover`, LIVE);
    let sleeps = 0;
    const result = withRegistryLock(root, () => pidIn(lock), {
      isAlive,
      sleep: () => {
        // The stale lock is untouched while the takeover is someone else's.
        expect(pidIn(lock)).toBe(String(DEAD));
        if (++sleeps === 2)
          rmSync(`${lock}.takeover`, { recursive: true, force: true });
      },
      log: () => {},
    });
    expect(result).toBe(String(process.pid));
    expect(sleeps).toBe(2);
  });

  it("clears a crashed waiter's takeover mutex after a while", () => {
    const { root, lock } = lockedRoot(DEAD, 1);
    name(`${lock}.takeover`, DEAD);
    const at = Date.now() / 1000 - 30;
    utimesSync(`${lock}.takeover`, at, at);
    expect(
      withRegistryLock(root, () => 'ran', {
        isAlive,
        sleep: () => {},
        log: () => {},
      }),
    ).toBe('ran');
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it('says who holds it after 10 s, and gives up after 10 min with how to clear it', () => {
    const { root, lock } = lockedRoot(LIVE, 1);
    let t = Date.now();
    const lines: string[] = [];
    const run = () =>
      withRegistryLock(root, () => 'ran', {
        isAlive,
        now: () => t,
        sleep: () => {
          t += 5_000;
        },
        log: (line: string) => lines.push(line),
      });
    expect(run).toThrow(
      new RegExp(`held by pid ${LIVE} for 10 min[\\s\\S]*rm -rf ${lock}`),
    );
    expect(lines).toEqual([
      `registry lock: waiting for pid ${LIVE}, which holds ${lock} …`,
    ]);
    // The live holder's lock is left alone.
    expect(pidIn(lock)).toBe(String(LIVE));
  });
});
