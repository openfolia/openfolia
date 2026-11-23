CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_set_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"block_id" text NOT NULL,
	"commit" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_kind" text,
	"resolved_by_id" text,
	CONSTRAINT "comments_anchor_key" UNIQUE("id","change_set_id","subject_id","block_id"),
	CONSTRAINT "comments_subject" CHECK ("comments"."subject_type" = 'module' and "comments"."subject_id" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$' and char_length("comments"."subject_id") <= 200),
	CONSTRAINT "comments_block_id" CHECK ("comments"."block_id" ~ '^[a-z_][a-z0-9_-]*$' and char_length("comments"."block_id") <= 64),
	CONSTRAINT "comments_commit" CHECK ("comments"."commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "comments_author_kind" CHECK ("comments"."author_kind" in ('user', 'service')),
	CONSTRAINT "comments_author_id" CHECK (char_length("comments"."author_id") between 1 and 200),
	CONSTRAINT "comments_body" CHECK (char_length("comments"."body") between 1 and 10000),
	CONSTRAINT "comments_resolution" CHECK (("comments"."resolved_at" is null and "comments"."resolved_by_kind" is null and "comments"."resolved_by_id" is null) or ("comments"."resolved_at" is not null and "comments"."resolved_by_kind" is not null and "comments"."resolved_by_id" is not null and "comments"."resolved_by_kind" in ('user', 'service') and char_length("comments"."resolved_by_id") between 1 and 200 and "comments"."thread_id" = "comments"."id"))
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thread_fk" FOREIGN KEY ("thread_id","change_set_id","subject_id","block_id") REFERENCES "public"."comments"("id","change_set_id","subject_id","block_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_thread_idx" ON "comments" USING btree ("change_set_id","thread_id","id");--> statement-breakpoint
CREATE INDEX "comments_subject_idx" ON "comments" USING btree ("change_set_id","subject_id","block_id");