ALTER TABLE "release_outputs" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "release_outputs" ADD COLUMN "reuse_group" uuid;--> statement-breakpoint
ALTER TABLE "release_outputs" ADD COLUMN "promoted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "release_outputs_pending_idx" ON "release_outputs" USING btree ("release_id") WHERE "release_outputs"."state" in ('queued', 'rendering');--> statement-breakpoint
CREATE INDEX "release_outputs_reuse_group_idx" ON "release_outputs" USING btree ("reuse_group") WHERE "release_outputs"."reuse_group" is not null;--> statement-breakpoint
-- Outputs still to render from before #497 already have their render jobs: count them as
-- scheduled, and make each its own reuse group, so a later release reusing it waits for its file.
UPDATE "release_outputs" SET "scheduled_at" = "created_at", "reuse_group" = "id" WHERE "state" IN ('queued', 'rendering') AND "reuse_group" IS NULL;
