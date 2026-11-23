import type { ManualResolution } from '../../content/core/content.repository.js';

export interface HtmlRenderOptions {
  /** The URL of an image, given its SHA-256 (64 hex digits, no prefix). */
  assetUrl: (sha256: string) => string;
  /**
   * The URL of a safety symbol's artwork, given its ID; undefined leaves the
   * symbol out (it has no artwork). Default: every symbol left out.
   */
  symbolUrl?: (id: string) => string | undefined;
  /** Shown under a manual's title. */
  subtitle?: string;
  /**
   * The editor's view: page breaks as markers, and a text attribute without
   * a value as a chip with its label. Without it, the HTML readers get.
   */
  editorView?: boolean;
  /**
   * The link of a cross-reference (`module`, `block`, and the output ID
   * `id` it resolves to in the manual, if any); undefined for the
   * default (a link within the fragment, else plain text).
   */
  xrefHref?: (target: {
    module: string;
    block?: string;
    id?: string;
  }) => string | undefined;
}

/** An HTML fragment (one `<article>`), as the renderer writes it. */
export interface HtmlFragment {
  html: string;
  /** The images it shows (`sha256:…`), each linked through `assetUrl`. */
  assets?: readonly string[];
  /** The attached files it links (`sha256:…`), through `assetUrl` too. */
  attachments?: readonly string[];
  /** The safety symbols it shows (by ID). */
  symbols?: readonly string[];
}

/** The port to the HTML renderer (`@openfolia/render-html`); `core/` never imports it. */
export abstract class HtmlRenderer {
  abstract manual(
    resolution: ManualResolution,
    options: HtmlRenderOptions,
  ): HtmlFragment;
  /** `undefined` when the resolution holds no such module. */
  abstract module(
    resolution: ManualResolution,
    moduleId: string,
    options: HtmlRenderOptions,
  ): HtmlFragment | undefined;
}

/** A stylesheet or font the preview page links, served by the API itself. */
export interface PreviewFile {
  body: Uint8Array;
  type: string;
  /** Changes with the bytes. */
  etag: string;
}

/** The files the preview page links: the themes, the renderer's stylesheet and the fonts. */
export abstract class PreviewFiles {
  /** By its path under the preview's file route, e.g. `theme.css` or `fonts/Geist-Variable.woff2`. */
  abstract get(path: string): PreviewFile | undefined;
}
