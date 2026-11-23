-- Trigram similarity for typos in titles and keywords (#54); a contrib extension of every Postgres build, trusted, so the
-- database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "search_blocks" (
	"doc_key" text NOT NULL,
	"ord" integer NOT NULL,
	"block_id" text,
	"kind" text NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"text_hash" text NOT NULL,
	CONSTRAINT "search_blocks_doc_key_ord_pk" PRIMARY KEY("doc_key","ord"),
	CONSTRAINT "search_blocks_kind" CHECK ("search_blocks"."kind" in ('head', 'text', 'question'))
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"key" text PRIMARY KEY NOT NULL,
	"config" text NOT NULL,
	"kind" text NOT NULL,
	"lang" text,
	"module_type" text,
	"audience" text,
	"facets" jsonb,
	"keyword_set" text[] NOT NULL,
	"title_folded" text NOT NULL,
	"keywords_folded" text NOT NULL,
	"title_tsv" "tsvector" NOT NULL,
	"head_tsv" "tsvector" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_kind" CHECK ("search_documents"."kind" in ('module', 'manual', 'term'))
);
--> statement-breakpoint
CREATE TABLE "search_embeddings" (
	"model" text NOT NULL,
	"text_hash" text NOT NULL,
	"embedding" real[] NOT NULL,
	CONSTRAINT "search_embeddings_model_text_hash_pk" PRIMARY KEY("model","text_hash")
);
--> statement-breakpoint
CREATE TABLE "search_scope_members" (
	"scope" text NOT NULL,
	"doc_key" text NOT NULL,
	CONSTRAINT "search_scope_members_scope_doc_key_pk" PRIMARY KEY("scope","doc_key")
);
--> statement-breakpoint
CREATE TABLE "search_scopes" (
	"digest" text PRIMARY KEY NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_scopes_digest" CHECK ("search_scopes"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "search_texts" (
	"hash" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "search_texts_hash" CHECK ("search_texts"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "search_blocks" ADD CONSTRAINT "search_blocks_doc_key_search_documents_key_fk" FOREIGN KEY ("doc_key") REFERENCES "public"."search_documents"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_scope_members" ADD CONSTRAINT "search_scope_members_scope_search_scopes_digest_fk" FOREIGN KEY ("scope") REFERENCES "public"."search_scopes"("digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_scope_members" ADD CONSTRAINT "search_scope_members_doc_key_search_documents_key_fk" FOREIGN KEY ("doc_key") REFERENCES "public"."search_documents"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_blocks_tsv" ON "search_blocks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_blocks_text_hash" ON "search_blocks" USING btree ("text_hash");--> statement-breakpoint
CREATE INDEX "search_documents_title_trgm" ON "search_documents" USING gin ("title_folded" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_documents_keywords_trgm" ON "search_documents" USING gin ("keywords_folded" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_scope_members_doc_key" ON "search_scope_members" USING btree ("doc_key");--> statement-breakpoint
CREATE INDEX "search_scopes_used_at" ON "search_scopes" USING btree ("used_at");