import { MAX_SUBFOLDER } from './backup-settings.js';

/** One folder name of a subfolder: letters, digits, `.`, `_` and `-`, not `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/**
 * Why `subfolder` cannot be a folder inside the backup volume, or
 * undefined when it can: relative, `/`-separated names of letters, digits,
 * `.`, `_` and `-`, never `..`, an absolute path, a backslash or an empty
 * name. `''` is the volume itself. The backup process also resolves the
 * folder on disk and refuses one that leaves the volume through a link
 * (`resolveInside`).
 */
export function subfolderProblem(subfolder: string): string | undefined {
  if (subfolder === '') return undefined;
  if (subfolder.length > MAX_SUBFOLDER) {
    return `A subfolder has at most ${MAX_SUBFOLDER} characters.`;
  }
  if (subfolder.startsWith('/') || subfolder.includes('\\')) {
    return 'A subfolder is a path inside the backup volume, never an absolute path.';
  }
  const segments = subfolder.replace(/\/$/, '').split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      return 'A subfolder never leaves the backup volume (no "." or ".." in it).';
    }
    if (!SEGMENT.test(segment)) {
      return `"${segment.slice(0, 64)}" is no folder name: letters, digits, ".", "_" and "-", not starting with "." or "-".`;
    }
  }
  return undefined;
}

/** `subfolder` as stored: without a trailing `/`. */
export const normalSubfolder = (subfolder: string): string =>
  subfolder.trim().replace(/\/+$/, '');

/** The name of a backup: `openfolia-backup-<UTC time>-<run>.tar.age`. */
export const BACKUP_NAME =
  /^openfolia-backup-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.tar\.age$/;

/** The backup's name for a run started at `at`. */
export function backupName(at: Date, runId: string): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `openfolia-backup-${stamp}-${runId.replace(/-/g, '').slice(0, 8)}.tar.age`;
}

/** When the backup named `name` was made, or undefined for any other name. */
export function backupTimeOf(name: string): Date | undefined {
  const match = BACKUP_NAME.exec(name);
  if (!match) return undefined;
  const s = match[1]!;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? undefined : at;
}
