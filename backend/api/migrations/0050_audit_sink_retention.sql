CREATE TABLE "audit_sink" (
	"name" text PRIMARY KEY NOT NULL,
	"last_tx_id" "xid8" DEFAULT '0'::xid8 NOT NULL,
	"last_id" bigint DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_until" timestamp with time zone,
	"blocked" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_sink_name" CHECK ("audit_sink"."name" = 'sink'),
	CONSTRAINT "audit_sink_last_id" CHECK ("audit_sink"."last_id" >= 0),
	CONSTRAINT "audit_sink_claimed_by" CHECK ("audit_sink"."claimed_by" is null or char_length("audit_sink"."claimed_by") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "tx_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_events_tx_id_idx" ON "audit_events" USING btree ("tx_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");
--> statement-breakpoint
-- The sink's order (#379), written by hand: `tx_id` is always the inserting
-- transaction's, whatever an INSERT gives, so no caller can place an event
-- ahead of the ones to come (and so blind the sink past its cursor).
CREATE FUNCTION "audit_events_stamp"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
	NEW."tx_id" := pg_catalog.pg_current_xact_id();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_stamp" BEFORE INSERT ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "audit_events_stamp"();
--> statement-breakpoint
-- Retention (#379), written by hand: drizzle-kit tracks neither triggers nor
-- functions. UPDATE and TRUNCATE stay refused for everyone, as before. DELETE
-- is refused too unless the transaction-local flag `ccms.audit_prune` is on,
-- which only `audit_events_prune` sets. The flag is a second line only: any
-- session may set a setting of that name itself. The guard that holds is the
-- grants (backend/api/README.md, "Audit log"): the API's role has no DELETE on
-- audit_events, only EXECUTE on the function, which runs as its owner.
DROP TRIGGER "audit_events_append_only" ON "audit_events";
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"();
--> statement-breakpoint
CREATE FUNCTION "audit_events_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF current_setting('ccms.audit_prune', true) = 'on' THEN
		RETURN NULL;
	END IF;
	RAISE EXCEPTION 'audit_events is append-only: DELETE is allowed only through audit_events_prune'
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_delete_guard" BEFORE DELETE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_delete_guard"();
--> statement-breakpoint
-- Removes up to max_rows of the oldest events recorded before `before` (and,
-- when kept_tx and kept_id are given, none after that sink position: events
-- not sent yet), records the removal as an `audit-log.prune` event in the same
-- transaction, and answers how many it removed. Refuses a `before` less than a
-- day back (23 hours, for clocks apart), whoever calls it: the newest day is
-- never removed. SECURITY
-- DEFINER: it runs as its owner (who made the table), so the API's role needs
-- EXECUTE only, never DELETE; its search_path is pinned below.
CREATE FUNCTION "audit_events_prune"("before" timestamptz, "max_rows" integer, "kept_tx" xid8 DEFAULT NULL, "kept_id" bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
	removed integer;
	first_id bigint;
	last_id bigint;
BEGIN
	-- 23 hours, not 24: a period of one day still runs on an API host whose
	-- clock is somewhat ahead of the database's.
	IF "before" IS NULL OR "before" > now() - interval '23 hours' THEN
		RAISE EXCEPTION 'audit_events_prune: before must lie at least 23 hours back'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	IF "max_rows" IS NULL OR "max_rows" < 1 OR "max_rows" > 10000 THEN
		RAISE EXCEPTION 'audit_events_prune: max_rows must be from 1 to 10000'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	IF ("kept_tx" IS NULL) <> ("kept_id" IS NULL) THEN
		RAISE EXCEPTION 'audit_events_prune: kept_tx and kept_id go together'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	-- A sink position past every transaction of this database (one restored
	-- from another server's backup), or a sink found so before (`blocked`, kept
	-- until the operator's recipe clears it): which events it covers is unknown,
	-- so nothing is removed until the operator sets it right (backend/api/README.md).
	IF "kept_tx" IS NOT NULL AND ("kept_tx" >= pg_snapshot_xmax(pg_current_snapshot())
			OR EXISTS (SELECT 1 FROM "audit_sink" WHERE "blocked")) THEN
		RAISE EXCEPTION 'audit_events_prune: the sink position lies ahead of this database''s transactions'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	PERFORM set_config('ccms.audit_prune', 'on', true);
	WITH "doomed" AS (
		SELECT "id" FROM "audit_events"
		WHERE "at" < "before"
			AND ("kept_tx" IS NULL OR ("tx_id", "id") <= ("kept_tx", "kept_id"))
		ORDER BY "at", "id"
		LIMIT "max_rows"
	), "gone" AS (
		DELETE FROM "audit_events" WHERE "id" IN (SELECT "id" FROM "doomed")
		RETURNING "id"
	)
	SELECT count(*)::integer, min("id"), max("id") INTO removed, first_id, last_id FROM "gone";
	PERFORM set_config('ccms.audit_prune', '', true);
	IF removed > 0 THEN
		INSERT INTO "audit_events" ("actor_kind", "actor_id", "action", "subject_type", "subject_id", "data")
		VALUES ('service', 'audit-retention', 'audit-log.prune', 'audit-log', 'audit-events',
			jsonb_build_object(
				'before', to_char("before" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
				'removed', removed,
				'firstId', first_id::text,
				'lastId', last_id::text));
	END IF;
	RETURN removed;
END;
$$;
--> statement-breakpoint
-- Pinned: the built-ins first (nothing can shadow now() or count()), then the
-- schema the migrations run in, pg_temp last, so no caller's search_path can
-- put a table or function of its own in front.
DO $$
BEGIN
	EXECUTE format(
		'ALTER FUNCTION %I.audit_events_prune(timestamptz, integer, xid8, bigint) SET search_path = pg_catalog, %I, pg_temp',
		current_schema(), current_schema());
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "audit_events_prune"(timestamptz, integer, xid8, bigint) FROM PUBLIC;
