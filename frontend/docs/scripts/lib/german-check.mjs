// Keeping English out of the German pages (#744). The build runs these on the German pages it
// generates (`scripts/generate.mjs`), and a test on the written ones (`tests/german-pages.test.ts`):
//
// - `englishProse(text)`: lines of prose that read as English, by the English function words they
//   hold (code, links' targets, front-matter keys and JSX are left out first). German shares few
//   of these words, and a line needs several different ones, so a German sentence with an English
//   product term or a quoted label passes.
// - `sameCells(english, german)`: the cells of a generated German page's tables that equal the
//   English page's cell at the same place, unless the cell is an identifier (code, a number, a mark,
//   a name the product keeps in every language).
// - `glossaryWords(text)`: English words the German glossary (`frontend/ui/README.md`) replaces,
//   such as "Release" for Veröffentlichung.
// - `withoutEnglish(text)`: the page without its English sections, the parts between
//   `ENGLISH_START` and `ENGLISH_END` (#750), which the checks above then pass over. Only the pages
//   the build names may hold one (`scripts/generate.mjs`): the references whose source is English.

/** Where a German page's English section starts and ends: MDX comments, not shown. */
export const ENGLISH_START = '{/* english: start */}';
export const ENGLISH_END = '{/* english: end */}';

/**
 * A German page with the lines of its English sections emptied (so line numbers stay), and how
 * many it holds; `problems` names a section left open or a stray end.
 */
export function withoutEnglish(text) {
  let open = false;
  let sections = 0;
  const problems = [];
  const lines = String(text)
    .split('\n')
    .map((line, index) => {
      const mark = line.trim();
      if (mark === ENGLISH_START) {
        if (open)
          problems.push(`line ${index + 1}: an English section inside one`);
        open = true;
        sections++;
        return '';
      }
      if (mark === ENGLISH_END) {
        if (!open)
          problems.push(
            `line ${index + 1}: an English section's end without its start`,
          );
        open = false;
        return '';
      }
      return open ? '' : line;
    });
  if (open) problems.push('an English section that does not end');
  return { text: lines.join('\n'), sections, problems };
}

/**
 * English words German does not use. Words both languages write (`in`, `an`, `so`, `was`, `will`,
 * `man`, `die`, `also`, `such`, `see`, `war`, `hat`, …) are left out on purpose.
 */
const ENGLISH = new Set(
  (
    'the a and of to is are were be been with for that this these those it its ' +
    'from by or not which when what where who how than then there their they them ' +
    'you your we our can could would should must may might has have had does do did ' +
    'each every any all one only into onto out about after before over under on at as ' +
    'other more most some no yes if but because while until without within first use ' +
    'page pages read reads write writes shows show made makes'
  ).split(/\s+/),
);

/** How many different English words make a line English. */
const THRESHOLD = 3;

/** Attributes whose values are addresses or names, not prose. */
const NOT_PROSE = new Set([
  'href',
  'src',
  'api',
  'lang',
  'id',
  'className',
  'icon',
  'version',
]);

/** A tag's quoted attribute values that are prose; expressions (`{…}`) and addresses are not. */
function tagProse(tag) {
  const values = [];
  for (const m of tag.matchAll(/\b([a-zA-Z]+)=(?:"([^"]*)"|'([^']*)')/g))
    if (!NOT_PROSE.has(m[1])) values.push(m[2] ?? m[3]);
  return values.join(' ');
}

/** A JSX attribute line (`  title="…"`, in a tag spread over lines), reduced to its prose values. */
function attributeProse(line) {
  return /^\s*[a-zA-Z]+=/.test(line) ? tagProse(line) : line;
}

/**
 * A line's prose: without code, URLs, entities and Markdown marks, and HTML or JSX tags reduced to
 * their prose attributes' values (`title`, `description`, …).
 */
export function proseOf(line) {
  return attributeProse(line)
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/<[^>]*>/g, (tag) => ` ${tagProse(tag)} `)
    .replace(/&[#a-z0-9]+;/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>|[\]]/g, ' ');
}

/** The English words of a line, each once, lowercased. */
export function englishWords(line) {
  const words =
    proseOf(line)
      .toLowerCase()
      .match(/[\p{L}’']+/gu) ?? [];
  return [...new Set(words.filter((w) => ENGLISH.has(w)))];
}

/**
 * A page's lines that hold prose: `{ text, index }` (from 0). Fenced code blocks (a fence closes
 * only with its own kind and at least its length), `import` and `export` lines, MDX comments and
 * front matter keys are left out; of the front matter, the title's and description's values stay.
 */
function proseLines(page) {
  const out = [];
  const lines = String(page).split('\n');
  let fence = null;
  let frontMatter = lines[0] === '---';
  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    if (frontMatter) {
      if (index > 0 && line === '---') frontMatter = false;
      const value = /^(title|description):\s*(.*)$/.exec(line)?.[2];
      if (value) out.push({ text: value, line, index });
      return;
    }
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length)
        fence = null;
      return;
    }
    if (fence) return;
    if (/^\s*(import|export)\s/.test(line)) return;
    if (/^\s*\{\/\*.*\*\/\}\s*$/.test(line)) return;
    out.push({ text: line, line, index });
  });
  return out;
}

/**
 * The lines of a German page that read as English: `{ line, text, words }`, the line number from 1.
 */
export function englishProse(text) {
  const found = [];
  for (const { text: prose, line, index } of proseLines(text)) {
    const words = englishWords(prose);
    if (words.length >= THRESHOLD)
      found.push({ line: index + 1, text: line.trim(), words });
  }
  return found;
}

/**
 * English words the German glossary replaces (`frontend/ui/README.md`): a German page says
 * Veröffentlichung, not Release, and Überarbeitung, not Änderungssatz. A word in code or in a
 * link's address does not count.
 */
const GLOSSARY =
  /(?<!\p{L})(Releases?|Änderungssatz(es)?|Änderungssätzen?|Change-?Sets?)(?!\p{L})/gu;

/** The glossary's replaced words on a German page: `{ line, word }`, the line number from 1. */
export function glossaryWords(text) {
  const found = [];
  for (const { text: prose, index } of proseLines(text))
    for (const match of proseOf(prose).matchAll(GLOSSARY))
      found.push({ line: index + 1, word: match[0] });
  return found;
}

/** The cells of a Markdown text's tables, in order: `[table][row][column]`, text as written. */
export function tableCells(text) {
  const tables = [];
  let current = null;
  for (const line of String(text).split('\n')) {
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      current = null;
      continue;
    }
    if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue; // the separator row
    if (!current) {
      current = [];
      tables.push(current);
    }
    current.push(
      line
        .trim()
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
  }
  return tables;
}

/**
 * Whether a cell is the same in every language: code, key caps, numbers and marks, with links and
 * bold taken off, or a name from `keep` (a name the page keeps in every language, such as a role's
 * name as an installation stores it, or a product's like macOS).
 */
export function isIdentifier(cell, keep = []) {
  const text = cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(kbd|code)>.*?<\/\1>/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/\((global)?\s*\)/g, ' ')
    .replace(/[\s,;]+/g, ' ')
    .trim();
  if (text === '' || keep.includes(text)) return true;
  if (/^[\d\s.,:%×+\-–/]+$/.test(text)) return true;
  if (/^[✓✗—–\-·⌘⇧⌥⌃\s]+$/.test(text)) return true;
  return false;
}

/**
 * The cells of the German page's tables that equal the English page's cell at the same place and
 * are no identifier: `{ table, row, column, text }`, each counted from 1. Tables are matched by
 * their order; a German page with other tables than the English one is compared as far as both go.
 */
export function sameCells(english, german, keep = []) {
  const en = tableCells(english);
  const de = tableCells(german);
  const found = [];
  de.forEach((table, t) =>
    table.forEach((row, r) =>
      row.forEach((text, c) => {
        if (en[t]?.[r]?.[c] === text && !isIdentifier(text, keep))
          found.push({ table: t + 1, row: r + 1, column: c + 1, text });
      }),
    ),
  );
  return found;
}
