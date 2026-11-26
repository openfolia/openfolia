import type { SchemaSql } from '../database/component-schemas.js';

/**
 * What the search's migration writes by hand, for a baseline migration (`database/baseline.ts`):
 * the trigram extension its title and keyword indexes use (`0045_search_index`), before the
 * tables.
 */
export const SEARCH_SCHEMA_SQL: SchemaSql = {
  before: ['CREATE EXTENSION IF NOT EXISTS pg_trgm;'],
};
