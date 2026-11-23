import type { ConverterReportEntry } from '@openfolia/content-model';

/**
 * What the DITA import could not map, or mapped only partly: one code per
 * kind of loss, each stable, so a screen or a person can sort by it. The
 * research note (`docs/dita-import.md`) explains each.
 */
export type DitaReportCode =
  // Files
  | 'not-well-formed'
  | 'dtd-subset'
  | 'unsupported-encoding'
  | 'too-large'
  | 'not-dita'
  | 'dita-version'
  | 'translated-map'
  | 'translation-without-source'
  | 'translation-structure'
  | 'language'
  | 'unused-file'
  // Elements and attributes
  | 'unknown-element'
  | 'specialization'
  | 'unsupported-element'
  | 'dropped-element'
  | 'unsupported-attribute'
  | 'inline-image'
  | 'footnote'
  | 'markup-in-literal'
  | 'nested-table'
  | 'table-layout'
  | 'section-depth'
  | 'note-type'
  | 'hazard-type'
  | 'hazard-symbol'
  | 'empty-element'
  | 'metadata'
  | 'keywords'
  // References
  | 'unresolved-conref'
  | 'conref-cycle'
  | 'conaction'
  | 'unresolved-key'
  | 'key-cycle'
  | 'keyscope'
  | 'conditional-key'
  | 'key-space'
  | 'unresolved-xref'
  | 'external-reference'
  | 'missing-asset'
  | 'outside-archive'
  | 'expansion-limit'
  // Profiling and DITAVAL
  | 'inline-condition'
  | 'item-condition'
  | 'condition-limit'
  | 'section-condition'
  | 'unmapped-profiling'
  | 'audience-condition'
  | 'ditaval-unreferenced'
  | 'ditaval-branch'
  | 'ditaval-action'
  | 'ditaval-variant'
  | 'duplicate-variant'
  // Maps
  | 'map-entry'
  | 'empty-map'
  | 'generated-list'
  | 'reltable'
  // Configuration
  | 'mapping';

/** The longest message an entry may carry (the import format's limit). */
const MAX_MESSAGE = 4000;
/** The longest `sourceId`. */
const MAX_SOURCE_ID = 500;

export interface ReportPlace {
  /** The file (the archive's path), with `#<id>` for an element there. */
  readonly source: string;
  /** What it was in DITA: an element's name, `file`, `map`, … */
  readonly kind?: string;
  readonly module?: string;
  readonly block?: string;
}

interface Collected {
  readonly code: DitaReportCode;
  readonly place: ReportPlace;
  readonly message: string;
  count: number;
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line || '-';
};

/**
 * The converter's report: entries with the same code, file and message
 * are one entry with a count, so a project with a thousand index terms
 * reports them once per file, and the report stays within the import
 * format's bounds.
 */
export class DitaReport {
  private readonly entries = new Map<string, Collected>();

  add(code: DitaReportCode, place: ReportPlace, message: string): void {
    const file = place.source.split('#')[0] ?? place.source;
    const key = `${code}\u0000${file}\u0000${place.kind ?? ''}\u0000${message}`;
    const found = this.entries.get(key);
    if (found) {
      found.count++;
      return;
    }
    this.entries.set(key, { code, place, message, count: 1 });
  }

  /** How many entries of `code` there are, counts included. */
  count(code: DitaReportCode): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.code === code) n += entry.count;
    }
    return n;
  }

  /** The codes reported, each once. */
  codes(): Set<DitaReportCode> {
    return new Set([...this.entries.values()].map((e) => e.code));
  }

  /** The entries in the import format, in the order first seen. */
  toEntries(): ConverterReportEntry[] {
    return [...this.entries.values()].map(({ code, place, message, count }) => {
      const times = count > 1 ? ` (${count} times in this file)` : '';
      return {
        sourceId: oneLine(place.source, MAX_SOURCE_ID),
        ...(place.kind !== undefined && {
          sourceKind: oneLine(place.kind, 100),
        }),
        message: oneLine(`[${code}] ${message}${times}`, MAX_MESSAGE),
        ...(place.module !== undefined && { module: place.module }),
        ...(place.block !== undefined && count === 1 && { block: place.block }),
      };
    });
  }
}
