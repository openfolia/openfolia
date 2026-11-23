import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportBundle } from '../lib/import/validate-import.js';

const root = join(import.meta.dirname, 'import-example');

/** The example bundle (`import-example/`), as an unpacked archive: a fresh copy each call. */
export function exampleBundle(): ImportBundle & {
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>([
    ['import.json', new Uint8Array(readFileSync(join(root, 'import.json')))],
  ]);
  for (const name of readdirSync(join(root, 'assets')))
    files.set(
      `assets/${name}`,
      new Uint8Array(readFileSync(join(root, 'assets', name))),
    );
  return { files };
}

/** The example's `import.json`, parsed: a fresh copy each call. */
export function exampleDocument(): Record<string, any> {
  return JSON.parse(readFileSync(join(root, 'import.json'), 'utf8'));
}

/** A bundle of `document` (as `import.json`) and the example's files. */
export function bundleOf(
  document: unknown,
  files: ReadonlyMap<string, Uint8Array> = exampleBundle().files,
): ImportBundle & { files: Map<string, Uint8Array> } {
  const copy = new Map(files);
  copy.set('import.json', new TextEncoder().encode(JSON.stringify(document)));
  return { files: copy };
}
