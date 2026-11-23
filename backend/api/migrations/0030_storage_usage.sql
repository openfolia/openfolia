CREATE TABLE "storage_usage" (
	"id" smallint PRIMARY KEY NOT NULL,
	"media_bytes" bigint NOT NULL,
	"media_files" bigint NOT NULL,
	"pdf_bytes" bigint NOT NULL,
	"pdf_files" bigint NOT NULL,
	"media_added_bytes" bigint DEFAULT 0 NOT NULL,
	"media_added_files" bigint DEFAULT 0 NOT NULL,
	"pdf_added_bytes" bigint DEFAULT 0 NOT NULL,
	"pdf_added_files" bigint DEFAULT 0 NOT NULL,
	"git_bytes" bigint,
	"database_bytes" bigint,
	"recounted_at" timestamp with time zone,
	"recount_claimed_at" timestamp with time zone,
	"limit_bytes" bigint,
	CONSTRAINT "storage_usage_one_row" CHECK ("storage_usage"."id" = 1),
	CONSTRAINT "storage_usage_counts" CHECK ("storage_usage"."media_bytes" >= 0 and "storage_usage"."media_files" >= 0 and "storage_usage"."pdf_bytes" >= 0 and "storage_usage"."pdf_files" >= 0 and "storage_usage"."media_added_bytes" >= 0 and "storage_usage"."media_added_files" >= 0 and "storage_usage"."pdf_added_bytes" >= 0 and "storage_usage"."pdf_added_files" >= 0),
	CONSTRAINT "storage_usage_sizes" CHECK (("storage_usage"."git_bytes" is null or "storage_usage"."git_bytes" >= 0) and ("storage_usage"."database_bytes" is null or "storage_usage"."database_bytes" >= 0)),
	CONSTRAINT "storage_usage_limit" CHECK ("storage_usage"."limit_bytes" is null or "storage_usage"."limit_bytes" > 0)
);
--> statement-breakpoint
-- The one row of totals; the first recount (a minute after start-up) fills it in.
INSERT INTO "storage_usage" ("id", "media_bytes", "media_files", "pdf_bytes", "pdf_files") VALUES (1, 0, 0, 0, 0);
