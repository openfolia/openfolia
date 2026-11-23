/**
 * `@openfolia/content-model/core`: the model's types and its schema-free helpers, without zod and yaml.
 * For a browser screen that only reads and shows content: the full entry brings the schemas, and
 * with them zod and yaml (about 540 kB raw), to every screen that imports it (README, "Entry points").
 *
 * Every type of the full entry, the schemas' types included, is here as a type. The values are
 * those of modules that import neither zod nor yaml; `core.spec.ts` holds that. Validating with a
 * schema at run time (`Module.safeParse`) needs the full entry.
 */
export type * from './index.js';

export { AsciidocParseError } from './lib/asciidoc/syntax.js';
export {
  formatCondition,
  parseCondition,
} from './lib/asciidoc/condition-syntax.js';
export * from './lib/callouts.js';
export * from './lib/condition-check.js';
export * from './lib/condition-eval.js';
export * from './lib/delivery.js';
export * from './lib/direction.js';
export * from './lib/facets.js';
export * from './lib/labels.js';
export * from './lib/manifest-units.js';
export * from './lib/localized-text.js';
export * from './lib/config-file.js';
export * from './lib/config-units.js';
export * from './lib/mark-order.js';
export * from './lib/normalize.js';
export * from './lib/page-design-options.js';
export * from './lib/placeholder.js';
export * from './lib/plain-text.js';
export * from './lib/snippet.js';
export * from './lib/style-pattern.js';
export * from './lib/writing-check.js';
export * from './lib/derive.js';
export * from './lib/safety.js';
export * from './lib/structure.js';
export * from './lib/table-limits.js';
export * from './lib/template-file-rules.js';
export * from './lib/translatable-units.js';
export * from './lib/variant-slug.js';
export * from './lib/walk.js';
export * from './lib/block-places.js';
