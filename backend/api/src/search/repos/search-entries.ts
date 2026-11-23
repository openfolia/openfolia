import { createHash } from 'node:crypto';
import {
  definitionText,
  termLanguages,
  textIn,
  walk,
  type Block,
  type Inline,
  type Item,
  type Module,
  type Term,
  type TermLanguage,
} from '@openfolia/content-model';
import {
  filtersModules,
  foldKeyword,
  hasKeywords,
  matchesClassification,
} from '../../content/core/module-filter.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type {
  AskedSearchFilter,
  MatchRange,
  SearchFilter,
  SearchHit,
} from '../core/content-search.js';

/**
 * What both search adapters make of the content a reader may read: one
 * entry per module and language, manual, and term and language, with its
 * text folded for comparing (`InMemoryContentSearch` matches on it,
 * `PostgresContentSearch` indexes it), the filters that narrow a search
 * before anything is matched, and the excerpts of hits.
 */

/** About this many characters of the matching text are returned. */
const EXCERPT_LENGTH = 160;
/** How far before the first match the excerpt starts. */
const EXCERPT_LEAD = 50;
/** How far an excerpt's edge moves to land on a space. */
const EDGE_SNAP = 15;

/** Text folded for comparing, with where each folded character came from. */
export interface Folded {
  text: string;
  /** Per UTF-16 unit of `text`: the start and end of the original character. */
  from: number[];
  to: number[];
}

/**
 * Lower case, no diacritics (`ä` is `a`), `ß` as `ss`. Done per character, so
 * a position in the folded text maps back to one in the original; a
 * character can become none (a combining mark) or several.
 */
export function fold(original: string): Folded {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const character of original) {
    const folded = foldCharacter(character);
    for (let i = 0; i < folded.length; i++) {
      from.push(at);
      to.push(at + character.length);
    }
    text += folded;
    at += character.length;
  }
  return { text, from, to };
}

/** One character folded as `fold` folds it. */
const foldCharacter = (character: string): string =>
  character
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('ß', 'ss');

/**
 * `fold(text).text`, without the positions (an index folds every text it
 * holds, and only an excerpt needs them). Plain ASCII folds as a whole:
 * lower case is all folding does to it.
 */
export function foldText(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(text)) return text.toLowerCase();
  let folded = '';
  for (const character of text) folded += foldCharacter(character);
  return folded;
}

/** The plain text a block or item carries itself (not its children's). */
export function inlineText(content: readonly Inline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'xref':
          return node.text?.map((run) => run.text).join('') ?? '';
        case 'kbd':
          return node.keys.join('+');
        case 'hardBreak':
          return ' ';
        case 'attribute':
          // Its value depends on the variant: not searchable here.
          return '';
        case 'placeholder':
        case 'calloutRef':
          // A placeholder is a page design's value, never in a module (a validation error); a
          // callout reference's number depends on the variant.
          return '';
        default:
          node satisfies never;
          return '';
      }
    })
    .join('');
}

export function ownText(node: Block | Item): string {
  if (!('type' in node)) return inlineText(node.content);
  switch (node.type) {
    case 'paragraph':
      return inlineText(node.content);
    case 'section':
      return inlineText(node.title);
    case 'procedure':
    case 'table':
      return inlineText(node.title);
    case 'image':
      // With its callouts' legends (#546): every one, as a variant block's text is, since the
      // index holds a module for every variant; chunks (`filter[variant]`) keep only those a
      // variant shows.
      return [
        node.alt,
        inlineText(node.title),
        ...(node.callouts ?? []).map((callout) => inlineText(callout.legend)),
      ].join(' ');
    case 'attachment':
      return [node.name, node.description, node.fileName]
        .filter((text) => text !== undefined)
        .join(' ');
    case 'safety':
      return inlineText(node.hazard);
    case 'literal':
      return node.text;
    case 'faq':
      // Indexed as its own field (`questions`), matched before the text.
      return '';
    case 'list':
    case 'admonition':
    case 'variant':
    case 'moduleRef':
    case 'passthrough':
    case 'pageBreak':
      return '';
    default:
      node satisfies never;
      return '';
  }
}

export interface IndexedBlock {
  id: string;
  text: string;
  folded: string;
}

export interface IndexedEntry {
  type: SearchHit['type'];
  id: string;
  lang?: string;
  title: string;
  titleFolded: string;
  blocks: IndexedBlock[];
  /** A module's FAQ entries, by block ID: their questions, a field of their own. */
  questions: IndexedBlock[];
  /** A module's classification, for the filters; a manual and a term have none. */
  meta?: Pick<Module['meta'], 'type' | 'audience' | 'facets'>;
  keywords: string[];
  /** `keywords` folded like titles, for `filter[q]`. */
  keywordsFolded: string[];
  /** `keywords` folded for `filter[keyword]`. */
  keywordSet: Set<string>;
  /** A deprecated module or manual (#266). */
  deprecated?: boolean;
  /**
   * SHA-256 (hex) of everything above that a search matches on (type, ID,
   * language, title, keywords, classification, text): the same for the same
   * content at any commit, so an index keyed by it holds a module that did
   * not change once (`PostgresContentSearch`). Not `deprecated`, which
   * depends on the reader.
   */
  contentHash: string;
}

/** `IndexedEntry.contentHash` of an entry's content. */
function hashOf(
  entry: Omit<IndexedEntry, 'contentHash' | 'keywordSet'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        entry.type,
        entry.id,
        entry.lang ?? null,
        entry.title,
        entry.keywords,
        entry.meta ?? null,
        entry.blocks.map((block) => [block.id, block.text]),
        entry.questions.map((block) => [block.id, block.text]),
      ]),
    )
    .digest('hex');
}

/** An entry with its `contentHash`. */
const hashed = <T extends Omit<IndexedEntry, 'contentHash'>>(
  entry: T,
): T & { contentHash: string } => ({ ...entry, contentHash: hashOf(entry) });

export const entryKey = (entry: IndexedEntry) =>
  `${entry.type}\u0000${entry.lang ?? ''}\u0000${entry.id}`;

/**
 * What `indexModule` made of a module, by the parsed module: the same file
 * at another commit, or read by another reader, is the same object (the
 * content repository parses a file once), so its folded text is held once
 * however many indexes list it. Gone with the module once nothing holds it.
 */
const indexedModules = new WeakMap<Module, IndexedEntry>();

/** `indexModule`, made once per parsed module (`indexedModules`); never changed after. */
export function indexedModule(module: Module): IndexedEntry {
  let entry = indexedModules.get(module);
  if (!entry) {
    entry = indexModule(module);
    indexedModules.set(module, entry);
  }
  return entry;
}

function indexModule(module: Module): IndexedEntry {
  const blocks: IndexedBlock[] = [];
  const questions: IndexedBlock[] = [];
  for (const { kind, node } of walk(module.blocks)) {
    const text = ownText(node).replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ id: node.id, text, folded: foldText(text) });
    if (kind === 'block' && node.type === 'faq') {
      const question = inlineText(node.question).replace(/\s+/g, ' ').trim();
      if (question)
        questions.push({
          id: node.id,
          text: question,
          folded: foldText(question),
        });
    }
  }
  const { title, type, audience, facets } = module.meta;
  const keywords = module.meta.keywords ?? [];
  return hashed({
    type: 'module',
    id: `${module.meta.lang}/${module.id}`,
    lang: module.meta.lang,
    title,
    titleFolded: foldText(title),
    blocks,
    questions,
    meta: { type, audience, facets },
    keywords,
    keywordsFolded: keywords.map(foldText),
    keywordSet: new Set(keywords.map(foldKeyword)),
  });
}

export function matchesIn(
  text: string,
  words: readonly string[],
): MatchRange[] {
  const folded = fold(text);
  const found: MatchRange[] = [];
  for (const word of words) {
    for (
      let at = folded.text.indexOf(word);
      at >= 0;
      at = folded.text.indexOf(word, at + 1)
    ) {
      const start = folded.from[at];
      const end = folded.to[at + word.length - 1];
      if (start !== undefined && end !== undefined) found.push({ start, end });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: MatchRange[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** A stretch of `text` around the first match, with the matches in it as offsets into the stretch. */
export function excerptOf(
  text: string,
  words: readonly string[],
): { excerpt: string; matches: MatchRange[] } {
  return excerptAround(text, matchesIn(text, words));
}

/**
 * A stretch of `text` around the first of `all` (ranges in `text`, in
 * order, not overlapping), with those in it as offsets into the stretch.
 */
export function excerptAround(
  text: string,
  all: readonly MatchRange[],
): { excerpt: string; matches: MatchRange[] } {
  let start = 0;
  let end = text.length;
  if (text.length > EXCERPT_LENGTH) {
    start = Math.max(0, (all[0]?.start ?? 0) - EXCERPT_LEAD);
    end = Math.min(text.length, start + EXCERPT_LENGTH);
    if (start > 0) {
      const space = text.indexOf(' ', start);
      if (space >= 0 && space - start <= EDGE_SNAP) start = space + 1;
    }
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start && end - space <= EDGE_SNAP) end = space;
    }
    // Never cut a surrogate pair in two.
    if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  }
  const matches = all
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({
      start: Math.max(range.start, start) - start,
      end: Math.min(range.end, end) - start,
    }));
  return { excerpt: text.slice(start, end), matches };
}

export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An index's key: one per commit and reading key, never shared by two readers who see differently. */
export const indexKey = (content: ReadableContent) =>
  `${content.commit}|${content.readingKey}`;

export function hitOf(
  entry: IndexedEntry,
  text: string,
  words: readonly string[],
  matchedOn: SearchHit['matchedOn'],
  blockId?: string,
): SearchHit {
  return hitWith(entry, excerptOf(text, words), matchedOn, blockId);
}

/** The hit for `entry`, with its excerpt made already. */
export function hitWith(
  entry: IndexedEntry,
  excerpt: { excerpt: string; matches: MatchRange[] },
  matchedOn: SearchHit['matchedOn'],
  blockId?: string,
): SearchHit {
  return {
    type: entry.type,
    id: entry.id,
    ...(entry.lang === undefined ? {} : { lang: entry.lang }),
    title: entry.title,
    ...(blockId === undefined ? {} : { blockId }),
    ...excerpt,
    matchedOn,
    deprecated: entry.deprecated === true,
  };
}

/** `filter` with the audience levels of `content`'s configuration, for `audience` (#699). */
export async function withAudiences(
  filter: AskedSearchFilter,
  content: ReadableContent,
): Promise<SearchFilter> {
  const { audiences } = await content.config();
  return { ...filter, audiences: audiences.map((a) => a.id) };
}

/**
 * Whether `filter` lets `entry` through: its resource type, its language
 * and (for a module, the only kind they let through) the module filters.
 * `modulesOnly` is `filtersModules(filter)`, worked out once per search.
 */
export function passesFilter(
  entry: IndexedEntry,
  filter: SearchFilter,
  modulesOnly: boolean = filtersModules(filter),
): boolean {
  if (filter.resourceType !== undefined && entry.type !== filter.resourceType) {
    return false;
  }
  if (filter.lang !== undefined && entry.lang !== filter.lang) return false;
  return (
    !modulesOnly ||
    (entry.meta !== undefined &&
      matchesClassification(entry.meta, filter, filter.audiences) &&
      hasKeywords(entry.keywordSet, filter))
  );
}

/**
 * Everything `filter` lets through as a hit (no query: `matchedOn`
 * `filter`, the title as excerpt), by title, then type, language and ID.
 */
export function filterHits(
  entries: readonly IndexedEntry[],
  filter: SearchFilter,
): IndexedEntry[] {
  const modulesOnly = filtersModules(filter);
  return entries
    .filter((entry) => passesFilter(entry, filter, modulesOnly))
    .sort(byTitle);
}

/** By folded title, then type, language and ID: the tie-break of every order. */
export const byTitle = (a: IndexedEntry, b: IndexedEntry): number =>
  compare(a.titleFolded, b.titleFolded) || compare(entryKey(a), entryKey(b));

/**
 * A term in each of its languages: the preferred variant as the title, the
 * allowed and forbidden ones as keywords, the definition as its text.
 */
export function indexTerm(term: Term): IndexedEntry[] {
  return termLanguages(term).map((lang) => {
    const entry = term.languages[lang] as TermLanguage;
    const keywords = [
      ...entry.allowed.map((v) => v.term),
      ...entry.forbidden.map((v) => v.term),
    ];
    const text = definitionText(entry.definition).replace(/\s+/g, ' ').trim();
    return hashed({
      type: 'term',
      id: term.id,
      lang,
      title: entry.preferred,
      titleFolded: foldText(entry.preferred),
      blocks: text ? [{ id: '', text, folded: foldText(text) }] : [],
      questions: [],
      keywords,
      keywordsFolded: keywords.map(foldText),
      keywordSet: new Set(),
    });
  });
}

/** The titles and text of everything `content` lets its actor read. */
export async function buildEntries(
  content: ReadableContent,
): Promise<IndexedEntry[]> {
  const [modules, manuals, terms, config] = await Promise.all([
    content.modules(),
    content.manuals(),
    content.terms(),
    content.config(),
  ]);
  const entries: IndexedEntry[] = [];
  // A module's deprecation is its source-language file's, else its own.
  const { source } = config.languages;
  const bySource = new Map<string, boolean>();
  for (const listing of modules) {
    if ('module' in listing && listing.module.meta.lang === source) {
      bySource.set(listing.id, listing.module.meta.deprecated !== undefined);
    }
  }
  for (const listing of modules) {
    if (!('module' in listing)) continue;
    // A copy of the shared entry: whether it is deprecated depends on what the reader sees.
    entries.push({
      ...indexedModule(listing.module),
      deprecated:
        bySource.get(listing.id) ??
        listing.module.meta.deprecated !== undefined,
    });
  }
  for (const listing of manuals) {
    if ('manifest' in listing) {
      // A search lists without a language (#731): the title in the source language.
      const title = textIn(listing.manifest.title, source, source);
      entries.push(
        hashed({
          type: 'manual',
          id: listing.id,
          title,
          titleFolded: foldText(title),
          blocks: [],
          questions: [],
          keywords: [],
          keywordsFolded: [],
          keywordSet: new Set(),
          deprecated: listing.manifest.deprecated !== undefined,
        }),
      );
    }
  }
  for (const listing of terms) {
    if ('term' in listing) entries.push(...indexTerm(listing.term));
  }
  return entries;
}
