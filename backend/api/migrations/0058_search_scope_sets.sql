-- #643: a scope's documents as shared member sets. Scopes are a rebuildable
-- index: the stored ones are dropped here, and the next search of a commit
-- writes its scope again (its documents stay, numbered below).
ALTER TABLE "search_scope_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "search_scope_members" CASCADE;--> statement-breakpoint
DELETE FROM "search_scopes";--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "search_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "search_scopes" ADD COLUMN "sets" bigint[] NOT NULL;--> statement-breakpoint
CREATE INDEX "search_scopes_sets" ON "search_scopes" USING gin ("sets") WITH (fastupdate=false);--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_id" UNIQUE("id");--> statement-breakpoint
CREATE TABLE "search_member_sets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_member_sets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"hash" text NOT NULL,
	"docs" bigint[] NOT NULL,
	CONSTRAINT "search_member_sets_hash" UNIQUE("hash"),
	CONSTRAINT "search_member_sets_hash_hex" CHECK ("search_member_sets"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "search_member_sets_docs" ON "search_member_sets" USING gin ("docs") WITH (fastupdate=false);