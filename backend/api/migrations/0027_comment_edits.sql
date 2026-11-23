ALTER TABLE "comments" DROP CONSTRAINT "comments_body";--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_body" CHECK (("comments"."deleted_at" is null and "comments"."body" is not null and char_length("comments"."body") between 1 and 10000) or ("comments"."deleted_at" is not null and "comments"."body" is null and "comments"."thread_id" = "comments"."id"));