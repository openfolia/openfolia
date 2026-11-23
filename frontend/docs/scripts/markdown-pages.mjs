// Moves the pages' Markdown to their addresses (#423): the build makes `out/md/<page>.md`
// (`app/md/[...slug]/route.ts`, since a static export can't put a route beside the pages' own),
// and each is served at its page's address plus `.md`: `out/md/guide/writing.md` becomes
// `out/guide/writing.md`. Run by `build` after `next build`.
//
//   node scripts/markdown-pages.mjs [out-dir]
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const outDir = process.argv[2] ?? join(import.meta.dirname, '../out');
const from = join(outDir, 'md');
if (!existsSync(from)) {
  console.error(`No page Markdown in ${from}: the build made none.`);
  process.exit(1);
}
let count = 0;
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
for (const file of files(from)) {
  const to = join(outDir, relative(from, file));
  if (!to.endsWith('.md'))
    throw new Error(`Not a page's Markdown: ${relative(outDir, file)}`);
  cpSync(file, to);
  count++;
}
rmSync(from, { recursive: true });
console.log(`Moved ${count} pages' Markdown to their addresses.`);
