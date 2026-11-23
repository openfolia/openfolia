/**
 * What a DITA export (#433) could not say in DITA, or left out: never a
 * silent loss. Each code is stable (the API lists them in a package's
 * `meta.warnings`).
 */
export const DITA_EXPORT_WARNINGS = [
  // Not written.
  'module-not-exported',
  'missing-translation',
  'missing-asset',
  'missing-symbol',
  'module-reference-cycle',
  'xref-outside',
  // Written in another form.
  'topic-type',
  'procedure-as-list',
  'procedure-title',
  'procedures-merged',
  'id-renamed',
  'section-flattened',
  'nested-note',
  'nested-table',
  'safety-as-note',
  'table-layout',
  'line-break',
  'faq',
  'attachment',
  'passthrough',
  'keyboard',
  'module-reference-resolved',
  'condition-shipped',
  'condition-approximated',
  'text-attribute-variants',
  // Left out, with no counterpart.
  'image-size',
  'callouts',
  'term-link',
  'metadata',
  'page-break',
] as const;
export type DitaExportWarningCode = (typeof DITA_EXPORT_WARNINGS)[number];

/** One warning: its code, what it is about (a module and block, a manual, a file) and a sentence. */
export interface DitaExportWarning {
  readonly code: DitaExportWarningCode;
  /** The module (or manual, asset) it is about; undefined for the package as a whole. */
  readonly module?: string;
  readonly block?: string;
  readonly lang?: string;
  readonly detail: string;
  /** How many times it came up (one entry per code and module). */
  readonly count: number;
}

/** The most warnings one export keeps (one per code and module, counted). */
export const MAX_EXPORT_WARNINGS = 1_000;

/** Collects warnings, one per code, module and language, counting repeats. */
export class ExportReport {
  private readonly entries = new Map<
    string,
    { -readonly [K in keyof DitaExportWarning]: DitaExportWarning[K] }
  >();
  private dropped = 0;
  lang: string | undefined;

  add(
    code: DitaExportWarningCode,
    place: { module?: string; block?: string },
    detail: string,
  ): void {
    const key = `${code}|${place.module ?? ''}|${this.lang ?? ''}`;
    const found = this.entries.get(key);
    if (found) {
      found.count++;
      return;
    }
    if (this.entries.size >= MAX_EXPORT_WARNINGS) {
      this.dropped++;
      return;
    }
    this.entries.set(key, {
      code,
      ...(place.module !== undefined && { module: place.module }),
      ...(place.block !== undefined && { block: place.block }),
      ...(this.lang !== undefined && { lang: this.lang }),
      detail,
      count: 1,
    });
  }

  /** The warnings, in the order they first came up. */
  list(): DitaExportWarning[] {
    return [...this.entries.values()];
  }

  /** How many warnings past `MAX_EXPORT_WARNINGS` were not kept. */
  get truncated(): number {
    return this.dropped;
  }
}
