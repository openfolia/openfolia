// The slot registry's lock (agent-slot.mjs): an exclusive mkdir of .claude/stacks/.lock with the
// holder's pid inside. It is held across slow steps (a worktree add or remove writes
// .git/config, #327), so its age says nothing on its own: a lock whose holder is alive is never
// taken over, however long it runs; one whose holder is gone is a crash's and taken over at once. Only a lock that
// names no holder (the moment between the mkdir and the pid write, or a lock of an older script)
// falls back to its age. A waiter says who holds it after NOTICE_MS and gives up after
// CEILING_MS (a hung holder, or a pid reused by another process), saying how to clear it.
//
// Taking over is a check and then a rename, and two waiters could both see the same dead
// holder: the first renames the stale lock away and takes a fresh one, and the second, acting
// on what it saw before, would rename that fresh lock away too. So a takeover runs only inside
// a second mutex (`<lock>.takeover`, an exclusive mkdir as well) and checks again inside it.
// While it is held, nobody else can remove the lock: a stale lock's holder is gone, and every
// other takeover waits. So the lock it renames is the one it just found stale. As a last check
// the tombstone's pid is read back; one that isn't the holder it judged (only possible for an
// unnamed lock released and re-made in between) is renamed back, or it stops with an error.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** A lock that names no holder counts as a crash's after this long. */
const UNNAMED_STALE_MS = 120_000;
/** A takeover mutex is held for a few file operations: older than this, its holder crashed. */
const TAKEOVER_STALE_MS = 10_000;
/** When a waiter says who holds the lock. */
const NOTICE_MS = 10_000;
/** When a waiter gives up. */
const CEILING_MS = 600_000;

/** Whether the process `pid` runs (EPERM: it does, another user's). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

const sleepMs = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Whether a lock may be taken over: `holder` the pid it names (null when none), `ageMs` its
 * age, `isAlive(pid)` whether a process runs.
 */
export function lockIsStale({ holder, ageMs, isAlive = alive }) {
  if (Number.isInteger(holder) && holder > 0) return !isAlive(holder);
  return ageMs > UNNAMED_STALE_MS;
}

/** The pid a lock (or mutex, or tombstone) names, or null. */
function holderOf(dir) {
  try {
    const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The directory's age, or null when it is gone. */
function ageOf(dir, now) {
  try {
    return now() - statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/** An exclusive mkdir naming this process; false when it exists. */
function claim(dir) {
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  writeFileSync(path.join(dir, 'pid'), String(process.pid));
  return true;
}

/** Whether `dir` is a lock that may be taken over now. */
function staleNow(dir, { isAlive, now }) {
  const ageMs = ageOf(dir, now);
  return (
    ageMs !== null && lockIsStale({ holder: holderOf(dir), ageMs, isAlive })
  );
}

/** Takes over the stale `lock` inside its takeover mutex (see the header); true when it did. */
function takeOver(lock, hooks) {
  const mutex = `${lock}.takeover`;
  if (!claim(mutex)) {
    // Another waiter is taking over; a mutex left by a crash is cleared after a while.
    const ageMs = ageOf(mutex, hooks.now);
    const holder = holderOf(mutex);
    if (
      ageMs !== null &&
      ageMs > TAKEOVER_STALE_MS &&
      (holder === null || !hooks.isAlive(holder))
    ) {
      rmSync(mutex, { recursive: true, force: true });
    }
    return false;
  }
  try {
    const holder = holderOf(lock);
    if (!staleNow(lock, hooks)) return false;
    const tomb = `${lock}.old-${process.pid}-${hooks.now()}`;
    renameSync(lock, tomb);
    if (holderOf(tomb) !== holder) {
      try {
        renameSync(tomb, lock);
      } catch {
        throw new Error(
          `registry lock: took over ${lock} but it had just been taken by pid ${holderOf(tomb)}, and couldn't put it back (now ${tomb}). Wait until no agent-slot command runs, then rm -rf ${tomb} ${lock}.`,
        );
      }
      return false;
    }
    rmSync(tomb, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` holding the registry lock under `root`/.claude/stacks. `hooks` (for tests):
 * `isAlive(pid)`, `now()`, `sleep(ms)`, `log(line)`, and `beforeTakeover()`, called when a
 * waiter has found the lock stale and is about to take it over (another waiter may act first).
 */
export function withRegistryLock(root, fn, hooks = {}) {
  const h = {
    isAlive: alive,
    now: Date.now,
    sleep: sleepMs,
    log: (line) => console.error(line),
    beforeTakeover: () => undefined,
    ...hooks,
  };
  mkdirSync(path.join(root, '.claude', 'stacks'), { recursive: true });
  const lock = path.join(root, '.claude', 'stacks', '.lock');
  const start = h.now();
  let told = false;
  while (!claim(lock)) {
    if (staleNow(lock, h)) {
      h.beforeTakeover();
      if (takeOver(lock, h)) continue;
    }
    const waited = h.now() - start;
    const holder = holderOf(lock) ?? 'unknown (no pid in it)';
    if (waited >= CEILING_MS) {
      throw new Error(
        `registry lock: ${lock} has been held by pid ${holder} for ${Math.round(waited / 60_000)} min. If no agent-slot command is running any more (ps -p ${holder}: a hung run, or the pid reused by another program), remove it by hand: rm -rf ${lock}`,
      );
    }
    if (!told && waited >= NOTICE_MS) {
      h.log(`registry lock: waiting for pid ${holder}, which holds ${lock} …`);
      told = true;
    }
    h.sleep(50);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
