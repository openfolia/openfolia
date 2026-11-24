// Writes the pages for addresses that moved (`scripts/lib/redirects.mjs`) into the built site.
// Run by `build` after `next build`.
//
//   node scripts/redirect-pages.mjs [out-dir]
import { join } from 'node:path';
import { writeRedirectPages } from './lib/redirects.mjs';

const outDir = process.argv[2] ?? join(import.meta.dirname, '../out');
console.log(`Wrote ${writeRedirectPages(outDir)} redirect pages.`);
