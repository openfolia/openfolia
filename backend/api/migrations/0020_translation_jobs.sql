CREATE TABLE "translation_job_units" (
	"job_id" uuid NOT NULL,
	"lang" text NOT NULL,
	"module_id" text NOT NULL,
	"block_id" text NOT NULL,
	"position" integer NOT NULL,
	"source_hash" text NOT NULL,
	"words" integer NOT NULL,
	"open" boolean NOT NULL,
	CONSTRAINT "translation_job_units_job_id_lang_module_id_block_id_pk" PRIMARY KEY("job_id","lang","module_id","block_id"),
	CONSTRAINT "translation_job_units_source_hash" CHECK ("translation_job_units"."source_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "translation_job_units_words" CHECK ("translation_job_units"."words" >= 0),
	CONSTRAINT "translation_job_units_position" CHECK ("translation_job_units"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "translation_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_lang" text NOT NULL,
	"languages" text[] NOT NULL,
	"subject" jsonb NOT NULL,
	"ref" text NOT NULL,
	"commit" text NOT NULL,
	"released" boolean NOT NULL,
	"due_date" date,
	"state" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "translation_jobs_languages" CHECK (cardinality("translation_jobs"."languages") between 1 and 100),
	CONSTRAINT "translation_jobs_ref" CHECK (char_length("translation_jobs"."ref") between 1 and 256),
	CONSTRAINT "translation_jobs_commit" CHECK ("translation_jobs"."commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "translation_jobs_state" CHECK ("translation_jobs"."state" in ('sent', 'returned', 'cancelled')),
	CONSTRAINT "translation_jobs_created_by_kind" CHECK ("translation_jobs"."created_by_kind" in ('user', 'service')),
	CONSTRAINT "translation_jobs_created_by_id" CHECK (char_length("translation_jobs"."created_by_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "translation_job_units" ADD CONSTRAINT "translation_job_units_job_fk" FOREIGN KEY ("job_id") REFERENCES "public"."translation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "translation_job_units_open_idx" ON "translation_job_units" USING btree ("lang","module_id","block_id") WHERE "translation_job_units"."open";--> statement-breakpoint
CREATE INDEX "translation_jobs_created_idx" ON "translation_jobs" USING btree ("created_at","id");