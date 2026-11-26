// Fails the docs build when a language's search index outgrows its budget (`lib/search-budget.mjs`).
//
//   node scripts/check-search-budget.mjs [out-dir]
import { join } from 'node:path';
import {
  checkSearchBudget,
  SEARCH_BUDGET_BYTES,
} from './lib/search-budget.mjs';

const outDir = process.argv[2] ?? join(import.meta.dirname, '../out');
const { sizes, problems } = checkSearchBudget(outDir);
if (problems.length > 0) {
  console.error(
    `The search index is over its budget:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `The search index is within its budget of ${Math.round(SEARCH_BUDGET_BYTES / 1024)} KB compressed per language: ${Object.entries(
    sizes,
  )
    .map(([lang, bytes]) => `${lang} ${Math.round(bytes / 1024)} KB`)
    .join(', ')}.`,
);
