// Where the scale tooling keeps a profile's data, and how it reaches the API's build and
// dependencies. Everything generated lives in `.local/perf/<profile>/` (git-ignored), never in
// the repository.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ownerComment, perfDatabaseName } from '../slot-databases-plan.mjs';

export const ROOT = join(import.meta.dirname, '..', '..');
export const API_DIR = join(ROOT, 'backend', 'api');

/** `require` as the API package sees it: its own dependencies (`pg`, `sharp`). */
export const requireFromApi = createRequire(join(API_DIR, 'package.json'));

/** A file URL of the API's build (`backend/api/dist/<path>`), for `import()`. */
export function apiDist(path) {
  return pathToFileURL(join(API_DIR, 'dist', path)).href;
}

/** The folder of a profile's data. */
export function profileDir(name) {
  return join(ROOT, '.local', 'perf', name);
}

/** The files and folders of a profile. */
export function profilePaths(name) {
  const dir = profileDir(name);
  return {
    dir,
    content: join(dir, 'content.git'),
    blobs: join(dir, 'blobs'),
    /** What the seed made and how to reach it: counts, timings, the token, the database. */
    state: join(dir, 'profile.json'),
    seedUsers: join(dir, 'users.json'),
    reports: join(dir, 'reports'),
    logs: join(dir, 'logs'),
  };
}

/**
 * The profile's database on the compose Postgres (`compose.yaml`), one per checkout as
 * `setup-local` makes them: `ccms_perf_<profile>` in the main checkout,
 * `ccms_perf_<slot>_<profile>` in an agent slot, so two checkouts never share one
 * (`scripts/slot-databases-plan.mjs`, which `pnpm slot remove` uses to drop a slot's own).
 */
export function databaseName(profile) {
  const slot =
    basename(dirname(ROOT)) === 'worktrees' &&
    basename(dirname(dirname(ROOT))) === '.claude'
      ? basename(ROOT)
      : undefined;
  return perfDatabaseName(slot, profile);
}

/** The main checkout's real path: this one, or the one whose `.claude/worktrees/` holds it. */
function mainRoot() {
  const real = realpathSync(ROOT);
  return basename(dirname(real)) === 'worktrees' &&
    basename(dirname(dirname(real))) === '.claude'
    ? dirname(dirname(dirname(real)))
    : real;
}

/** The comment on a profile's database: which checkout's tooling made it (`ownerComment`). */
export function checkoutComment() {
  return ownerComment(mainRoot());
}

/** The compose Postgres, as `setup-local` uses it (local credentials only). */
export const LOCAL_POSTGRES = 'postgres://ccms:ccms@127.0.0.1:5432';
