import {
  walk,
  type Condition,
  type Manifest,
  type ManifestEntry,
  type Module,
} from '@openfolia/content-model';

/**
 * The variant attributes a file names, each with the values it names of it:
 * `{ model: ['large'], software: [] }` for `model in (large) && software >= 2.3`
 * (a comparison names the attribute, no value). Keys and values in code-unit
 * order, each once; what the module index keeps to answer where a variant
 * value is used (#91).
 */
export type VariantNames = Readonly<Record<string, readonly string[]>>;

type Collected = Map<string, Set<string>>;

function attribute(into: Collected, attr: string): Set<string> {
  let values = into.get(attr);
  if (!values) into.set(attr, (values = new Set()));
  return values;
}

function collectCondition(condition: Condition, into: Collected): void {
  switch (condition.op) {
    case 'all':
    case 'any':
      for (const c of condition.of) collectCondition(c, into);
      return;
    case 'not':
      collectCondition(condition.of, into);
      return;
    case 'in': {
      const values = attribute(into, condition.attr);
      for (const v of condition.values) values.add(v);
      return;
    }
    case 'cmp':
      attribute(into, condition.attr);
      return;
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function toNames(collected: Collected): VariantNames {
  return Object.fromEntries(
    [...collected.keys()]
      .sort(compare)
      .map((attr) => [attr, [...(collected.get(attr) ?? [])].sort(compare)]),
  );
}

/** What a module's variant blocks name. */
export function moduleVariantNames(module: Module): VariantNames {
  const collected: Collected = new Map();
  for (const { kind, node } of walk(module.blocks)) {
    if (kind === 'block' && node.type === 'variant') {
      collectCondition(node.when, collected);
    }
  }
  return toNames(collected);
}

/**
 * What a manifest names that every reader of it may see: its variant
 * combinations and the conditions of its text attributes. Its entries'
 * conditions are kept apart (`manifestEntryVariants`): a reader is told one
 * only where the entry covers a module they may see.
 */
export function manifestVariantNames(manifest: Manifest): VariantNames {
  const collected: Collected = new Map();
  for (const variant of manifest.variants) {
    for (const [attr, value] of Object.entries(variant)) {
      attribute(collected, attr).add(value);
    }
  }
  for (const value of Object.values(manifest.attributes)) {
    if (typeof value === 'string') continue;
    for (const option of value) {
      if (option.when) collectCondition(option.when, collected);
    }
  }
  return toNames(collected);
}

/** What one conditioned manifest entry names, with the modules it covers. */
export interface EntryVariants {
  /** The module IDs it covers (a group's, of every entry in it), each once, in order. */
  readonly modules: readonly string[];
  readonly names: VariantNames;
}

/**
 * What the conditions of a manifest's entries name, one item per entry
 * with a condition, in document order. A reader is told an entry's names
 * only while it covers a module they may see: a manifest served to them
 * leaves out the entries naming none (`ReadableContent`'s `#named`).
 */
export function manifestEntryVariants(
  manifest: Manifest,
): readonly EntryVariants[] {
  const found: EntryVariants[] = [];
  const covered = (entry: ManifestEntry): string[] =>
    'module' in entry ? [entry.module] : entry.entries.flatMap(covered);
  const visit = (list: readonly ManifestEntry[]): void => {
    for (const entry of list) {
      if (entry.when) {
        const collected: Collected = new Map();
        collectCondition(entry.when, collected);
        found.push({
          modules: [...new Set(covered(entry))],
          names: toNames(collected),
        });
      }
      if ('entries' in entry) visit(entry.entries);
    }
  };
  visit(manifest.entries);
  return found;
}

/** `names` and `more` together, keys and values in code-unit order. */
export function mergeVariantNames(
  names: VariantNames | undefined,
  more: readonly VariantNames[],
): VariantNames {
  const collected: Collected = new Map();
  for (const n of [names ?? {}, ...more]) {
    for (const [attr, values] of Object.entries(n)) {
      const into = attribute(collected, attr);
      for (const v of values) into.add(v);
    }
  }
  return toNames(collected);
}

/** Whether `names` names the attribute (`value` undefined) or that value of it. */
export function namesVariant(
  names: VariantNames | undefined,
  attr: string,
  value?: string,
): boolean {
  if (!names || !Object.hasOwn(names, attr)) return false;
  const values = names[attr] ?? [];
  return value === undefined || values.includes(value);
}
