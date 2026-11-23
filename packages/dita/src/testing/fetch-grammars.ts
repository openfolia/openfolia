import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The OASIS DITA 1.3 grammar files (errata 02, "all-inclusive"), fetched
 * when the tests run, never kept in the repository ("Licence check" in
 * `docs/dita-import.md`): one ZIP, pinned by its SHA-256, kept in a
 * git-ignored cache (`packages/dita/.cache/`) so later runs need no
 * network. Only the validation of the fixtures and of exported packages
 * (`testing/grammars.ts`) uses them;
 * the converter never reads a DTD.
 */
export const GRAMMARS_URL =
  'https://docs.oasis-open.org/dita/dita/v1.3/errata02/os/complete/part3-all-inclusive/dita-v1.3-errata02-os-part3-all-inclusive-complete-grammars.zip';
export const GRAMMARS_SHA256 =
  'd7973189f13111f91ceb675ef71d2f397dcb576c06789f87a1c546462aa95f9b';

/** Where the ZIP is kept. */
export const GRAMMARS_FILE = join(
  import.meta.dirname,
  '../../.cache',
  `dita-1.3-errata02-grammars-${GRAMMARS_SHA256.slice(0, 12)}.zip`,
);

/** Where a failed fetch is noted, so the test that needs the files says why. */
const FAILED = `${GRAMMARS_FILE}.failed`;

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function present(): boolean {
  return (
    existsSync(GRAMMARS_FILE) &&
    sha256(readFileSync(GRAMMARS_FILE)) === GRAMMARS_SHA256
  );
}

/**
 * Vitest's global setup: fetches the ZIP when it is missing. Never fails
 * the run: a failure (no network) is noted, and `grammarsProblem()`
 * reports it to the test that validates.
 */
export async function setup(): Promise<void> {
  if (present()) return;
  try {
    const res = await fetch(GRAMMARS_URL, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`${GRAMMARS_URL}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sha256(bytes) !== GRAMMARS_SHA256) {
      throw new Error(`${GRAMMARS_URL}: not the pinned file (SHA-256 differs)`);
    }
    mkdirSync(dirname(GRAMMARS_FILE), { recursive: true });
    writeFileSync(GRAMMARS_FILE, bytes);
  } catch (error) {
    mkdirSync(dirname(FAILED), { recursive: true });
    writeFileSync(FAILED, String(error));
  }
}

/** Why the fixtures cannot be validated (not fetched, or changed); undefined when they can. */
export function grammarsProblem(): string | undefined {
  if (present()) return undefined;
  const why = existsSync(FAILED) ? readFileSync(FAILED, 'utf8') : 'not fetched';
  return `The OASIS DITA 1.3 grammar files (${GRAMMARS_URL}, SHA-256 ${GRAMMARS_SHA256}) are not in ${GRAMMARS_FILE}: ${why}. They are fetched when the tests of @openfolia/dita start (src/testing/fetch-grammars.ts), which needs network access once.`;
}
