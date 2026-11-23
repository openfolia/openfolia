import {
  type ConverterReportEntry,
  MAX_REPORT_ENTRIES,
} from '@openfolia/content-model';

/**
 * Every kind of finding the converter reports, as the stable `[code]` its
 * report message starts with. Each names a construct of the markup that was
 * not converted as it stood: kept verbatim, kept as plain text, moved, or
 * (only for pure decoration, which carries no content) left out.
 */
export const WIKI_REPORT_CODES = [
  /** A block macro with no counterpart: kept verbatim in a `passthrough` block. */
  'unknown-macro',
  /** A container macro (a panel, an expandable section): its content converted, its frame left out. */
  'macro-frame',
  /** An inline macro with no counterpart: its text kept as it stood. */
  'inline-macro',
  /** A colour: the text kept, the colour left out. */
  'colour',
  /** An anchor: left out (links to it keep their text). */
  'anchor',
  /** A link to an anchor: the text kept, without the link. */
  'anchor-link',
  /** A mention of a person: the name kept as text. */
  'mention',
  /** Struck-through text: the text kept, unmarked. */
  'strikethrough',
  /** Underlined text: the text kept, unmarked. */
  'underline',
  /** A quotation: kept as plain paragraphs. */
  'quote',
  /** A horizontal rule: left out (decoration, no content). */
  'rule',
  /** A link to a page outside the export: the text kept, without the link. */
  'page-link-outside',
  /** A link the content model refuses (a scheme other than http, https or mailto, or a malformed address). */
  'invalid-link',
  /** A link's tooltip: left out. */
  'link-tip',
  /** An image shown from an address: not fetched, kept as a link. */
  'external-image',
  /** An image or attachment the export does not carry: kept verbatim in a `passthrough` block. */
  'missing-file',
  /** An image setting with no counterpart (a size in pixels, a thumbnail, a border): left out. */
  'image-setting',
  /** An image without alternative text: its file name is used. */
  'no-alt',
  /** An image or attachment inside a line of text: placed after its paragraph. */
  'moved-out-of-text',
  /** A header cell outside the table's first row: kept as an ordinary cell. */
  'header-cell',
  /**
   * A table past a cap once padded: the content model's (its columns or
   * cells, or the module's tables together), or the import's (the values of
   * one module's or one bundle's tables). Kept verbatim in a `passthrough` block.
   */
  'table-too-large',
  /** A table row with fewer cells than the widest: padded with empty cells. */
  'row-padded',
  /** Headings or lists nested deeper than the content model allows: placed at the deepest level. */
  'too-deep',
  /** A heading with no text: left out. */
  'empty-heading',
  /** A page label the mapping does not name: not used. */
  'unmapped-label',
  /** A source field's value the mapping does not name: not used. */
  'unmapped-value',
  /** Two pages that would get the same module ID: the second gets a suffix. */
  'duplicate-id',
  /** A page whose converted blocks pass the import's limit on one module beside its `meta`: kept verbatim in one `passthrough` block, any files in it as written. */
  'page-too-large',
  /** More findings than the report holds: counted in the last entry. */
  'more',
] as const;
export type WikiReportCode = (typeof WIKI_REPORT_CODES)[number];

/** The longest quote of source text in a message. */
const MAX_QUOTE = 200;

/** `text` for a message: one line, at most `MAX_QUOTE` characters. */
export function quote(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return `"${line.length > MAX_QUOTE ? `${line.slice(0, MAX_QUOTE - 1)}…` : line}"`;
}

/** Where a finding is: the page, and the module and block it ended up in. */
export interface FindingPlace {
  readonly sourceId: string;
  /** What the source item is (default `page`). */
  readonly sourceKind?: string;
  readonly module?: string;
  readonly block?: string;
}

/**
 * The conversion's report, as the import format's `report` entries: one per
 * finding, its message starting with `[code]`. At most the format's
 * `MAX_REPORT_ENTRIES`; past that, the last entry counts the rest.
 */
export class ConversionReport {
  private readonly entries: ConverterReportEntry[] = [];
  private more = 0;
  /** Findings by code, all of them (also those past the cap). */
  readonly counts = new Map<WikiReportCode, number>();

  add(place: FindingPlace, code: WikiReportCode, message: string): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    if (this.entries.length >= MAX_REPORT_ENTRIES - 1) {
      this.more += 1;
      return;
    }
    this.entries.push({
      sourceId: oneLine(place.sourceId, 500),
      sourceKind: place.sourceKind ?? 'page',
      message: `[${code}] ${message}`.slice(0, 4000),
      ...(place.module !== undefined && { module: place.module }),
      ...(place.block !== undefined && { block: place.block }),
    });
  }

  /** The entries, with the count of those past the cap. */
  list(): ConverterReportEntry[] {
    if (this.more === 0) return [...this.entries];
    return [
      ...this.entries,
      {
        sourceId: 'export',
        message: `[more] ${this.more} more findings like these are not listed.`,
      },
    ];
  }

  get size(): number {
    return this.entries.length + this.more;
  }

  /** Where the report stands now, for `rollBack`. */
  mark(): ReportMark {
    return {
      entries: this.entries.length,
      more: this.more,
      counts: new Map(this.counts),
    };
  }

  /** Forgets every finding added since `mark` (a conversion given up). */
  rollBack(mark: ReportMark): void {
    this.entries.length = mark.entries;
    this.more = mark.more;
    this.counts.clear();
    for (const [code, n] of mark.counts) this.counts.set(code, n);
  }
}

export interface ReportMark {
  readonly entries: number;
  readonly more: number;
  readonly counts: ReadonlyMap<WikiReportCode, number>;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim() || '-';
  return line.length > max ? line.slice(0, max) : line;
}
