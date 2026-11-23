// Fails the docs build when a stable address (`lib/stable-paths.mjs`) is missing from `out/`.
//
//   node scripts/check-stable-paths.mjs [out-dir]
import { join } from 'node:path';
import {
  checkStablePaths,
  STABLE_FILES,
  STABLE_PAGES,
} from './lib/stable-paths.mjs';

const outDir = process.argv[2] ?? join(import.meta.dirname, '../out');
const problems = checkStablePaths(outDir);
if (problems.length > 0) {
  console.error(
    `The built docs site lacks ${problems.length} stable address(es):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `Every stable address is in the built site: ${STABLE_PAGES.length} pages in English and German, ${STABLE_FILES.length} files.`,
);
