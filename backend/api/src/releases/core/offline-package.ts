import type { ManualResolution } from '../../content/core/content.repository.js';

/**
 * The offline package (#59): a ZIP per release, language and audience level
 * that opens from the file system, with the network off. `index.html` lists
 * every manual the level reads, in each variant; each is one static page
 * (`manuals/<manual>/<variant>.html`) beside its PDF (`pdf/…`), the images and
 * attached files they show (`media/…`), the safety symbols' artwork
 * (`symbols/…`), the stylesheets and fonts (`assets/…`), a small search over
 * titles and headings, and `manifest.json` with every file's SHA-256.
 */

/** A manual page of the package, as `OfflineSite.page` writes it. */
export interface OfflinePageInput {
  readonly lang: string;
  readonly dir: 'ltr' | 'rtl';
  readonly title: string;
  /** From the page to the package's root (`../../`). */
  readonly root: string;
  /** The manual as the HTML renderer wrote it, its links relative to the page. */
  readonly fragment: string;
  /** Its PDF from the root, when the package holds it. */
  readonly pdf?: string;
  readonly footer: string;
}

export interface OfflineIndexInput {
  readonly lang: string;
  readonly dir: 'ltr' | 'rtl';
  readonly title: string;
  readonly subtitle: string;
  readonly manuals: readonly {
    readonly title: string;
    readonly variants: readonly {
      readonly label: string;
      readonly page: string;
      readonly pdf?: string;
    }[];
  }[];
  readonly search: readonly {
    readonly text: string;
    readonly page: string;
    readonly context: string;
  }[];
  readonly footer: string;
}

/** A file every package holds as it is: a stylesheet, a font, its licence, the search script. */
export interface OfflineSiteFile {
  /** Its path in the package (`assets/…`). */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Port: the offline package's pages (`@openfolia/render-html`'s static-site writer
 * in `repos/`; `core/` never imports the renderer). Every text it writes is
 * escaped, every link it writes is relative and inside the package, and the
 * pages carry a Content Security Policy that allows only the package's own
 * files (and the index's search script).
 */
export abstract class OfflineSite {
  abstract page(input: OfflinePageInput): string;
  abstract index(input: OfflineIndexInput): string;
  /**
   * The headings the manual's page shows (each module's and section's title),
   * with the element ID each links to, for the search.
   */
  abstract headings(
    resolution: ManualResolution,
  ): readonly { readonly id: string; readonly text: string }[];
  /** The files every package holds as they are, under `assets/`. */
  abstract files(): readonly OfflineSiteFile[];
}

/**
 * The most files one package holds (#59): its pages, images, attached files,
 * symbols and PDFs. Well below a ZIP's 65,535 without ZIP64.
 */
export const MAX_PACKAGE_ENTRIES = 50_000;

/**
 * The most headings the index's search holds; the rest are left out of the
 * search (the pages still hold them), so the index stays a page a phone opens.
 */
export const MAX_SEARCH_ENTRIES = 20_000;

/** The media type of an offline package. */
export const OFFLINE_PACKAGE_TYPE = 'application/zip';

/**
 * One part of a path in the package: ASCII letters, digits, `.` and `-` (anything
 * else `-`), never empty and never starting with a dot, so no part is `.` or
 * `..` and none is hidden.
 */
export function pathPart(text: string): string {
  const part = text.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^\.+/, '-');
  return part === '' ? '-' : part;
}

/**
 * Names that are unique ignoring case (a file system may ignore it): the first
 * keeps its name, a later one gets `-2`, `-3`, … before the extension.
 */
export class UniqueNames {
  readonly #taken = new Set<string>();

  name(base: string, extension: string): string {
    let name = `${base}${extension}`;
    for (let n = 2; this.#taken.has(name.toLowerCase()); n++) {
      name = `${base}-${n}${extension}`;
    }
    this.#taken.add(name.toLowerCase());
    return name;
  }
}
