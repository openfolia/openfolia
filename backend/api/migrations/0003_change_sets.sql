CREATE TABLE "change_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_commit" text NOT NULL,
	"branch" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "change_sets_title" CHECK (char_length("change_sets"."title") between 1 and 200),
	CONSTRAINT "change_sets_description" CHECK ("change_sets"."description" is null or char_length("change_sets"."description") between 1 and 10000),
	CONSTRAINT "change_sets_author_kind" CHECK ("change_sets"."author_kind" in ('user', 'service')),
	CONSTRAINT "change_sets_author_id" CHECK (char_length("change_sets"."author_id") between 1 and 200),
	CONSTRAINT "change_sets_base_ref" CHECK (char_length("change_sets"."base_ref") between 1 and 256 and "change_sets"."base_ref" not like 'change-sets/%'),
	CONSTRAINT "change_sets_base_commit" CHECK ("change_sets"."base_commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "change_sets_branch" CHECK ("change_sets"."branch" = 'change-sets/' || "change_sets"."id"::text),
	CONSTRAINT "change_sets_state" CHECK ("change_sets"."state" in ('draft', 'in-review', 'approved', 'merged', 'abandoned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "change_sets_branch_idx" ON "change_sets" USING btree ("branch");--> statement-breakpoint
CREATE INDEX "change_sets_created_idx" ON "change_sets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "change_sets_state_idx" ON "change_sets" USING btree ("state","created_at","id");--> statement-breakpoint
CREATE INDEX "change_sets_author_idx" ON "change_sets" USING btree ("author_id","created_at","id");