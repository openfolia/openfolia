CREATE TABLE "asset_reference_commits" (
	"commit" text PRIMARY KEY NOT NULL,
	"hashes" text[] NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_reference_commits_commit" CHECK ("asset_reference_commits"."commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "asset_reference_commits_hashes" CHECK (array_position("asset_reference_commits"."hashes", null) is null and array_to_string("asset_reference_commits"."hashes", ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$')
);
--> statement-breakpoint
CREATE INDEX "asset_reference_commits_built_at_idx" ON "asset_reference_commits" USING btree ("built_at");