import type { SchemaSql } from '../database/component-schemas.js';
import { MAINTENANCE_LINKS_IMMUTABLE } from '../releases/releases.schema-sql.js';

/**
 * What the change sets' migrations write by hand (drizzle-kit tracks no triggers), for a baseline
 * migration (`database/baseline.ts`): carry-forwards and supersessions are never changed
 * (`0025_maintenance_lines`, `0032_change_set_supersessions`). A test compares a database made
 * from the baseline with one made from the migrations.
 */
export const CHANGE_SETS_SCHEMA_SQL: SchemaSql = {
  after: [
    MAINTENANCE_LINKS_IMMUTABLE,
    `CREATE TRIGGER "change_set_carry_forwards_immutable" BEFORE UPDATE ON "change_set_carry_forwards" FOR EACH ROW EXECUTE FUNCTION "maintenance_links_immutable"();`,
    `CREATE TRIGGER "change_set_supersessions_immutable" BEFORE UPDATE ON "change_set_supersessions" FOR EACH ROW EXECUTE FUNCTION "maintenance_links_immutable"();`,
  ],
};
