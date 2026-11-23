CREATE TABLE "search_embedding_models" (
	"model" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_texts" ADD COLUMN "unused_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "search_embeddings_text_hash" ON "search_embeddings" USING btree ("text_hash");--> statement-breakpoint
CREATE INDEX "search_texts_unused_since" ON "search_texts" USING btree ("unused_since") WHERE "search_texts"."unused_since" is not null;