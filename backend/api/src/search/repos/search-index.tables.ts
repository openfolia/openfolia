import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Postgres' `tsvector`, written and read as its text form (only ever made and matched in SQL). */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * The Postgres search index (#54, `PostgresContentSearch`): one row per
 * searchable thing (a module in one language, a manual, a term in one
 * language) as its content was, keyed by a hash of that content, so a
 * module that did not change between two commits is the same row and is
 * indexed once. Which rows a search looks at comes from the reader's
 * scope at the commit read, worked out in the server, never from these
 * rows: they hold no scope and say nothing about who may read them.
 * Derived data, rebuilt on demand: `index-rebuild` empties it.
 */
export const searchDocuments = pgTable(
  'search_documents',
  {
    /** `<scheme>:<config>:<contentHash>` (`documentKey`). */
    key: text('key').primaryKey(),
    /** A number for it, as the member sets name it (never reused: a set never names another document). */
    id: bigint('id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .notNull()
      .unique('search_documents_id'),
    /** The text search configuration its text is stemmed with (`english`, `simple`, …). */
    config: text('config').notNull(),
    /** `module`, `manual` or `term`, and the rest of what the filters ask (`SearchFilter`). */
    kind: text('kind').notNull(),
    /** A module's or a term's language; a manual has none. */
    lang: text('lang'),
    /** A module's type, audience and facets (`{ <facet>: [values] }`); null for a manual or a term. */
    moduleType: text('module_type'),
    audience: text('audience'),
    facets: jsonb('facets'),
    /** A module's keywords as `filter[keyword]` compares them (`foldKeyword`). */
    keywordSet: text('keyword_set').array().notNull(),
    /** The title folded (lower case, no diacritics), for typos (`pg_trgm`). */
    titleFolded: text('title_folded').notNull(),
    /** The keywords folded and joined by `, `, for typos. */
    keywordsFolded: text('keywords_folded').notNull(),
    /** The title's words, for telling a title match. */
    titleTsv: tsvector('title_tsv').notNull(),
    /** The title's and the keywords' words, for telling a keyword match. */
    headTsv: tsvector('head_tsv').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'search_documents_kind',
      sql`${t.kind} in ('module', 'manual', 'term')`,
    ),
    index('search_documents_title_trgm').using(
      'gin',
      t.titleFolded.op('gin_trgm_ops'),
    ),
    index('search_documents_keywords_trgm').using(
      'gin',
      t.keywordsFolded.op('gin_trgm_ops'),
    ),
  ],
);

/**
 * A document's parts matched by full text and by meaning: its head
 * (`ord` 0: the title and keywords), then each block with text and each
 * FAQ question, in document order. Every part's `tsv` holds the title
 * (weight A) and the keywords (B) as well as its own text (D, a question
 * C), so every word of a query may be in any of them.
 */
export const searchBlocks = pgTable(
  'search_blocks',
  {
    docKey: text('doc_key')
      .notNull()
      .references(() => searchDocuments.key, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(),
    /** The block (or FAQ entry) ID; null for the head and a term's definition. */
    blockId: text('block_id'),
    kind: text('kind').notNull(),
    tsv: tsvector('tsv').notNull(),
    /** SHA-256 hex of the text embedded for it (`search_texts`). */
    textHash: text('text_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.docKey, t.ord] }),
    index('search_blocks_tsv').using('gin', t.tsv),
    index('search_blocks_text_hash').on(t.textHash),
    check('search_blocks_kind', sql`${t.kind} in ('head', 'text', 'question')`),
  ],
);

/**
 * The texts to embed, by their hash: a part's title, keywords and text,
 * held once however many documents share it. Read only by the embedding
 * job; a search never reads them. A text no part uses any more is marked
 * (`unused_since`) by the sweep and deleted, with its embeddings, once it
 * has been unused for the grace period (#540); indexing it again clears
 * the mark.
 */
export const searchTexts = pgTable(
  'search_texts',
  {
    hash: text('hash').primaryKey(),
    text: text('text').notNull(),
    /** When the sweep (or `index-rebuild`) found no part using it; null while one does. */
    unusedSince: timestamp('unused_since', { withTimezone: true }),
  },
  (t) => [
    check('search_texts_hash', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    index('search_texts_unused_since')
      .on(t.unusedSince)
      .where(sql`${t.unusedSince} is not null`),
  ],
);

/**
 * The embeddings, by model and text hash: a text is embedded once per
 * model, whatever document or commit it is in. Stored as `real[]`, so the
 * table needs no extension; compared as pgvector's `vector(<dimensions>)`
 * (an HNSW index per model, made when an embedder is configured).
 */
export const searchEmbeddings = pgTable(
  'search_embeddings',
  {
    /** `<model>@<dimensions>` (`Embedder.model`). */
    model: text('model').notNull(),
    textHash: text('text_hash').notNull(),
    embedding: real('embedding').array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.model, t.textHash] }),
    // The sweep deletes a text's embeddings of every model with it.
    index('search_embeddings_text_hash').on(t.textHash),
  ],
);

/**
 * The models embeddings were made with, and when a server last had each
 * configured (#540): the sweep drops the embeddings of a model no server
 * has had configured for the grace period (`CCMS_SEARCH_MODEL_KEPT_DAYS`).
 */
export const searchEmbeddingModels = pgTable('search_embedding_models', {
  /** `<model>@<dimensions>` (`Embedder.model`). */
  model: text('model').primaryKey(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A reader's view of a commit: which documents a reader with that reading
 * key may find at that commit, written once per commit and reading key
 * (`scopeDigest`), the first time such a reader searches. A search joins
 * it before anything is ranked, so nothing outside the reader's scope is
 * ranked, counted or returned. The digest names no reader and no scope;
 * scopes unused for the grace period are dropped.
 *
 * Its documents are held as member sets (#643): the scope's documents cut
 * into buckets by their key (`memberSets`), each bucket a set stored once
 * by the hash of its keys, so two commits that differ in a few modules
 * share every set but the few buckets that changed. A scope is one row
 * naming its sets.
 */
export const searchScopes = pgTable(
  'search_scopes',
  {
    /** SHA-256 hex of the scheme, the commit and the reading key. */
    digest: text('digest').primaryKey(),
    /** Its member sets (`search_member_sets.id`): disjoint, together exactly its documents. */
    sets: bigint('sets', { mode: 'number' }).array().notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('search_scopes_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    index('search_scopes_used_at').on(t.usedAt),
    // The sweep asks which scope names a set. Without the pending list
    // (`fastupdate`), which every lookup would read in full until a vacuum.
    index('search_scopes_sets')
      .using('gin', t.sets)
      .with({ fastupdate: false }),
  ],
);

/**
 * A set of documents some scope is made of (#643): one bucket of a
 * scope's documents, keyed by the hash of their keys, shared by every
 * scope with the same documents in that bucket. Says nothing about who
 * may read them: only a scope's digest leads to it.
 */
export const searchMemberSets = pgTable(
  'search_member_sets',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    /** SHA-256 hex of the scheme and its documents' keys, sorted (`memberSets`). */
    hash: text('hash').notNull().unique('search_member_sets_hash'),
    /** Its documents (`search_documents.id`). */
    docs: bigint('docs', { mode: 'number' }).array().notNull(),
  },
  (t) => [
    check('search_member_sets_hash_hex', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    // The sweep asks which set names a document, once per document: without
    // the pending list (`fastupdate`), which each lookup would read in full.
    index('search_member_sets_docs')
      .using('gin', t.docs)
      .with({ fastupdate: false }),
  ],
);
