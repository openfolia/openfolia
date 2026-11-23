CREATE TABLE "locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"change_set_id" uuid NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	CONSTRAINT "locks_subject" CHECK (("locks"."subject_type" = 'module' and "locks"."subject_id" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*/[a-z0-9]+(-[a-z0-9]+)*$') or ("locks"."subject_type" = 'manual' and "locks"."subject_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
	CONSTRAINT "locks_subject_id" CHECK (char_length("locks"."subject_id") <= 200),
	CONSTRAINT "locks_holder_kind" CHECK ("locks"."holder_kind" in ('user', 'service')),
	CONSTRAINT "locks_holder_id" CHECK (char_length("locks"."holder_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "locks" ADD CONSTRAINT "locks_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "locks_subject_idx" ON "locks" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "locks_since_idx" ON "locks" USING btree ("since","id");--> statement-breakpoint
CREATE INDEX "locks_change_set_idx" ON "locks" USING btree ("change_set_id","since","id");--> statement-breakpoint
CREATE INDEX "locks_holder_idx" ON "locks" USING btree ("holder_id","since","id");