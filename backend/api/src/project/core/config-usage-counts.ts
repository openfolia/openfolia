import {
  walk,
  type Condition,
  type Manifest,
  type ManifestEntry,
  type Module,
  type ProjectConfig,
} from '@openfolia/content-model';

/** What a configured value is: the part of `openfolia.yaml` it belongs to. */
export type ConfigValueKind =
  | 'language'
  | 'moduleType'
  | 'audience'
  | 'facet'
  | 'facetValue'
  | 'variantAttribute'
  | 'variantValue'
  | 'textAttribute'
  | 'safetySymbol'
  | 'calloutStyle';

/** How much content uses one configured value. */
export interface ConfigValueUsage {
  readonly kind: ConfigValueKind;
  /** The value's ID (a language tag for a language). */
  readonly valueId: string;
  /** The facet or variant attribute a value belongs to; absent for the others. */
  readonly parentId?: string;
  /** Module IDs (any language counts once) whose files name it. */
  readonly modules: number;
  /** Manuals whose manifests name it. */
  readonly manuals: number;
}

/** A configured value's key: `<kind>/<id>` or `<kind>/<parent>/<id>`. */
export const usageKey = (
  kind: ConfigValueKind,
  valueId: string,
  parentId?: string,
): string =>
  parentId === undefined
    ? `${kind}/${valueId}`
    : `${kind}/${parentId}/${valueId}`;

/** The keys a condition names: the attributes, and the values an `in` test lists. */
function conditionKeys(condition: Condition, into: Set<string>): void {
  switch (condition.op) {
    case 'all':
    case 'any':
      for (const c of condition.of) conditionKeys(c, into);
      return;
    case 'not':
      conditionKeys(condition.of, into);
      return;
    case 'in':
      into.add(usageKey('variantAttribute', condition.attr));
      for (const v of condition.values) {
        into.add(usageKey('variantValue', v, condition.attr));
      }
      return;
    case 'cmp':
      into.add(usageKey('variantAttribute', condition.attr));
      return;
  }
}

/** Text attributes named anywhere in inline content (`{type: "attribute", name}`), found by shape. */
function attributeKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) attributeKeys(v, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node['type'] === 'attribute' && typeof node['name'] === 'string') {
    into.add(usageKey('textAttribute', node['name']));
    return;
  }
  for (const child of Object.values(node)) attributeKeys(child, into);
}

/** Every configured value one module file names: its language, type, audience, facets, and what its blocks name. */
export function moduleUsageKeys(module: Module): Set<string> {
  const keys = new Set<string>();
  const { meta } = module;
  keys.add(usageKey('language', meta.lang));
  keys.add(usageKey('moduleType', meta.type));
  if (meta.audience !== undefined)
    keys.add(usageKey('audience', meta.audience));
  for (const [facet, values] of Object.entries(meta.facets)) {
    keys.add(usageKey('facet', facet));
    for (const v of values) keys.add(usageKey('facetValue', v, facet));
  }
  for (const { kind, node } of walk(module.blocks)) {
    if (kind !== 'block') continue;
    if (node.type === 'variant') conditionKeys(node.when, keys);
    if (node.type === 'image') {
      for (const c of node.callouts ?? []) {
        if (c.when) conditionKeys(c.when, keys);
        if (c.style !== undefined) keys.add(usageKey('calloutStyle', c.style));
      }
    }
    if (node.type === 'safety') {
      for (const s of node.symbols) keys.add(usageKey('safetySymbol', s));
    }
  }
  attributeKeys(module.blocks, keys);
  return keys;
}

/** Every configured value one manifest names: its audience, variants, text attributes and conditions. */
export function manifestUsageKeys(manifest: Manifest): Set<string> {
  const keys = new Set<string>();
  if (manifest.audience !== undefined) {
    keys.add(usageKey('audience', manifest.audience));
  }
  for (const variant of manifest.variants) {
    for (const [attr, value] of Object.entries(variant)) {
      keys.add(usageKey('variantAttribute', attr));
      keys.add(usageKey('variantValue', value, attr));
    }
  }
  for (const [name, value] of Object.entries(manifest.attributes)) {
    keys.add(usageKey('textAttribute', name));
    if (typeof value !== 'string') {
      for (const option of value) {
        if (option.when) conditionKeys(option.when, keys);
      }
    }
  }
  const entries = (list: readonly ManifestEntry[]): void => {
    for (const entry of list) {
      if (entry.when) conditionKeys(entry.when, keys);
      if ('entries' in entry) entries(entry.entries);
    }
  };
  entries(manifest.entries);
  return keys;
}

/** Every value `config` defines, in its order: what the usage list has one entry for. */
export function configuredValues(
  config: ProjectConfig,
): { kind: ConfigValueKind; valueId: string; parentId?: string }[] {
  return [
    ...[config.languages.source, ...config.languages.targets].map((id) => ({
      kind: 'language' as const,
      valueId: id,
    })),
    ...config.moduleTypes.map((t) => ({
      kind: 'moduleType' as const,
      valueId: t.id,
    })),
    ...config.audiences.map((a) => ({
      kind: 'audience' as const,
      valueId: a.id,
    })),
    ...config.facets.flatMap((f) => [
      { kind: 'facet' as const, valueId: f.id },
      ...f.values.map((v) => ({
        kind: 'facetValue' as const,
        valueId: v.id,
        parentId: f.id,
      })),
    ]),
    ...config.variantAttributes.flatMap((a) => [
      { kind: 'variantAttribute' as const, valueId: a.id },
      ...(a.kind === 'enum'
        ? a.values.map((v) => ({
            kind: 'variantValue' as const,
            valueId: v.id,
            parentId: a.id,
          }))
        : []),
    ]),
    ...config.textAttributes.map((a) => ({
      kind: 'textAttribute' as const,
      valueId: a.id,
    })),
    ...config.safetySymbols.map((s) => ({
      kind: 'safetySymbol' as const,
      valueId: s.id,
    })),
    ...(config.calloutStyles ?? []).map((s) => ({
      kind: 'calloutStyle' as const,
      valueId: s.id,
    })),
  ];
}

/**
 * How many modules (by ID: its languages count once) and manuals name each
 * configured value, in the configuration's order. Only the files given are
 * counted (what one reader may see), and a value no file names counts 0.
 */
export function countConfigUsages(
  config: ProjectConfig,
  modules: readonly Module[],
  manifests: readonly Manifest[],
): ConfigValueUsage[] {
  const moduleIds = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const key of moduleUsageKeys(module)) {
      const ids = moduleIds.get(key) ?? new Set<string>();
      ids.add(module.id);
      moduleIds.set(key, ids);
    }
  }
  const manualCounts = new Map<string, number>();
  for (const manifest of manifests) {
    for (const key of manifestUsageKeys(manifest)) {
      manualCounts.set(key, (manualCounts.get(key) ?? 0) + 1);
    }
  }
  return configuredValues(config).map(({ kind, valueId, parentId }) => {
    const key = usageKey(kind, valueId, parentId);
    return {
      kind,
      valueId,
      ...(parentId !== undefined && { parentId }),
      modules: moduleIds.get(key)?.size ?? 0,
      manuals: manualCounts.get(key) ?? 0,
    };
  });
}
