import type { SchemaSql } from '../database/component-schemas.js';

/**
 * What the storage usage's migration writes by hand, for a baseline migration
 * (`database/baseline.ts`): its one row, with nothing counted yet (`0030_storage_usage`).
 */
export const STORAGE_USAGE_SCHEMA_SQL: SchemaSql = {
  after: [
    `INSERT INTO "storage_usage" ("id", "media_bytes", "media_files", "pdf_bytes", "pdf_files") VALUES (1, 0, 0, 0, 0);`,
  ],
};
