CREATE TABLE "working_copies" (
	"change_set_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"schema_version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"base_commit" text NOT NULL,
	"version" integer NOT NULL,
	"updated_by_kind" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "working_copies_change_set_id_subject_type_subject_id_pk" PRIMARY KEY("change_set_id","subject_type","subject_id"),
	CONSTRAINT "working_copies_subject" CHECK (("working_copies"."subject_type" = 'module' and "working_copies"."subject_id" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$') or ("working_copies"."subject_type" = 'manual' and "working_copies"."subject_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
	CONSTRAINT "working_copies_subject_id" CHECK (char_length("working_copies"."subject_id") <= 200),
	CONSTRAINT "working_copies_schema_version" CHECK ("working_copies"."schema_version" >= 1),
	CONSTRAINT "working_copies_content" CHECK (jsonb_typeof("working_copies"."content") = 'object' and ("working_copies"."content" ->> 'schemaVersion')::int = "working_copies"."schema_version"),
	CONSTRAINT "working_copies_content_size" CHECK (octet_length("working_copies"."content"::text) <= 2097152),
	CONSTRAINT "working_copies_base_commit" CHECK ("working_copies"."base_commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "working_copies_version" CHECK ("working_copies"."version" >= 1),
	CONSTRAINT "working_copies_updated_by_kind" CHECK ("working_copies"."updated_by_kind" in ('user', 'service')),
	CONSTRAINT "working_copies_updated_by_id" CHECK (char_length("working_copies"."updated_by_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "working_copies" ADD CONSTRAINT "working_copies_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE restrict ON UPDATE no action;