// `agent-slot.mjs remove <name> [--force]` and `list`, apart from the CLI so a test can run them
// on a temporary repository.
import { existsSync, rmSync } from 'node:fs';

import {
  dropLocalBucket,
  dropSlotDatabases,
  pruneSlotDatabases,
  run,
  stopPort,
} from './agent-slot-io.mjs';
import { slotPaths } from './agent-slot-plan.mjs';
import { withRegistryLock } from './registry-lock.mjs';
import { readSlots } from './slot-file.mjs';

/**
 * Stops whatever listens on that slot's PORT (by port, never by name), removes the worktree
 * (refuses uncommitted changes without `force`), its bucket on the local S3 service, its own
 * databases on the local Postgres (`dropDatabases`; one in use stays, with a note) and the
 * slot's record. The branch stays. `dryRun`: changes nothing, says which databases it would drop.
 */
export function remove(
  root,
  name,
  {
    force = false,
    dryRun = false,
    dropBucket = dropLocalBucket,
    dropDatabases = dropSlotDatabases,
  } = {},
) {
  const paths = slotPaths(root, name);
  const slot = readSlots(root).find((candidate) => candidate.name === name);
  if (!slot && !existsSync(paths.worktree))
    throw new Error(`No slot "${name}".`);
  if (dryRun) {
    console.log(
      `Dry run: would stop what listens on ${slot?.port ?? '(no PORT)'}, remove ${paths.worktree}, its bucket and record.`,
    );
    dropDatabases(root, name, paths.worktree, { dryRun: true });
    return;
  }
  const hadWorktree = existsSync(paths.worktree);
  if (hadWorktree && !force) {
    const dirty = run('git', [
      '-C',
      paths.worktree,
      'status',
      '--porcelain',
    ]).trim();
    if (dirty) {
      throw new Error(
        `${paths.worktree} has uncommitted changes; commit them, or pass --force to drop them.`,
      );
    }
  }
  if (slot && stopPort(slot.port))
    console.log(`Stopped what listened on ${slot.port}.`);
  // Under the registry lock like create's worktree add: git takes .git/config's lock without
  // waiting, so a remove and a create at once could fail with "could not lock config file".
  withRegistryLock(root, () => {
    // A create of this name that finished while this remove waited made a worktree this remove
    // never looked at (no dirty check): leave it to a new remove.
    if (!hadWorktree && existsSync(paths.worktree)) {
      throw new Error(
        `"${name}" was created while this remove waited; run remove again.`,
      );
    }
    // Inside the lock, after that check: never the bucket a new slot of this name just made.
    // As local-bucket.ts names buckets: `abc-`, `a--bc` and `abc` can share one; then it stays.
    const bucketOf = (slotName) =>
      slotName.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    const shared = readSlots(root).some(
      (other) => other.name !== name && bucketOf(other.name) === bucketOf(name),
    );
    if (shared) {
      console.log(
        `The slot's bucket stays: another slot's name gives the same bucket.`,
      );
    } else if (dropBucket(root, paths.worktree) === false) {
      console.log(
        `The slot's bucket on the local S3 service was not deleted; later: node backend/api/scripts/local-bucket.ts drop ${paths.worktree}`,
      );
    }
    // Before the worktree goes: its settings name the server. The port is stopped above and its
    // processes waited for, so the slot's own server holds no connection; one still open (a
    // psql, a test, a server that did not stop in time) keeps its database, with a note.
    if (dropDatabases(root, name, paths.worktree) === false) {
      console.log(
        `Not all of the slot's databases were dropped; later: pnpm slot prune-databases`,
      );
    }
    if (existsSync(paths.worktree)) {
      run(
        'git',
        ['-C', root, 'worktree', 'remove', '--force', paths.worktree],
        {
          stdio: 'inherit',
        },
      );
    }
    rmSync(paths.stackDir, { recursive: true, force: true });
  });
  console.log(
    `Removed slot "${name}". The branch ${slot?.branch ?? paths.branch} stays (git branch -D to delete it).`,
  );
}

/**
 * `prune-databases [--yes]`: under the registry lock (no slot is made or removed meanwhile), the
 * databases of slots that are gone, listed; dropped only with `yes`. Whether it went through.
 */
export function pruneDatabases(
  root,
  { yes = false, prune = pruneSlotDatabases } = {},
) {
  return withRegistryLock(root, () => prune(root, { yes }));
}

/** The slots, one line each; a reservation whose create is still running says so. */
export function listLines(root) {
  const slots = readSlots(root);
  if (slots.length === 0) return ['No slots.'];
  return slots.map(
    (slot) =>
      `${slot.name}\t${slot.branch}\tPORT ${slot.port}\t${slot.worktree}` +
      (slot.creating ? '\t(being created)' : ''),
  );
}
