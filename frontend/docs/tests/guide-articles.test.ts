import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { guideAddress, readGuideIndex } from '../scripts/lib/guide-index.mjs';

/**
 * The user guide's written pages (#447): each has an article ID, the same in English and German,
 * every page is in both languages, the screenshots it shows exist in its language, and the links
 * between guide pages lead somewhere. The index of article IDs the editor's help links through
 * (`guide-index.mjs`) is made from them without a problem. The editor's own drift test holds every
 * screen to an ID of that index. The generated references (shortcuts, roles) are held by
 * `guide-references.test.ts`.
 */

const DOCS = join(import.meta.dirname, '..');
const GUIDE = join(DOCS, 'content', 'docs', 'guide');
const IMAGES = join(DOCS, 'public', 'images', 'guide');
/** Pages the docs build generates under the guide (`scripts/generate.mjs`). */
const GENERATED = ['reference/shortcuts', 'reference/roles'];

function mdxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? mdxFiles(join(dir, entry.name))
      : entry.name.endsWith('.mdx')
        ? [join(dir, entry.name)]
        : [],
  );
}

interface Page {
  /** The path under `guide/`, without the language (`writing/blocks`, `index`). */
  readonly slug: string;
  readonly lang: 'en' | 'de';
  readonly text: string;
}

const pages: Page[] = mdxFiles(GUIDE).map((file) => {
  const name = relative(GUIDE, file).replace(/\\/g, '/');
  const lang = name.endsWith('.de.mdx') ? 'de' : 'en';
  return {
    slug: name.replace(/(\.de)?\.mdx$/, ''),
    lang,
    text: readFileSync(file, 'utf8'),
  };
});

const articleId = (page: Page) =>
  /^---\n[\s\S]*?^articleId:\s*'([^']+)'\s*$[\s\S]*?^---$/m.exec(
    page.text,
  )?.[1];

/** A page's address without its language prefix, as a link names it (`guide/writing`). */
const address = (slug: string) =>
  `guide${slug === 'index' ? '' : `/${slug.replace(/\/index$/, '')}`}`;

const addresses = new Set([
  ...pages.map((page) => address(page.slug)),
  ...GENERATED.map(address),
]);

describe('the user guide’s pages', () => {
  it('each have an article ID, one per page, the same in both languages', () => {
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const page of pages) {
      const id = articleId(page);
      if (!id) {
        problems.push(`${page.slug} (${page.lang}): no articleId`);
        continue;
      }
      if (page.lang !== 'en') continue;
      if (seen.has(id))
        problems.push(`${page.slug}: articleId ${id} is also ${seen.get(id)}`);
      seen.set(id, page.slug);
    }
    for (const page of pages.filter((p) => p.lang === 'de')) {
      const en = pages.find((p) => p.lang === 'en' && p.slug === page.slug);
      if (en && articleId(en) !== articleId(page))
        problems.push(`${page.slug}: the German page has another articleId`);
    }
    expect(problems).toEqual([]);
  });

  it('are each in English and German', () => {
    const slugs = (lang: string) =>
      pages
        .filter((page) => page.lang === lang)
        .map((page) => page.slug)
        .sort();
    expect(slugs('de')).toEqual(slugs('en'));
  });

  it('show screenshots that exist, in their own language', () => {
    const problems: string[] = [];
    for (const page of pages)
      for (const [, lang, name] of page.text.matchAll(
        /\]\(\/images\/guide\/([a-z]+)\/([^)\s]+)\)/g,
      )) {
        if (lang !== page.lang)
          problems.push(`${page.slug} (${page.lang}): shows a ${lang} image`);
        if (!existsSync(join(IMAGES, lang ?? '', name ?? '')))
          problems.push(
            `${page.slug} (${page.lang}): no image ${lang}/${name}`,
          );
      }
    expect(problems).toEqual([]);
  });

  it('have the same screenshots in each language', () => {
    expect(readdirSync(join(IMAGES, 'de')).sort()).toEqual(
      readdirSync(join(IMAGES, 'en')).sort(),
    );
  });

  it('link to guide pages that exist, in their own language', () => {
    const problems: string[] = [];
    for (const page of pages)
      for (const [, de, path] of page.text.matchAll(
        /\]\((\/de)?\/(guide(?=[/)#])[^)#\s]*)(?:#[^)\s]*)?\)/g,
      )) {
        if (!addresses.has(path ?? ''))
          problems.push(`${page.slug} (${page.lang}): no page /${path}`);
        if ((de !== undefined) !== (page.lang === 'de'))
          problems.push(
            `${page.slug} (${page.lang}): links to /${de ? 'de/' : ''}${path}`,
          );
      }
    expect(problems).toEqual([]);
  });
});

describe('the user guide’s index', () => {
  // The editor's drift test (`screen-help.spec.ts`) runs only when the editor is affected; this
  // one runs when a guide page moves: every article ID the editor's code names is still a page.
  it('keeps every page the editor links to by its article ID', () => {
    const app = join(DOCS, '../editor/src/app');
    const ids = new Set(readGuideIndex(DOCS).articles.map((a) => a.id));
    const named = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/(?<!\.spec)\.ts$/.test(entry.name))
          for (const [, id] of readFileSync(path, 'utf8').matchAll(
            /'(guide\.[a-z0-9.-]+)'/g,
          ))
            named.set(id ?? '', relative(app, path));
      }
    };
    walk(app);
    expect(named.size).toBeGreaterThan(20);
    expect(
      [...named]
        .filter(([id]) => !ids.has(id))
        .map(([id, file]) => `${file}: ${id}`),
    ).toEqual([]);
  });

  it('lists every page by its ID, with its address, title and summary in each language', () => {
    const { articles, problems } = readGuideIndex(DOCS);
    expect(problems).toEqual([]);
    const english = pages.filter((page) => page.lang === 'en');
    expect(articles).toHaveLength(english.length + GENERATED.length);
    for (const page of english) {
      const article = articles.find((a) => a.id === articleId(page));
      expect(article, page.slug).toBeDefined();
      expect(article?.urls).toEqual({
        en: `/${address(page.slug)}`,
        de: `/de/${address(page.slug)}`,
      });
      for (const lang of ['en', 'de'] as const) {
        expect(article?.title[lang], `${page.slug} ${lang}`).not.toBe('');
        expect(article?.summary[lang], `${page.slug} ${lang}`).not.toBe('');
      }
    }
    expect(articles.map((a) => a.id)).toEqual(
      expect.arrayContaining([
        'guide.reference.shortcuts',
        'guide.reference.roles',
      ]),
    );
  });

  it('names the addresses as the site serves them', () => {
    expect(guideAddress('index', 'en')).toBe('/guide');
    expect(guideAddress('writing/index', 'de')).toBe('/de/guide/writing');
    expect(guideAddress('writing/blocks', 'en')).toBe('/guide/writing/blocks');
  });

  it('refuses a page without an ID, a repeated ID, another ID in German and a missing summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'guide-index-'));
    try {
      const put = (name: string, front: string) => {
        const file = join(root, 'content', 'docs', 'guide', name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `---\n${front}\n---\n\nText.\n`);
      };
      put('a.mdx', "title: 'A'\ndescription: 'About A.'\narticleId: 'guide.a'");
      put(
        'a.de.mdx',
        "title: 'A'\ndescription: 'Über A.'\narticleId: 'guide.b'",
      );
      put('b.mdx', "title: 'B'\ndescription: 'About B.'\narticleId: 'guide.a'");
      put('c.mdx', "title: 'C'\ndescription: 'About C.'");
      put('d.mdx', "title: 'D'\narticleId: 'guide.d'");
      expect(readGuideIndex(root).problems).toEqual([
        'guide/a (de): another articleId than the English page',
        'guide/b: articleId "guide.a" is also /guide/a',
        'guide/c: a guide page needs an articleId in its front matter',
        'guide/d (en): no description',
        'guide/d (de): no description',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
