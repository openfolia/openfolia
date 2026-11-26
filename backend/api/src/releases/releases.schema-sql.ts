import type { SchemaSql } from '../database/component-schemas.js';

/**
 * The trigger function of the rows that link change sets and releases to maintenance lines,
 * which are never changed (`0025_maintenance_lines`). Change sets use it too (their carry-forwards
 * and supersessions), so both components list it; a baseline writes it once.
 */
export const MAINTENANCE_LINKS_IMMUTABLE = `CREATE FUNCTION "maintenance_links_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;`;

/**
 * What the releases' migrations write by hand (drizzle-kit tracks no triggers), as it stands after
 * the newest of them, for a baseline migration (`database/baseline.ts`); held by the database:
 *
 * - a release is immutable once published (`0017_releases`);
 * - a withdrawal is final (`0023_release_notes`);
 * - a maintenance line changes only by closing it, once, and its releases never change
 *   (`0025_maintenance_lines`).
 *
 * A test compares a database made from the baseline with one made from the migrations.
 */
export const RELEASES_SCHEMA_SQL: SchemaSql = {
  after: [
    `CREATE FUNCTION "releases_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'TRUNCATE' THEN
		RAISE EXCEPTION 'releases cannot be truncated'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."tag_object" IS NOT NULL THEN
		RAISE EXCEPTION 'release % is published: % is not allowed', OLD."id", TG_OP
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	IF NEW."tag_object" IS NULL
		OR (to_jsonb(NEW) - 'tag_object') IS DISTINCT FROM (to_jsonb(OLD) - 'tag_object') THEN
		RAISE EXCEPTION 'a reserved release % may only be published', OLD."id"
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;`,
    `CREATE TRIGGER "releases_immutable" BEFORE UPDATE OR DELETE ON "releases" FOR EACH ROW EXECUTE FUNCTION "releases_immutable"();`,
    `CREATE TRIGGER "releases_no_truncate" BEFORE TRUNCATE ON "releases" FOR EACH STATEMENT EXECUTE FUNCTION "releases_immutable"();`,
    `CREATE FUNCTION "release_withdrawals_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'a release withdrawal is final: % is not allowed', TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$;`,
    `CREATE TRIGGER "release_withdrawals_immutable" BEFORE UPDATE OR DELETE ON "release_withdrawals" FOR EACH ROW EXECUTE FUNCTION "release_withdrawals_immutable"();`,
    `CREATE TRIGGER "release_withdrawals_no_truncate" BEFORE TRUNCATE ON "release_withdrawals" FOR EACH STATEMENT EXECUTE FUNCTION "release_withdrawals_immutable"();`,
    `CREATE FUNCTION "maintenance_lines_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'TRUNCATE' THEN
		RAISE EXCEPTION 'maintenance lines cannot be truncated'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'maintenance line % is never deleted', OLD."id"
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."closed_at" IS NOT NULL OR NEW."closed_at" IS NULL
		OR (NEW."id", NEW."product", NEW."revision", NEW."base_release", NEW."base_commit", NEW."branch", NEW."created_by_kind", NEW."created_by_id", NEW."created_at")
			IS DISTINCT FROM (OLD."id", OLD."product", OLD."revision", OLD."base_release", OLD."base_commit", OLD."branch", OLD."created_by_kind", OLD."created_by_id", OLD."created_at") THEN
		RAISE EXCEPTION 'maintenance line % changes only by closing it, once', OLD."id"
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;`,
    `CREATE TRIGGER "maintenance_lines_guard" BEFORE UPDATE OR DELETE ON "maintenance_lines" FOR EACH ROW EXECUTE FUNCTION "maintenance_lines_guard"();`,
    `CREATE TRIGGER "maintenance_lines_no_truncate" BEFORE TRUNCATE ON "maintenance_lines" FOR EACH STATEMENT EXECUTE FUNCTION "maintenance_lines_guard"();`,
    MAINTENANCE_LINKS_IMMUTABLE,
    `CREATE TRIGGER "maintenance_line_releases_immutable" BEFORE UPDATE ON "maintenance_line_releases" FOR EACH ROW EXECUTE FUNCTION "maintenance_links_immutable"();`,
  ],
};
