ALTER TABLE "asset_uploads" DROP CONSTRAINT "asset_uploads_content_type";--> statement-breakpoint
ALTER TABLE "asset_uploads" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "asset_uploads" ADD CONSTRAINT "asset_uploads_file_name" CHECK ("asset_uploads"."file_name" is null or char_length("asset_uploads"."file_name") between 1 and 255);--> statement-breakpoint
ALTER TABLE "asset_uploads" ADD CONSTRAINT "asset_uploads_content_type" CHECK ("asset_uploads"."content_type" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$');