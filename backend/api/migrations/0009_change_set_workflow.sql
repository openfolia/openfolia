CREATE TABLE "change_set_approvals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "change_set_approvals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"change_set_id" uuid NOT NULL,
	"requirement" text NOT NULL,
	"approver_kind" text NOT NULL,
	"approver_id" text NOT NULL,
	"head" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_set_approvals_requirement" CHECK ("change_set_approvals"."requirement" = 'review' or "change_set_approvals"."requirement" ~ '^sign-off/[a-z][a-z0-9-]{0,63}$'),
	CONSTRAINT "change_set_approvals_approver_kind" CHECK ("change_set_approvals"."approver_kind" in ('user', 'service')),
	CONSTRAINT "change_set_approvals_approver_id" CHECK (char_length("change_set_approvals"."approver_id") between 1 and 200),
	CONSTRAINT "change_set_approvals_head" CHECK ("change_set_approvals"."head" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
--> statement-breakpoint
ALTER TABLE "change_sets" ADD COLUMN "review_head" text;--> statement-breakpoint
ALTER TABLE "change_sets" ADD COLUMN "merge_commit" text;--> statement-breakpoint
ALTER TABLE "change_set_approvals" ADD CONSTRAINT "change_set_approvals_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_set_approvals_unique" ON "change_set_approvals" USING btree ("change_set_id","requirement","approver_kind","approver_id");--> statement-breakpoint
CREATE INDEX "change_set_approvals_change_set_idx" ON "change_set_approvals" USING btree ("change_set_id","id");--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_review_head" CHECK ("change_sets"."review_head" is null or "change_sets"."review_head" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_merge_commit" CHECK ("change_sets"."merge_commit" is null or "change_sets"."merge_commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_review_state" CHECK (("change_sets"."state" in ('in-review', 'approved', 'merged')) = ("change_sets"."review_head" is not null) or "change_sets"."state" = 'abandoned');--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_merged" CHECK (("change_sets"."state" = 'merged') = ("change_sets"."merge_commit" is not null));