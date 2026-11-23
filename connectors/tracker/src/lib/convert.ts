import {
  type ConversionReport as Report,
  ConversionReport,
  convertMarkup,
  slug,
  WikiMapping,
} from '@openfolia/connector-wiki-markup';
import {
  type Condition,
  CURRENT_IMPORT_FORMAT_VERSION,
  CURRENT_SCHEMA_VERSION,
  type ImportDocument,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS,
  type Module,
} from '@openfolia/content-model';
import type { TrackerMapping, ValueMapping } from './mapping.js';
import type { TrackerItem } from './source.js';

export interface TrackerConversion {
  readonly document: ImportDocument;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  /** The items the mapping includes, in the order they are in the bundle. */
  readonly included: readonly TrackerItem[];
}

/**
 * The items the mapping includes, as an import bundle's document: one
 * module per item (its title, its description converted from the markup,
 * its type, audience and facets as mapped), and the manual listing them if
 * the mapping asks for one, each entry shown in the variants its item maps
 * to. Items are ordered by ID, so the same items give the same bundle. A
 * value the mapping does not name, and anything the markup converter could
 * not convert, is in the document's report, by item.
 */
export function convertItems(
  items: readonly TrackerItem[],
  mapping: TrackerMapping,
): TrackerConversion {
  const report = new ConversionReport();
  const assets = new Map<string, Uint8Array>();
  const included = items
    .filter((item) => includes(item, mapping))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = moduleIds(included, mapping, report);
  const byKey = new Map<string, string>();
  // The values of every item's module's tables together.
  const tables = { values: 0 };
  included.forEach((item, index) => {
    byKey.set(item.id.toLowerCase(), ids[index] as string);
    if (!byKey.has(item.title.toLowerCase())) {
      byKey.set(item.title.toLowerCase(), ids[index] as string);
    }
  });
  const markup = WikiMapping.parse({
    ...mapping.markup,
    system: mapping.system,
    language: mapping.language,
    moduleType: mapping.module.type,
  });
  const modules = included.map((item, index) => {
    const id = ids[index] as string;
    const place = { sourceId: item.id, sourceKind: 'item', module: id };
    const note = (message: string) =>
      report.add(place, 'unmapped-value', message);
    const audience =
      typeof mapping.module.audience === 'string'
        ? mapping.module.audience
        : mapping.module.audience &&
          mapValues(item, mapping.module.audience, note)[0];
    const facets: Record<string, string[]> = {};
    for (const [facet, rule] of Object.entries(mapping.module.facets)) {
      const values = Array.isArray(rule) ? rule : mapValues(item, rule, note);
      if (values.length > 0) facets[facet] = [...new Set(values)].sort();
    }
    const keywords = mapping.module.keywords
      ? valuesOf(item, mapping.module.keywords.from)
          .map((k) => k.trim())
          .filter(
            (k) => k && k.length <= MAX_KEYWORD_LENGTH && !k.includes(','),
          )
          .slice(0, MAX_KEYWORDS)
      : [];
    const module: Module = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id,
      meta: {
        title: item.title.replace(/\s+/g, ' ').trim() || item.id,
        type: mapping.module.type,
        lang: mapping.language,
        ...(audience && { audience }),
        facets,
        ...(keywords.length > 0 && { keywords }),
        source: { system: mapping.system, id: item.id.trim() },
      },
      blocks: convertMarkup(
        item.body,
        {
          sourceId: item.id,
          sourceKind: 'item',
          moduleId: id,
          mapping: markup,
        },
        {
          report,
          assets,
          pageByTitle: (key) => byKey.get(key.trim().toLowerCase()),
          tables,
        },
      ),
    };
    return module;
  });
  return {
    document: {
      formatVersion: CURRENT_IMPORT_FORMAT_VERSION,
      source: { system: mapping.system },
      modules,
      manuals: mapping.manual
        ? [manual(mapping.manual, included, modules, report)]
        : [],
      report: report.list(),
    },
    assets,
    included,
  };
}

function manual(
  config: NonNullable<TrackerMapping['manual']>,
  items: readonly TrackerItem[],
  modules: readonly Module[],
  report: Report,
): NonNullable<ImportDocument['manuals']>[number] {
  return {
    schemaVersion: 1,
    id: config.id,
    title: config.title,
    ...(config.audience && { audience: config.audience }),
    variants: config.variants,
    attributes: {},
    entries: modules.map((module, index) => {
      const item = items[index] as TrackerItem;
      const show = config.showIn;
      if (!show) return { module: module.id };
      const values = mapValues(
        item,
        { from: show.from, values: show.values },
        (message) =>
          report.add(
            { sourceId: item.id, sourceKind: 'item', module: module.id },
            'unmapped-value',
            message,
          ),
      );
      if (values.length === 0) return { module: module.id };
      const when: Condition = {
        op: 'in',
        attr: show.attribute,
        values: [...new Set(values)].sort(),
      };
      return { module: module.id, when };
    }),
  };
}

function includes(item: TrackerItem, mapping: TrackerMapping): boolean {
  const { kinds, states, labels } = mapping.include;
  if (kinds && !kinds.includes(item.kind)) return false;
  if (states && !states.includes(item.state)) return false;
  if (labels && !item.labels.some((l) => labels.includes(l))) return false;
  return true;
}

/** The values at `path`: a list field gives each value, a scalar one its text. */
export function valuesOf(item: TrackerItem, path: string): string[] {
  if (path === 'id') return [item.id];
  if (path === 'kind') return [item.kind];
  if (path === 'state') return [item.state];
  if (path === 'labels') return [...item.labels];
  const name = path.slice('fields.'.length);
  const value = Object.hasOwn(item.fields, name)
    ? item.fields[name]
    : undefined;
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** The field's values mapped; an unmapped one is noted, the default used when none maps. */
function mapValues(
  item: TrackerItem,
  rule: Pick<ValueMapping, 'from' | 'values'> & { default?: string },
  note: (message: string) => void,
): string[] {
  const mapped: string[] = [];
  for (const value of valuesOf(item, rule.from)) {
    const target = Object.hasOwn(rule.values, value)
      ? rule.values[value]
      : undefined;
    if (target !== undefined) mapped.push(target);
    else if (rule.from !== 'labels') {
      // Labels hold much else; only an unmapped value of a field of its own is worth a look.
      note(
        `The value "${value}" of ${rule.from} is not in the mapping; it is not used.`,
      );
    }
  }
  if (mapped.length === 0 && rule.default !== undefined) return [rule.default];
  return mapped;
}

/** Module IDs from the template, unique; a clash is reported. */
function moduleIds(
  items: readonly TrackerItem[],
  mapping: TrackerMapping,
  report: Report,
): string[] {
  const taken = new Set<string>();
  return items.map((item, index) => {
    const filled = mapping.module.id.replace(
      /\{(id|kind|state|fields\.[^}]+)\}/g,
      (_, path: string) => valuesOf(item, path).join('-'),
    );
    const base =
      slug(filled).slice(0, 90).replace(/-+$/, '') || `item-${index + 1}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    if (id !== base) {
      report.add(
        { sourceId: item.id, sourceKind: 'item', module: id },
        'duplicate-id',
        `Another item already has the module ID "${base}"; this one is "${id}".`,
      );
    }
    taken.add(id);
    return id;
  });
}
