CREATE TABLE "refresh_conflicts" (
	"change_set_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"base" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"saved_at" timestamp with time zone,
	CONSTRAINT "refresh_conflicts_change_set_id_subject_type_subject_id_pk" PRIMARY KEY("change_set_id","subject_type","subject_id"),
	CONSTRAINT "refresh_conflicts_subject" CHECK (("refresh_conflicts"."subject_type" = 'module' and "refresh_conflicts"."subject_id" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$') or ("refresh_conflicts"."subject_type" = 'manual' and "refresh_conflicts"."subject_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$') or ("refresh_conflicts"."subject_type" = 'config' and "refresh_conflicts"."subject_id" = 'ccms.yaml') or ("refresh_conflicts"."subject_type" = 'term' and "refresh_conflicts"."subject_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
	CONSTRAINT "refresh_conflicts_subject_id" CHECK (char_length("refresh_conflicts"."subject_id") <= 200),
	CONSTRAINT "refresh_conflicts_base" CHECK ("refresh_conflicts"."base" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
--> statement-breakpoint
ALTER TABLE "refresh_conflicts" ADD CONSTRAINT "refresh_conflicts_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE cascade ON UPDATE no action;