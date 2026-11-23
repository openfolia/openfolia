import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type ProjectConfig } from '@openfolia/content-model';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** The files of a fixture project, by their path in it, as an archive holds them. */
export function fixtureFiles(name = 'garden-pump'): Map<string, Uint8Array> {
  const root = join(FIXTURES, name);
  const files = new Map<string, Uint8Array>();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else {
        files.set(
          relative(root, path).split(sep).join('/'),
          new Uint8Array(readFileSync(path)),
        );
      }
    }
  }
  return files;
}

/** The configuration a fixture project is imported into (`<name>.openfolia.yaml`). */
export function fixtureConfig(name = 'garden-pump'): ProjectConfig {
  return parseConfig(
    readFileSync(join(FIXTURES, `${name}.openfolia.yaml`), 'utf8'),
  );
}

/** `files` with `path` set to `text`. */
export function withFile(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  text: string,
): Map<string, Uint8Array> {
  return new Map([...files, [path, new TextEncoder().encode(text)]]);
}
