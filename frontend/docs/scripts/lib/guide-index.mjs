// The user guide's index (#447, #221): every guide page by its article ID, with its address, title
// and summary (the front matter's `description`) per language. The docs build publishes it as
// `/guide-index.json` (`app/guide-index.json/route.ts`); the editor's build makes the same file
// for its in-app help (`frontend/editor`, the `guide-index` target), which links a screen to its
// page by ID and searches the titles and summaries in the command palette. Read from the
// written pages' front matter and the generated pages' (`guide-reference-pages.mjs`), so neither
// build needs the other.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { GUIDE_REFERENCE_PAGES } from './guide-reference-pages.mjs';

/** The guide's languages, English first: English at the root, the others under `/<lang>/`. */
export const GUIDE_INDEX_LANGUAGES = ['en', 'de'];

/** A page's address in `lang` (`/guide/writing`, `/de/guide/writing`) from its path under `guide/`. */
export function guideAddress(slug, lang) {
  const path = slug === 'index' ? '' : `/${slug.replace(/(^|\/)index$/, '')}`;
  return `${lang === 'en' ? '' : `/${lang}`}/guide${path}`;
}

function mdxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? mdxFiles(join(dir, entry.name))
      : entry.name.endsWith('.mdx')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** A page's front matter as an object; `{}` when it has none or it is not YAML. */
function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return {};
  try {
    const data = parse(match[1] ?? '');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

const text = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * The index of the guide under `docsRoot` (`frontend/docs`): `{ articles, problems }`, the
 * articles sorted by ID. Problems: a page without an `articleId`, two pages with one ID, a
 * translation with another ID than its English page, a page without a title or a summary.
 */
export function readGuideIndex(docsRoot) {
  const guide = join(docsRoot, 'content', 'docs', 'guide');
  /** slug → lang → front matter */
  const pages = new Map();
  for (const file of mdxFiles(guide)) {
    const name = relative(guide, file).replace(/\\/g, '/');
    const lang =
      GUIDE_INDEX_LANGUAGES.find(
        (l) => l !== 'en' && name.endsWith(`.${l}.mdx`),
      ) ?? 'en';
    const slug = name.replace(new RegExp(`(\\.${lang})?\\.mdx$`), '');
    const data = frontMatter(readFileSync(file, 'utf8'));
    if (!pages.has(slug)) pages.set(slug, new Map());
    pages.get(slug).set(lang, data);
  }
  for (const page of Object.values(GUIDE_REFERENCE_PAGES)) {
    pages.set(
      page.slug,
      new Map(
        GUIDE_INDEX_LANGUAGES.map((lang) => [
          lang,
          { ...page[lang], articleId: page.articleId },
        ]),
      ),
    );
  }

  const problems = [];
  const byId = new Map();
  for (const [slug, langs] of [...pages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const en = langs.get('en');
    const where = `guide/${slug}`;
    if (!en) {
      problems.push(`${where}: a translation without an English page`);
      continue;
    }
    const id = text(en.articleId);
    if (!id) {
      problems.push(
        `${where}: a guide page needs an articleId in its front matter`,
      );
      continue;
    }
    if (byId.has(id)) {
      problems.push(
        `${where}: articleId "${id}" is also ${byId.get(id).urls.en}`,
      );
      continue;
    }
    const article = { id, urls: {}, title: {}, summary: {} };
    for (const lang of GUIDE_INDEX_LANGUAGES) {
      const data = langs.get(lang) ?? en;
      if (langs.has(lang) && text(data.articleId) !== id)
        problems.push(
          `${where} (${lang}): another articleId than the English page`,
        );
      const title = text(data.title);
      const summary = text(data.description);
      if (!title) problems.push(`${where} (${lang}): no title`);
      if (!summary) problems.push(`${where} (${lang}): no description`);
      // A page not yet translated: its English page, which exists.
      article.urls[lang] = guideAddress(slug, langs.has(lang) ? lang : 'en');
      article.title[lang] = title ?? '';
      article.summary[lang] = summary ?? '';
    }
    byId.set(id, article);
  }
  return {
    articles: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    problems,
  };
}

/** The index as `/guide-index.json` holds it; throws for any problem, which fails the build. */
export function guideIndex(docsRoot) {
  const { articles, problems } = readGuideIndex(docsRoot);
  if (problems.length > 0)
    throw new Error(`The user guide's index:\n${problems.join('\n')}`);
  return { articles };
}
