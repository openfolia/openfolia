ALTER TABLE "audit_events" ADD COLUMN "kind" text DEFAULT 'write' NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_events_kind_idx" ON "audit_events" USING btree ("kind","id");--> statement-breakpoint
CREATE INDEX "audit_events_kind_at_idx" ON "audit_events" USING btree ("kind","at","id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_kind" CHECK ("audit_events"."kind" in ('write', 'read') and ("audit_events"."kind" = 'read') = ("audit_events"."action" in ('api.read', 'api.read-gap')));--> statement-breakpoint
-- Read events (#877), written by hand: drizzle-kit tracks no functions.
-- Changes and reads are kept for periods of their own, so retention removes
-- them apart. `audit_events_prune` now removes changes only (CREATE OR
-- REPLACE keeps its owner and grants); `audit_events_prune_reads` is its
-- twin for reads, recording its removals as `audit-log.prune` too, with
-- `kind: "read"` in `data`. Every rule of `0050_audit_sink_retention`
-- holds for both: a `before` at least 23 hours back, at most 10,000 rows a
-- call, never past the sink's position, nothing while the sink is blocked.
CREATE OR REPLACE FUNCTION "audit_events_prune"("before" timestamptz, "max_rows" integer, "kept_tx" xid8 DEFAULT NULL, "kept_id" bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
	removed integer;
	first_id bigint;
	last_id bigint;
BEGIN
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
	IF "kept_tx" IS NOT NULL AND ("kept_tx" >= pg_snapshot_xmax(pg_current_snapshot())
			OR EXISTS (SELECT 1 FROM "audit_sink" WHERE "blocked")) THEN
		RAISE EXCEPTION 'audit_events_prune: the sink position lies ahead of this database''s transactions'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	PERFORM set_config('ccms.audit_prune', 'on', true);
	WITH "doomed" AS (
		SELECT "id" FROM "audit_events"
		WHERE "kind" = 'write' AND "at" < "before"
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
CREATE FUNCTION "audit_events_prune_reads"("before" timestamptz, "max_rows" integer, "kept_tx" xid8 DEFAULT NULL, "kept_id" bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
	removed integer;
	first_id bigint;
	last_id bigint;
BEGIN
	IF "before" IS NULL OR "before" > now() - interval '23 hours' THEN
		RAISE EXCEPTION 'audit_events_prune_reads: before must lie at least 23 hours back'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	IF "max_rows" IS NULL OR "max_rows" < 1 OR "max_rows" > 10000 THEN
		RAISE EXCEPTION 'audit_events_prune_reads: max_rows must be from 1 to 10000'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	IF ("kept_tx" IS NULL) <> ("kept_id" IS NULL) THEN
		RAISE EXCEPTION 'audit_events_prune_reads: kept_tx and kept_id go together'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	IF "kept_tx" IS NOT NULL AND ("kept_tx" >= pg_snapshot_xmax(pg_current_snapshot())
			OR EXISTS (SELECT 1 FROM "audit_sink" WHERE "blocked")) THEN
		RAISE EXCEPTION 'audit_events_prune_reads: the sink position lies ahead of this database''s transactions'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	PERFORM set_config('ccms.audit_prune', 'on', true);
	WITH "doomed" AS (
		SELECT "id" FROM "audit_events"
		WHERE "kind" = 'read' AND "action" IN ('api.read', 'api.read-gap') AND "at" < "before"
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
				'lastId', last_id::text,
				'kind', 'read'));
	END IF;
	RETURN removed;
END;
$$;
--> statement-breakpoint
-- Pinned as in 0050 (CREATE OR REPLACE drops a function's SET clauses), and
-- the new function granted to every role that may run the old one, so a
-- deployment's separate API role keeps removing both kinds after the upgrade.
DO $$
DECLARE
	grantee regrole;
BEGIN
	EXECUTE format(
		'ALTER FUNCTION %I.audit_events_prune(timestamptz, integer, xid8, bigint) SET search_path = pg_catalog, %I, pg_temp',
		current_schema(), current_schema());
	EXECUTE format(
		'ALTER FUNCTION %I.audit_events_prune_reads(timestamptz, integer, xid8, bigint) SET search_path = pg_catalog, %I, pg_temp',
		current_schema(), current_schema());
	FOR grantee IN
		SELECT a.grantee::regrole FROM pg_proc p, aclexplode(p.proacl) a
		WHERE p.oid = 'audit_events_prune(timestamptz, integer, xid8, bigint)'::regprocedure
			AND a.privilege_type = 'EXECUTE' AND a.grantee <> 0 AND a.grantee <> p.proowner
	LOOP
		EXECUTE format(
			'GRANT EXECUTE ON FUNCTION audit_events_prune_reads(timestamptz, integer, xid8, bigint) TO %s',
			grantee);
	END LOOP;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "audit_events_prune_reads"(timestamptz, integer, xid8, bigint) FROM PUBLIC;
