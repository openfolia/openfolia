CREATE TABLE "release_withdrawals" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"withdrawn_by_kind" text NOT NULL,
	"withdrawn_by_id" text NOT NULL,
	"withdrawn_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "release_withdrawals_by_kind" CHECK ("release_withdrawals"."withdrawn_by_kind" in ('user', 'service')),
	CONSTRAINT "release_withdrawals_by_id" CHECK (char_length("release_withdrawals"."withdrawn_by_id") between 1 and 200),
	CONSTRAINT "release_withdrawals_reason" CHECK (char_length("release_withdrawals"."reason") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "notes_by_language" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "major" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "release_withdrawals" ADD CONSTRAINT "release_withdrawals_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_notes_by_language" CHECK (jsonb_typeof("releases"."notes_by_language") = 'object');--> statement-breakpoint
-- A withdrawal is final, held by the database: never changed or deleted,
-- and the table is never truncated (subscribers were told). Written by
-- hand: drizzle-kit does not track triggers.
CREATE FUNCTION "release_withdrawals_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'a release withdrawal is final: % is not allowed', TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "release_withdrawals_immutable" BEFORE UPDATE OR DELETE ON "release_withdrawals" FOR EACH ROW EXECUTE FUNCTION "release_withdrawals_immutable"();
--> statement-breakpoint
CREATE TRIGGER "release_withdrawals_no_truncate" BEFORE TRUNCATE ON "release_withdrawals" FOR EACH STATEMENT EXECUTE FUNCTION "release_withdrawals_immutable"();
