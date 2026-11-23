import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The folders this process makes under the staging root: nothing else there is ever removed. */
const OWN = /^(run|restore)-[A-Za-z0-9._-]+$/;

/** Whether `child` is `parent` or inside it (both resolved already). */
const within = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

/** `path` with symbolic links resolved, as far as it exists (the rest appended as written). */
async function real(path: string): Promise<string> {
  const absolute = resolve(path);
  let existing = absolute;
  for (;;) {
    try {
      return join(await realpath(existing), relative(existing, absolute));
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      existing = parent;
    }
  }
}

/**
 * The staging root (#529): where runs stage their unencrypted parts (a dump, a bundle, a
 * check's unpacked copy).
 *
 * - `CCMS_BACKUP_STAGING_DIR` set: it must be a real folder (no symbolic link) owned by this
 *   user with mode 0700, and neither inside nor around the backup volume or any folder in
 *   `keepOut` (the content repository, the blobs, the secret key's folder).
 * - Unset: a fresh private folder made here (`mkdtemp`, 0700) in the system's temporary folder,
 *   never a fixed name another user could have made first. The caller removes it at the end.
 */
export async function openStagingRoot(
  configured: string | undefined,
  volume: string,
  keepOut: readonly string[] = [],
): Promise<string> {
  if (configured === undefined) {
    return mkdtemp(join(tmpdir(), 'openfolia-backup-'));
  }
  const root = resolve(configured);
  let info;
  try {
    info = await lstat(root);
  } catch {
    throw new Error(
      `CCMS_BACKUP_STAGING_DIR (${root}) does not exist: make it, owned by this user, mode 0700.`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      `CCMS_BACKUP_STAGING_DIR (${root}) is a symbolic link: name the folder itself.`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`CCMS_BACKUP_STAGING_DIR (${root}) is not a folder.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(
      `CCMS_BACKUP_STAGING_DIR (${root}) belongs to another user (uid ${info.uid}, not ${uid}).`,
    );
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error(
      `CCMS_BACKUP_STAGING_DIR (${root}) has mode ${(info.mode & 0o777).toString(8).padStart(4, '0')}: it must be 0700, so no one else can read a run's unencrypted parts.`,
    );
  }
  const realRoot = await real(root);
  for (const other of [volume, ...keepOut]) {
    const realOther = await real(other);
    if (within(realOther, realRoot)) {
      throw new Error(
        `CCMS_BACKUP_STAGING_DIR (${root}) is inside the backup volume or the instance's data (${other}): the unencrypted parts of a run must never be there.`,
      );
    }
    if (within(realRoot, realOther)) {
      throw new Error(
        `CCMS_BACKUP_STAGING_DIR (${root}) holds ${other}: name a folder of its own.`,
      );
    }
  }
  return root;
}

/** A fresh private folder (0700) for one run, under the staging root. */
export function stageRun(root: string, runId: string): Promise<string> {
  return mkdtemp(join(root, `run-${runId.replace(/[^A-Za-z0-9-]/g, '')}-`));
}

/** A fresh private folder (0700) for one restore, under the staging root. */
export function stageRestore(root: string): Promise<string> {
  return mkdtemp(join(root, 'restore-'));
}

/**
 * Removes what a stopped run or restore left under the staging root: only the folders this
 * process makes (`run-…`, `restore-…`), real folders of this user, never a link's target and
 * nothing else in the root. Call it under the backup lock (no run in progress then).
 */
export async function clearStaging(root: string): Promise<string[]> {
  const removed: string[] = [];
  const uid = process.getuid?.();
  for (const entry of await readdir(root)) {
    if (!OWN.test(entry)) continue;
    const path = join(root, entry);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid))
      continue;
    await rm(path, { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}
