-- The index is rebuildable (#45): the commits indexed before it held term links (#245) are dropped and indexed again on their next read. The column has a default, so a server still running the previous version keeps writing during a rolling deploy.
DELETE FROM "module_index_commits";--> statement-breakpoint
ALTER TABLE "module_index_modules" ADD COLUMN "terms" jsonb DEFAULT '[]'::jsonb NOT NULL;
