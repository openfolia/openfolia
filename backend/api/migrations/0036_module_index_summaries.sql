-- The index is rebuildable (#45): the commits indexed before it held what module summaries and translation status page on (#480) are dropped and indexed again on their next read. Each commit's index now names its format (`INDEX_FORMAT`): one written by a server still running the previous version during a rolling deploy (format 0) is built again, never read or carried over to other commits.
DELETE FROM "module_index_commits";--> statement-breakpoint
ALTER TABLE "module_index_commits" ADD COLUMN "format" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "module_index_modules" ADD COLUMN "digest" text;--> statement-breakpoint
ALTER TABLE "module_index_modules" ADD COLUMN "units" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "module_index_modules" ADD COLUMN "translation" jsonb;