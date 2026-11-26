import type { SchemaSql } from '../database/component-schemas.js';

/**
 * What the audit log's migrations write by hand (drizzle-kit tracks neither functions nor
 * triggers), as it stands after the newest of them, for a baseline migration
 * (`database/baseline.ts`). The reasons are in the migrations that made each:
 *
 * - append-only, held by the database (`0002_audit_events`, `0050_audit_sink_retention`): every
 *   UPDATE and TRUNCATE fails; DELETE only through `audit_events_prune` (`ccms.audit_prune`);
 * - `audit_events_stamp` (`0050`): `tx_id` is always the inserting transaction's;
 * - `audit_events_prune` and `audit_events_prune_reads` (`0050`, `0063_audit_read_events`):
 *   retention, SECURITY DEFINER, their search_path pinned to the schema the migration runs in,
 *   EXECUTE revoked from PUBLIC.
 *
 * A test compares a database made from the baseline with one made from the migrations, so a
 * migration that changes any of these changes it here too.
 */
export const AUDIT_SCHEMA_SQL: SchemaSql = {
  after: [
    `CREATE FUNCTION "audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$;`,
    `CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"();`,
    `CREATE FUNCTION "audit_events_stamp"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
	NEW."tx_id" := pg_catalog.pg_current_xact_id();
	RETURN NEW;
END;
$$;`,
    `CREATE TRIGGER "audit_events_stamp" BEFORE INSERT ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "audit_events_stamp"();`,
    `CREATE FUNCTION "audit_events_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF current_setting('ccms.audit_prune', true) = 'on' THEN
		RETURN NULL;
	END IF;
	RAISE EXCEPTION 'audit_events is append-only: DELETE is allowed only through audit_events_prune'
		USING ERRCODE = 'insufficient_privilege';
END;
$$;`,
    `CREATE TRIGGER "audit_events_delete_guard" BEFORE DELETE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_delete_guard"();`,
    `CREATE FUNCTION "audit_events_prune"("before" timestamptz, "max_rows" integer, "kept_tx" xid8 DEFAULT NULL, "kept_id" bigint DEFAULT NULL)
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
$$;`,
    `CREATE FUNCTION "audit_events_prune_reads"("before" timestamptz, "max_rows" integer, "kept_tx" xid8 DEFAULT NULL, "kept_id" bigint DEFAULT NULL)
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
$$;`,
    `DO $$
BEGIN
	EXECUTE format(
		'ALTER FUNCTION %I.audit_events_prune(timestamptz, integer, xid8, bigint) SET search_path = pg_catalog, %I, pg_temp',
		current_schema(), current_schema());
	EXECUTE format(
		'ALTER FUNCTION %I.audit_events_prune_reads(timestamptz, integer, xid8, bigint) SET search_path = pg_catalog, %I, pg_temp',
		current_schema(), current_schema());
END;
$$;`,
    `REVOKE EXECUTE ON FUNCTION "audit_events_prune"(timestamptz, integer, xid8, bigint) FROM PUBLIC;`,
    `REVOKE EXECUTE ON FUNCTION "audit_events_prune_reads"(timestamptz, integer, xid8, bigint) FROM PUBLIC;`,
  ],
};
