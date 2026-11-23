// Writes the user guide's index (`lib/guide-index.mjs`) to a file, for the editor's build (#221):
// the same JSON the docs site publishes at `/guide-index.json`. Fails on a guide page without an
// article ID, two pages with one ID, or a page without a title or summary.
//
//   node frontend/docs/scripts/guide-index.mjs <out-file>
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { guideIndex } from './lib/guide-index.mjs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node frontend/docs/scripts/guide-index.mjs <out-file>');
  process.exit(2);
}
let index;
try {
  index = guideIndex(join(import.meta.dirname, '..'));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const file = resolve(out);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(index)}\n`);
console.log(
  `The user guide's index: ${index.articles.length} articles in ${file}.`,
);
