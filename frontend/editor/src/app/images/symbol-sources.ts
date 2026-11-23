import { DestroyRef, Injectable, inject, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, ReadRef, toApiError } from '../api';
import { MeService } from '../permissions/me';
import { RASTERIZE_SVG } from './svg-raster';

/**
 * A safety symbol's artwork as a PNG, from what `GET /symbols/{id}` sent: a PNG as it is, an SVG
 * rasterised (`RASTERIZE_SVG`: never a `blob:` URL of an SVG); null for anything else.
 */
export async function symbolPng(
  bytes: Blob,
  rasterize: (svg: Blob) => Promise<Blob | null>,
): Promise<Blob | null> {
  if (bytes.type === 'image/png') return bytes;
  if (bytes.type === 'image/svg+xml') {
    const png = await rasterize(bytes);
    return png?.type === 'image/png' ? png : null;
  }
  return null;
}

/**
 * Shows safety symbols (#208): reads a symbol's artwork through the API (`GET /symbols/{id}`, at
 * the chosen change set's branch, so the demo identity and the branch apply) and hands out an
 * object URL of it as a PNG, once per symbol and branch. Provided per page: its URLs are revoked
 * when the page goes.
 */
@Injectable()
export class SymbolSources {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService).me;
  private readonly rasterize = inject(RASTERIZE_SVG);
  private readonly urls = new Map<string, Promise<string | null>>();
  private readonly made = new Set<string>();
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.gone = true;
      for (const url of this.made) URL.revokeObjectURL(url);
      this.made.clear();
      this.urls.clear();
    });
  }

  /**
   * An address to show the symbol's artwork at, or null when it has none (not configured, no
   * file, a file that is no image, one the browser cannot draw). Rejects when it could not be
   * read (asked again next time).
   */
  source(id: string): Promise<string | null> {
    // Per person too (#706): what one may not see is asked anew for the next.
    const who = untracked(() => this.me().id);
    const key = `${who}\n${this.readRef.ref() ?? ''}\n${id}`;
    let found = this.urls.get(key);
    if (!found) {
      found = this.read(id);
      found.catch(() => this.urls.delete(key));
      this.urls.set(key, found);
    }
    return found;
  }

  private async read(id: string): Promise<string | null> {
    const bytes = await firstValueFrom(
      this.api.image('/symbols/{id}', { path: { id } }),
    ).catch((error: unknown) => {
      // No artwork, or a file that is none: both show the label, marked.
      if ([403, 404, 422].includes(toApiError(error).status)) return null;
      throw error;
    });
    if (!bytes || this.gone) return null;
    const png = await symbolPng(bytes, this.rasterize);
    if (!png || this.gone) return null;
    const url = URL.createObjectURL(png);
    this.made.add(url);
    return url;
  }
}
