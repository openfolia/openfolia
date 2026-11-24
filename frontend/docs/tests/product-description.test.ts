import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const docs = join(root, 'frontend/docs/content/docs');

describe('the product description (#820)', () => {
  // OpenFolia is a documentation platform with an editor, review, releases, a portal and an API,
  // never "headless" alone: the places that describe the product say so.
  it.each([
    join(root, 'README.md'),
    join(root, 'CLAUDE.md'),
    join(docs, 'index.mdx'),
    join(docs, 'index.de.mdx'),
    join(docs, 'getting-started.mdx'),
    join(docs, 'getting-started.de.mdx'),
  ])('%s does not call the product headless', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/headless/i);
  });
});
