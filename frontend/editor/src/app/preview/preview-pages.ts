import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL } from '../api';
import { symbolPng } from '../images/symbol-sources';
import { RASTERIZE_SVG } from '../images/svg-raster';
import {
  isSymbolUrl,
  previewDocument,
  previewImageUrls,
  type PreviewOrigin,
} from './preview-document';

/** At most this many images are read for one preview, a few at a time. */
const MAX_IMAGES = 300;
const IMAGE_READS = 6;

/** A preview page read, ready to be written for the frame. */
export interface PreviewRead {
  readonly html: string;
  readonly origin: PreviewOrigin;
  /** Each image URL the page names → the `blob:` URL of the bytes read (the caller revokes them). */
  readonly images: ReadonlyMap<string, string>;
}

/**
 * Reads the API's preview pages (`GET …/preview`, `GET …/html`) and their images with the
 * person's credentials: the preview screen's and the module editor's live preview. The page is
 * untrusted; `document` writes it for `of-preview-frame` (`previewDocument`).
 */
@Injectable({ providedIn: 'root' })
export class PreviewPages {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly doc = inject(DOCUMENT);
  private readonly rasterize = inject(RASTERIZE_SVG);

  /**
   * The page at `path` (under the API) with `params`, and its images. Null when `current` says
   * the read is no longer wanted (a newer one started): nothing it read is kept then.
   */
  async read(
    path: string,
    params: HttpParams,
    current: () => boolean,
  ): Promise<PreviewRead | null> {
    const html = await firstValueFrom(
      this.http.get(`${this.base}${path}`, {
        params,
        headers: { Accept: 'text/html' },
        responseType: 'text',
      }),
    );
    if (!current()) return null;
    const apiRoot = new URL(this.base, this.doc.baseURI).href.replace(
      /\/+$/,
      '',
    );
    const origin = { pageUrl: `${apiRoot}${path}`, apiRoot };
    const images = await this.readImages(
      previewImageUrls(html, origin),
      apiRoot,
      current,
    );
    if (!current()) {
      images.forEach((url) => URL.revokeObjectURL(url));
      return null;
    }
    return { html, origin, images };
  }

  /** The document the frame shows for a page read. */
  document(read: PreviewRead, dark: boolean): string {
    return previewDocument(read.html, read.origin, {
      dark,
      images: read.images,
    });
  }

  /**
   * Reads the images with the person's credentials, a few at a time; one that fails shows none.
   * A safety symbol's artwork is shown as a PNG (`symbolPng`: an SVG rasterised).
   */
  private async readImages(
    urls: readonly string[],
    apiRoot: string,
    current: () => boolean,
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const queue = urls.slice(0, MAX_IMAGES);
    const worker = async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        if (!current()) return;
        try {
          // Read under the API's own base, so the interceptors (the demo user's header) apply;
          // `url` is the absolute form the document names it by.
          const blob = await firstValueFrom(
            this.http.get(`${this.base}${url.slice(apiRoot.length)}`, {
              responseType: 'blob',
              headers: { Accept: 'image/*' },
            }),
          );
          if (isSymbolUrl(url, apiRoot)) {
            // A safety symbol's artwork, often an SVG: shown as a PNG, never from an SVG's URL.
            const png = await symbolPng(blob, this.rasterize);
            if (png && current()) found.set(url, URL.createObjectURL(png));
            continue;
          }
          const type = /^image\/(png|jpeg|gif|webp)$/.test(blob.type)
            ? blob.type
            : 'application/octet-stream';
          found.set(url, URL.createObjectURL(new Blob([blob], { type })));
        } catch {
          // Shown without it, as a reader would see a missing image.
        }
      }
    };
    await Promise.all(Array.from({ length: IMAGE_READS }, worker));
    return found;
  }
}
