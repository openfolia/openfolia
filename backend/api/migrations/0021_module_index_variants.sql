-- The index is rebuildable (#45): the commits indexed before it held variant names are dropped and indexed again on their next read. The defaults keep a server still running the previous version writing during a rolling deploy.
DELETE FROM "module_index_commits";--> statement-breakpoint
ALTER TABLE "module_index_manuals" ADD COLUMN "variants" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "module_index_manuals" ADD COLUMN "entry_variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "module_index_modules" ADD COLUMN "variants" jsonb DEFAULT '{}'::jsonb NOT NULL;