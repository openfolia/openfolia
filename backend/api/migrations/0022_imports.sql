CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"importer_id" text NOT NULL,
	"options" jsonb NOT NULL,
	"update_existing" boolean NOT NULL,
	"base_ref" text NOT NULL,
	"base_commit" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"file_name" text,
	"upload_sha256" text NOT NULL,
	"upload_size" bigint NOT NULL,
	"upload_created" boolean NOT NULL,
	"state" text NOT NULL,
	"report" jsonb NOT NULL,
	"change_set_id" uuid,
	"progress" jsonb NOT NULL,
	"failure" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "imports_importer_id" CHECK ("imports"."importer_id" ~ '^[a-z][a-z0-9-]*$' and char_length("imports"."importer_id") <= 64),
	CONSTRAINT "imports_base_ref" CHECK (char_length("imports"."base_ref") between 1 and 256 and "imports"."base_ref" not like 'change-sets/%'),
	CONSTRAINT "imports_base_commit" CHECK ("imports"."base_commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "imports_created_by_kind" CHECK ("imports"."created_by_kind" in ('user', 'service')),
	CONSTRAINT "imports_created_by_id" CHECK (char_length("imports"."created_by_id") between 1 and 200),
	CONSTRAINT "imports_file_name" CHECK ("imports"."file_name" is null or char_length("imports"."file_name") between 1 and 255),
	CONSTRAINT "imports_upload_sha256" CHECK ("imports"."upload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "imports_upload_size" CHECK ("imports"."upload_size" >= 0),
	CONSTRAINT "imports_state" CHECK ("imports"."state" in ('validated', 'applying', 'applied', 'failed')),
	CONSTRAINT "imports_failure" CHECK (("imports"."state" = 'failed') = ("imports"."failure" is not null))
);
--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imports_expires_idx" ON "imports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "imports_upload_idx" ON "imports" USING btree ("upload_sha256");