import { z } from 'zod';
import { Block } from './blocks.js';
import { Condition } from './condition.js';
import {
  ProjectConfig,
  StrictProjectConfig,
  VariantAttribute,
} from './config.js';
import { Deprecation } from './deprecation.js';
import { ImportedManifest } from './import/format.js';
import { Inline, Mark } from './inline.js';
import { Manifest, ManifestEntry } from './manifest.js';
import { Module, ModuleMeta } from './module.js';

/**
 * Stable names for the schemas, used when they are converted to JSON
 * Schema (e.g. as OpenAPI components). Without them, recursive parts get
 * generated names like `__schema0`.
 */
const names: [z.ZodType, string][] = [
  [Block, 'Block'],
  [Inline, 'Inline'],
  [Mark, 'Mark'],
  [Condition, 'Condition'],
  [Module, 'Module'],
  [ModuleMeta, 'ModuleMeta'],
  [Deprecation, 'Deprecation'],
  [Manifest, 'Manifest'],
  [ManifestEntry, 'ManifestEntry'],
  [ImportedManifest, 'ImportedManifest'],
  [ProjectConfig, 'ProjectConfig'],
  [StrictProjectConfig, 'StrictProjectConfig'],
  [VariantAttribute, 'VariantAttribute'],
];
for (const [schema, id] of names) {
  if (!z.globalRegistry.has(schema)) z.globalRegistry.add(schema, { id });
}
