CREATE TABLE "release_output_sweeps" (
	"id" smallint PRIMARY KEY NOT NULL,
	"after" uuid,
	"version" integer NOT NULL,
	"swept_at" timestamp with time zone NOT NULL,
	CONSTRAINT "release_output_sweeps_one_row" CHECK ("release_output_sweeps"."id" = 1),
	CONSTRAINT "release_output_sweeps_version" CHECK ("release_output_sweeps"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_consumers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"host" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "job_consumers_role" CHECK ("job_consumers"."role" in ('all', 'worker')),
	CONSTRAINT "job_consumers_host" CHECK (char_length("job_consumers"."host") between 1 and 255),
	CONSTRAINT "job_consumers_pid" CHECK ("job_consumers"."pid" >= 0)
);
--> statement-breakpoint
CREATE INDEX "job_consumers_seen" ON "job_consumers" USING btree ("seen_at");