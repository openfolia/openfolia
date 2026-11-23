-- The index is rebuildable (#45): the commits indexed before it held deprecations (#266) are dropped and indexed again on their next read. The columns are nullable, so a server still running the previous version keeps writing during a rolling deploy.
DELETE FROM "module_index_commits";--> statement-breakpoint
ALTER TABLE "module_index_manuals" ADD COLUMN "deprecated" jsonb;--> statement-breakpoint
ALTER TABLE "module_index_modules" ADD COLUMN "deprecated" jsonb;