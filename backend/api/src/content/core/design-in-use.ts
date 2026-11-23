import {
  BUILTIN_PAGE_DESIGN_ID,
  DEFAULT_PAGE_DESIGN,
  pageDesignIdFor,
  pageDesignShowsRelease,
  type Manifest,
  type PageDesign,
  type ProjectConfig,
} from '@openfolia/content-model';
import { InvalidContentError } from '../../base/core/errors.js';

/**
 * The page design a manual is printed with (#589), as `meta.design` names it: its ID, its name
 * (null for the built-in design and for one that is not there), where the choice comes from (the
 * manual's own `design`, the project's `pdf.design`, or neither: the built-in design) and whether
 * the design named is missing from the content (the PDF then uses the built-in design).
 */
export interface DesignInUse {
  readonly id: string;
  readonly name: string | null;
  readonly source: 'manual' | 'project' | 'builtin';
  readonly missing: boolean;
}

/** Reads a page design at one commit; `pageDesign` of `ReadableContent`. */
export interface DesignReader {
  pageDesign(id: string): Promise<PageDesign | undefined>;
}

/**
 * Works out the design each manual uses at one commit, reading each design once (a list of
 * manuals names few designs). A design file that is no design counts as missing, as the PDF
 * treats it.
 */
export class DesignsInUse {
  readonly #read = new Map<string, Promise<PageDesign | undefined>>();

  constructor(private readonly content: DesignReader) {}

  async of(
    manifest: Pick<Manifest, 'design'>,
    config: ProjectConfig,
  ): Promise<DesignInUse> {
    const id = pageDesignIdFor(manifest, config);
    const source =
      manifest.design !== undefined
        ? 'manual'
        : config.pdf.design !== undefined
          ? 'project'
          : 'builtin';
    if (id === BUILTIN_PAGE_DESIGN_ID) {
      return { id, name: null, source, missing: false };
    }
    const design = await this.#design(id);
    return design
      ? { id, name: design.name, source, missing: false }
      : { id, name: null, source, missing: true };
  }

  /**
   * Whether the manual's PDF prints anything of the release it is made for (#395,
   * `pageDesignShowsRelease`): its design's, or, where it has none (the built-in design, or one
   * that is missing), the built-in design's when the manual gives a variant a cover image of its
   * own (#394: then that design lays it out); else the default PDF, which prints neither.
   */
  async printsRelease(
    manifest: Pick<Manifest, 'design' | 'coverImage'>,
    config: ProjectConfig,
  ): Promise<boolean> {
    const id = pageDesignIdFor(manifest, config);
    const design =
      id === BUILTIN_PAGE_DESIGN_ID ? undefined : await this.#design(id);
    if (design) return pageDesignShowsRelease(design);
    const cover = manifest.coverImage;
    const ownCover =
      cover !== undefined &&
      (cover.default !== undefined || cover.variants.length > 0);
    return ownCover && pageDesignShowsRelease(DEFAULT_PAGE_DESIGN);
  }

  #design(id: string): Promise<PageDesign | undefined> {
    let found = this.#read.get(id);
    if (!found) {
      found = this.content.pageDesign(id).catch((error: unknown) => {
        if (error instanceof InvalidContentError) return undefined;
        throw error;
      });
      this.#read.set(id, found);
    }
    return found;
  }
}
