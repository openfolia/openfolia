import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSearchBudget } from '../scripts/lib/search-budget.mjs';

describe('the search index budget', () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'docs-search-'));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  const index = (lang: string, text: string | Buffer) =>
    writeFileSync(join(out, `search-${lang}.json`), text);

  it('passes indexes within the budget, measured compressed', () => {
    // 100 KB of text that compresses to almost nothing: the size counted is the compressed one.
    index('en', 'a'.repeat(100_000));
    index('de', 'b'.repeat(100_000));
    const { sizes, problems } = checkSearchBudget(out, 1_000);
    expect(problems).toEqual([]);
    expect(sizes['en']).toBeLessThan(1_000);
  });

  it('fails the language whose index outgrew it', () => {
    index('en', 'a'.repeat(100_000));
    index('de', randomBytes(5_000));
    const { problems } = checkSearchBudget(out, 1_000);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/search-de.json');
  });

  it('fails a missing index', () => {
    index('en', 'a');
    expect(checkSearchBudget(out).problems).toEqual([
      '/search-de.json is missing from the built site',
    ]);
  });
});
