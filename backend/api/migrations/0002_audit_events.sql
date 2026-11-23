CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"comment" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_actor_kind" CHECK ("audit_events"."actor_kind" in ('user', 'service')),
	CONSTRAINT "audit_events_actor_id" CHECK (char_length("audit_events"."actor_id") between 1 and 200),
	CONSTRAINT "audit_events_action_format" CHECK (char_length("audit_events"."action") <= 100 and "audit_events"."action" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
	CONSTRAINT "audit_events_subject_type_format" CHECK (char_length("audit_events"."subject_type") <= 64 and "audit_events"."subject_type" ~ '^[a-z][a-z0-9-]*$'),
	CONSTRAINT "audit_events_subject_id" CHECK (char_length("audit_events"."subject_id") between 1 and 500),
	CONSTRAINT "audit_events_comment" CHECK ("audit_events"."comment" is null or char_length("audit_events"."comment") between 1 and 10000),
	CONSTRAINT "audit_events_data_object" CHECK (jsonb_typeof("audit_events"."data") = 'object')
);
--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_type","subject_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_kind","actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","id");--> statement-breakpoint
-- Append-only, held by the database: every UPDATE, DELETE and TRUNCATE on
-- the audit log fails, whatever the app does (statement-level, so even one
-- that matches no row). Written by hand: drizzle-kit does not track triggers.
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"();
