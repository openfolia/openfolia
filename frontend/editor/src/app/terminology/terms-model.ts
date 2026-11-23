import type { Query, Schema } from '../api';
import { moduleIdOf } from '../content/module-id';
export { sameJson } from '../content/module-creation';
import {
  idParam,
  intParam,
  oneOfParam,
  textParam,
  type QueryValues,
} from '../view-state';

/** A term as `GET /terms` lists it, readable. */
export type TermItem = Schema<'TermResource'>;
/** A file in `terms/` that is no term (`meta.error`). */
export type UnreadableTermItem = Schema<'UnreadableTermResource'>;
export type ListedTerm = TermItem | UnreadableTermItem;
/** A module file linking a term (#245), as `GET /terms/:termId` names it. */
export type TermUse = Schema<'TermUse'>;
/** A term's file, as working copies hold it. */
export type TermContent = Schema<'Term'>;
export type TermLanguageEntry = Schema<'TermLanguage'>;
export type TermVariant = Schema<'TermVariant'>;
export type TermDefinition = Schema<'TermDefinition'>;
export type TermStatus = TermContent['status'];

export const TERM_STATUSES: readonly TermStatus[] = [
  'proposed',
  'approved',
  'deprecated',
];

/** The status words, keys written out in full. */
export const STATUS_LABELS: Readonly<Record<TermStatus, string>> = {
  proposed: 'editor.terminology.status.proposed',
  approved: 'editor.terminology.status.approved',
  deprecated: 'editor.terminology.status.deprecated',
};

/** The badge type per status; the word is always shown too, never the colour alone. */
export const STATUS_BADGES: Readonly<
  Record<TermStatus, 'default' | 'secondary' | 'outline' | 'success'>
> = {
  proposed: 'secondary',
  approved: 'success',
  deprecated: 'outline',
};

/** The table's page sizes; the first is the default. */
export const PAGE_SIZES = [25, 50, 100] as const;

/** As the content model has them (`TermId`, `Term`). */
export const TERM_ID_MAX = 100;
export const TERM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_TERM_IDS: readonly string[] = ['export'];
export const VARIANT_MAX = 200;
export const VARIANTS_MAX = 50;
export const DOMAIN_MAX = 100;
export const DEFINITION_MAX = 10_000;

const LANG_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** Whether `id` is a term's ID: a lowercase slug, not a reserved word. */
export function isTermId(id: string): boolean {
  return (
    id.length <= TERM_ID_MAX &&
    TERM_ID.test(id) &&
    !RESERVED_TERM_IDS.includes(id)
  );
}

/**
 * The terminology's view state, in the address: the filters (`lang`, `domain`, `status`, `q`),
 * the page and its size, and the term whose panel is open (`term`, its ID).
 */
export const TERMS_PARAMS = {
  lang: idParam(LANG_TAG),
  domain: textParam({ max: DOMAIN_MAX }),
  status: oneOfParam(TERM_STATUSES),
  q: textParam(),
  page: intParam(1),
  size: intParam(PAGE_SIZES[0], { only: PAGE_SIZES }),
  term: idParam(isTermId),
};

export type TermsView = QueryValues<typeof TERMS_PARAMS>;

/** The query of `GET /terms` for the view. */
export function listQuery(view: TermsView): Query<'/terms'> {
  return {
    ...(view.lang ? { 'filter[lang]': view.lang } : {}),
    ...(view.domain ? { 'filter[domain]': view.domain } : {}),
    ...(view.status ? { 'filter[status]': view.status } : {}),
    ...(view.q ? { 'filter[q]': view.q } : {}),
    'page[number]': view.page,
    'page[size]': view.size,
  };
}

export function isReadable(item: ListedTerm): item is TermItem {
  return !('error' in item.meta);
}

/** A listed term as its file: what the panel shows when it reads no working copy. */
export function contentOf(item: TermItem): TermContent {
  const a = item.attributes;
  return {
    schemaVersion: a.schemaVersion,
    id: item.id,
    status: a.status,
    ...(a.domain === undefined ? {} : { domain: a.domain }),
    ...(a.replacedBy === undefined ? {} : { replacedBy: a.replacedBy }),
    languages: a.languages,
  };
}

/** A file's content as the list shows it: the listed row with the panel's newer content. */
export function withContent(item: TermItem, content: TermContent): TermItem {
  return {
    ...item,
    attributes: {
      schemaVersion: content.schemaVersion,
      status: content.status,
      ...(content.domain === undefined ? {} : { domain: content.domain }),
      ...(content.replacedBy === undefined
        ? {}
        : { replacedBy: content.replacedBy }),
      languages: content.languages,
    },
  };
}

/** A definition as plain text: its runs, a line break as a space. */
export function definitionText(definition: TermDefinition | undefined): string {
  if (!definition) return '';
  return definition
    .map((n) => (n.type === 'text' ? n.text : ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How many characters of text a definition holds (a line break counts one), as the model counts. */
export function definitionLength(definition: TermDefinition): number {
  return definition.reduce(
    (n, node) => n + (node.type === 'text' ? node.text.length : 1),
    0,
  );
}

/** One line as stored: NFC, runs of white space as one space, trimmed. */
export function cleanLine(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** A term ID made from its preferred variant, as a module's from its title. */
export function termIdOf(preferred: string): string {
  const id = moduleIdOf(preferred).slice(0, TERM_ID_MAX).replace(/-+$/, '');
  return RESERVED_TERM_IDS.includes(id) ? `${id}-term` : id;
}

/**
 * The term with `lang`'s entry replaced by `entry`; with none, the language is left out (a term
 * keeps at least one, so the last is never removed: null then).
 */
export function withLanguage(
  term: TermContent,
  lang: string,
  entry: TermLanguageEntry | null,
): TermContent | null {
  const languages = { ...term.languages };
  if (entry) {
    languages[lang] = entry;
  } else {
    delete languages[lang];
    if (Object.keys(languages).length === 0) return null;
  }
  return { ...term, languages };
}

/** The term with another status; a replacement only stays on a deprecated term. */
export function withStatus(
  term: TermContent,
  status: TermStatus,
  replacedBy?: string,
): TermContent {
  const next: TermContent = { ...term, status };
  delete next.replacedBy;
  if (status === 'deprecated' && replacedBy && replacedBy !== term.id) {
    next.replacedBy = replacedBy;
  }
  return next;
}

/** The term with another domain (empty: none). */
export function withDomain(term: TermContent, domain: string): TermContent {
  const next: TermContent = { ...term };
  delete next.domain;
  const clean = cleanLine(domain);
  if (clean) next.domain = clean;
  return next;
}

/**
 * Variants as the chips edit them (their words), kept with the notes they had: a word that stays
 * keeps its note, a new one has none.
 */
export function variantsOf(
  words: readonly string[],
  before: readonly TermVariant[],
): TermVariant[] {
  return words.map((term) => {
    const had = before.find((v) => v.term === term);
    return had ? { ...had } : { term };
  });
}

/** Why a variant cannot be added (a key), or null. */
export function variantProblem(
  word: string,
  words: readonly string[],
): string | null {
  if (word.length > VARIANT_MAX) return 'editor.terminology.variants.tooLong';
  if (words.length >= VARIANTS_MAX)
    return 'editor.terminology.variants.tooMany';
  if (/\p{Cc}/u.test(word)) return 'editor.terminology.variants.invalid';
  return null;
}

/** A new term: one language with its preferred variant, proposed. */
export function newTerm(
  id: string,
  lang: string,
  preferred: string,
  domain: string,
): TermContent {
  const term: TermContent = {
    schemaVersion: 1,
    id,
    status: 'proposed',
    languages: { [lang]: { preferred, allowed: [], forbidden: [] } },
  };
  return withDomain(term, domain);
}
