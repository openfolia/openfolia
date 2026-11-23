/** Where a value is kept: across tabs and restarts (`local`), or for this tab only (`tab`). */
export type StoredScope = 'local' | 'tab';

const storageOf = (scope: StoredScope): Storage =>
  scope === 'tab' ? sessionStorage : localStorage;

/**
 * Browser storage for a per-viewer convenience: every access is wrapped, since storage can be
 * blocked, full or absent (a private window); the page then works without it.
 */
export function readStored(
  key: string,
  scope: StoredScope = 'local',
): string | null {
  try {
    return storageOf(scope).getItem(key);
  } catch {
    return null;
  }
}

/** Writes (or, for null, removes) a stored value; a failure only means it is not remembered. */
export function writeStored(
  key: string,
  value: string | null,
  scope: StoredScope = 'local',
): void {
  try {
    const storage = storageOf(scope);
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Not remembered across a reload; nothing else depends on it.
  }
}
