import { parse as parseYaml, stringify } from 'yaml';
import type { Condition } from './condition.js';
import {
  formatCondition,
  parseCondition,
} from './asciidoc/condition-syntax.js';
import {
  CURRENT_MANIFEST_VERSION,
  type CoverImageAlt,
  type Manifest,
  type ManifestEntry,
  StoredManifest,
} from './manifest.js';
import { printableText } from './localized-text.js';
import { updateGuideEntries } from './update-guide.js';

export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestParseError';
  }
}

/**
 * Manifests are stored as YAML, with conditions written the same way as in
 * modules (`when: market in (eu)`). The manifest ID is the file name.
 */
export function parseManifest(
  source: string,
  options: { id: string },
): Manifest {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new ManifestParseError(`invalid YAML: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ManifestParseError('a manifest must be a YAML mapping');
  }
  const raw = data as Record<string, unknown>;
  if (raw['kind'] === 'derived' && raw['entries'] !== undefined) {
    throw new ManifestParseError(
      'invalid manifest: entries: a derived manual has none; its rule gathers them',
    );
  }
  if (raw['kind'] === 'update-guide' && raw['entries'] !== undefined) {
    throw new ManifestParseError(
      "invalid manifest: entries: an update guide has none; its guide's steps are its entries",
    );
  }
  let input: Record<string, unknown>;
  try {
    input = {
      ...raw,
      id: options.id,
      attributes: mapAttributes(raw['attributes'], parseWhen),
      ...(raw['entries'] !== undefined && {
        entries: mapEntries(raw['entries'], parseWhen),
      }),
      ...(isRecord(raw['guide']) && {
        guide: {
          ...raw['guide'],
          steps: mapEntries(raw['guide']['steps'], parseWhen),
        },
      }),
    };
  } catch (e) {
    throw new ManifestParseError((e as Error).message);
  }
  const result = StoredManifest.safeParse(input);
  if (!result.success) {
    throw new ManifestParseError(
      `invalid manifest: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  // An update guide's entries are its steps (#906), made here, never printed.
  const guide = result.data.guide;
  return guide && result.data.kind === 'update-guide'
    ? { ...result.data, entries: updateGuideEntries(guide.steps) }
    : result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Prints a manifest as canonical YAML: fixed key order, sorted variant keys, conditions as text.
 * A derived manual (#451) is printed with its rule and without entries, which are gathered when
 * it is read; an update guide (#906) with its guide and without entries, made from its steps.
 */
export function printManifest(manifest: Manifest): string {
  const sortKeys = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, record[k] as T]),
    );
  const doc: Record<string, unknown> = {
    schemaVersion: CURRENT_MANIFEST_VERSION,
    ...(manifest.kind !== undefined && { kind: manifest.kind }),
    title: printableText(manifest.title),
  };
  if (manifest.audience) doc['audience'] = manifest.audience;
  if (manifest.deprecated) {
    doc['deprecated'] = {
      reason: manifest.deprecated.reason,
      ...(manifest.deprecated.replacedBy && {
        replacedBy: manifest.deprecated.replacedBy,
      }),
    };
  }
  if (manifest.glossary) doc['glossary'] = true;
  if (manifest.design) doc['design'] = manifest.design;
  const cover = manifest.coverImage;
  if (cover && (cover.default || cover.variants.length > 0)) {
    const alt = (text: CoverImageAlt) =>
      typeof text === 'string' ? text : sortKeys(text);
    doc['coverImage'] = {
      ...(cover.default && {
        default: { asset: cover.default.asset, alt: alt(cover.default.alt) },
      }),
      ...(cover.variants.length > 0 && {
        variants: cover.variants.map((v) => ({
          variant: sortKeys(v.variant),
          asset: v.asset,
          alt: alt(v.alt),
        })),
      }),
    };
  }
  const records = manifest.translations;
  if (records && Object.keys(records).length > 0) {
    doc['translations'] = Object.fromEntries(
      Object.keys(records)
        .sort()
        .map((lang) => {
          const record = records[lang] as NonNullable<typeof records>[string];
          return [
            lang,
            {
              sourceCommit: record.sourceCommit,
              blocks: sortKeys(record.blocks),
            },
          ];
        }),
    );
  }
  doc['variants'] = manifest.variants.map(sortKeys);
  if (Object.keys(manifest.attributes).length > 0) {
    doc['attributes'] = sortKeys(
      mapAttributes(manifest.attributes, formatWhen) as Record<string, unknown>,
    );
  }
  if (manifest.kind === 'derived') {
    const rule = manifest.rule;
    if (rule) {
      doc['rule'] = {
        source: rule.source,
        ...(rule.moduleTypes && { moduleTypes: [...rule.moduleTypes] }),
        ...(rule.exclude.length > 0 && { exclude: [...rule.exclude] }),
        ...(rule.front.length > 0 && { front: [...rule.front] }),
        ...(rule.back.length > 0 && { back: [...rule.back] }),
        ...(rule.notices && {
          notices: {
            groupBy: rule.notices.groupBy,
            ...(rule.notices.levels && { levels: [...rule.notices.levels] }),
          },
        }),
      };
    }
  } else if (manifest.kind === 'update-guide') {
    const guide = manifest.guide;
    if (guide) {
      doc['guide'] = {
        attribute: guide.attribute,
        versions: [...guide.versions],
        steps: guide.steps.map((step) => ({
          module: step.module,
          ...(step.version !== undefined && { version: step.version }),
          phase: step.phase,
          ...(step.level !== undefined && { level: step.level }),
          ...(step.when !== undefined && { when: formatWhen(step.when) }),
        })),
      };
    }
  } else {
    doc['entries'] = mapEntries(printableTitles(manifest.entries), formatWhen);
  }
  return stringify(doc, { lineWidth: 0 });
}

/** Entries with each group's title in printing order (one text, or its languages sorted). */
function printableTitles(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return entries.map((entry) =>
    'entries' in entry
      ? {
          ...entry,
          title: printableText(entry.title),
          entries: printableTitles(entry.entries),
        }
      : entry,
  );
}

const parseWhen = (when: unknown): unknown =>
  typeof when === 'string' ? parseCondition(when) : when;
const formatWhen = (when: unknown): unknown =>
  when === undefined ? undefined : formatCondition(when as Condition);

/** Rewrites `when` in attribute values, leaving anything unexpected for the schema to report. */
function mapAttributes(
  value: unknown,
  mapWhen: (w: unknown) => unknown,
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, v]) => [
      name,
      Array.isArray(v)
        ? v.map((option: unknown) => withWhen(option, mapWhen))
        : v,
    ]),
  );
}

function mapEntries(value: unknown, mapWhen: (w: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry: unknown) => {
    const mapped = withWhen(entry, mapWhen);
    if (typeof mapped === 'object' && mapped !== null && 'entries' in mapped) {
      const group = mapped as { entries: unknown };
      return { ...group, entries: mapEntries(group.entries, mapWhen) };
    }
    return mapped;
  });
}

function withWhen(value: unknown, mapWhen: (w: unknown) => unknown): unknown {
  if (typeof value !== 'object' || value === null || !('when' in value))
    return value;
  const { when, ...rest } = value as { when: unknown };
  const mapped = mapWhen(when);
  // Key order: what the entry is first, its condition next, nested entries last.
  const { entries, ...head } = rest as { entries?: unknown };
  return {
    ...head,
    ...(mapped === undefined ? {} : { when: mapped }),
    ...(entries === undefined ? {} : { entries }),
  };
}
