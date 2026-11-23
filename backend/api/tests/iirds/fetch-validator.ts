import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The iiRDS Validation Tool's rule files, fetched when the tests run, never
 * kept in the repository (#431, "Licences" in `docs/iirds-export.md`): its
 * rules quote the iiRDS specification (CC BY-ND 4.0), German translations
 * among them, so the repository does not redistribute them. Pinned to one
 * commit, each file checked against its SHA-256, kept in a git-ignored
 * cache (`backend/api/.cache/`) so later runs need no network.
 */
export const VALIDATOR_REPOSITORY = 'plusmeta/iirds-validation-tool';
export const VALIDATOR_COMMIT = 'f1119bea7b64fd826ded9e06d9abae287cbad9c1';

export const VALIDATOR_FILES: Readonly<Record<string, string>> = {
  'LICENSE.md':
    'bf9060ab5be85e5cec1af11ad5949cc733d8555b6ad39ac5d08c2e1b29965de5',
  'src/config/validation/container-rules.js':
    '457512a94ca3d28164b1673fca864eea63be74dab4cecb4253b877307e523b22',
  'src/config/validation/schema-rules.js':
    'bb9fd8f553640578b15752646b232aa4cad64c567df6b1363977ee40907b1279',
  'src/util/const.js':
    '968027bf30e895a93aaa1af01dcd56164092255022d51d3a50212c425225e689',
  'src/util/rules.js':
    '69e835749614d461e3d99aca75ef764141bb00aab5908d18a4da3ae90367d6fa',
};

/** Where the files are kept: `<dir>/<path>` as in the tool's repository. */
export const VALIDATOR_DIR = join(
  import.meta.dirname,
  '../../.cache/iirds-validation-tool',
  VALIDATOR_COMMIT,
);

/** Where a failed fetch is noted, so the one test that needs the files says why. */
const FAILED = join(VALIDATOR_DIR, '..', `${VALIDATOR_COMMIT}.failed`);

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function present(): boolean {
  return Object.entries(VALIDATOR_FILES).every(([path, hash]) => {
    const file = join(VALIDATOR_DIR, path);
    return existsSync(file) && sha256(readFileSync(file)) === hash;
  });
}

/**
 * Vitest's global setup: fetches what is missing. Never fails the run: a
 * failure (no network) is noted, and `validatorProblem()` reports it to
 * the test that runs the rules.
 */
export async function setup(): Promise<void> {
  if (present()) return;
  try {
    for (const [path, hash] of Object.entries(VALIDATOR_FILES)) {
      const file = join(VALIDATOR_DIR, path);
      if (existsSync(file) && sha256(readFileSync(file)) === hash) continue;
      const url = `https://raw.githubusercontent.com/${VALIDATOR_REPOSITORY}/${VALIDATOR_COMMIT}/${path}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (sha256(bytes) !== hash) {
        throw new Error(`${url}: not the pinned file (SHA-256 differs)`);
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  } catch (error) {
    mkdirSync(dirname(FAILED), { recursive: true });
    writeFileSync(FAILED, String(error));
  }
}

/** Why the rules cannot run (not fetched, or changed); undefined when they can. */
export function validatorProblem(): string | undefined {
  if (present()) return undefined;
  const why = existsSync(FAILED) ? readFileSync(FAILED, 'utf8') : 'not fetched';
  return `The iiRDS Validation Tool's rules (${VALIDATOR_REPOSITORY}@${VALIDATOR_COMMIT}) are not in ${VALIDATOR_DIR}: ${why}. They are fetched when the API's tests start (tests/iirds/fetch-validator.ts), which needs network access once.`;
}
