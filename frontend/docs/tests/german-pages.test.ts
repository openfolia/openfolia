import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  englishProse,
  glossaryWords,
  isIdentifier,
  sameCells,
} from '../scripts/lib/german-check.mjs';

// #744: no English prose on a German page. The build checks the generated pages
// (`scripts/generate.mjs`); this test checks the written ones.

const docsRoot = join(import.meta.dirname, '..');
const written = join(docsRoot, 'content/docs');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

const germanPages = files(written).filter((f) => f.endsWith('.de.mdx'));

describe('the written German pages', () => {
  it('are there to check', () => {
    expect(germanPages.length).toBeGreaterThan(50);
  });

  it('hold no English prose', () => {
    const found = germanPages.flatMap((file) =>
      englishProse(readFileSync(file, 'utf8')).map(
        (p) => `${relative(docsRoot, file)}:${p.line} ${p.text}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('use the glossary’s words, not the English ones it replaces', () => {
    const found = germanPages.flatMap((file) =>
      glossaryWords(readFileSync(file, 'utf8')).map(
        (w) => `${relative(docsRoot, file)}:${w.line} ${w.word}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe('the German check', () => {
  it('finds an English sentence, not a German one with an English term', () => {
    expect(
      englishProse('Read anything else: drafts on other branches and commits.'),
    ).toHaveLength(1);
    expect(
      englishProse(
        'Die Delivery API liefert freigegebene Inhalte für Portale und RAG-Pipelines.',
      ),
    ).toEqual([]);
  });

  it('checks front matter values and prose attributes, not code or addresses', () => {
    const page = [
      '---',
      "title: 'Read the pages of this site'",
      "articleId: 'guide.what-is-in-the-box'",
      '---',
      '',
      '```sh',
      'echo "this is the code of a page and it is fine"',
      '```',
      '',
      '<Card href="/de/guide/locks-and-taking-over-from-the-author" title="Sperren" />',
      '  description="Shows the pages of the site and what they are for."',
    ].join('\n');
    expect(englishProse(page).map((p) => p.line)).toEqual([2, 11]);
  });

  it('checks the prose attributes of a tag on one line', () => {
    expect(
      englishProse(
        '<Card title="Sperren" description="Shows the pages of the site and what they are for." />',
      ),
    ).toHaveLength(1);
    expect(glossaryWords('<Card title="Release-Hinweise" />')).toHaveLength(1);
    expect(
      englishProse(
        '<Card href="/de/guide/what-is-in-it-for-the-author" title="Sperren" />',
      ),
    ).toEqual([]);
  });

  it('closes a fence only with its own kind', () => {
    const page = [
      '````',
      '```',
      'Release',
      '````',
      '~~~ ',
      'Release',
      '~~~',
      'Release',
    ].join('\n');
    expect(glossaryWords(page).map((w) => w.line)).toEqual([8]);
  });

  it('counts short English words, not fragments of German ones', () => {
    expect(
      englishProse('Take a backup first and follow the steps.'),
    ).toHaveLength(1);
    expect(englishProse('Überarbeitung, Übersetzung und Überblick.')).toEqual(
      [],
    );
  });

  it('finds the words the glossary replaces, outside code', () => {
    expect(
      glossaryWords(
        'Jedes Release und jeder Änderungssatz; `openfolia release` nicht.',
      ).map((w) => w.word),
    ).toEqual(['Release', 'Änderungssatz']);
  });

  it('finds a German table cell that equals the English one, unless it is an identifier', () => {
    const english =
      '| Permission | What it allows |\n| --- | --- |\n| `content.read` | Read content |\n| 3 | ✓ |';
    const german =
      '| Berechtigung | Was sie erlaubt |\n| --- | --- |\n| `content.read` | Read content |\n| 3 | ✓ |';
    expect(sameCells(english, german)).toEqual([
      { table: 1, row: 2, column: 2, text: 'Read content' },
    ]);
    expect(isIdentifier('**Author** (`author`)', ['Author'])).toBe(true);
  });
});
