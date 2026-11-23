import type { HttpResponse } from '@angular/common/http';
import { DOCUMENT, Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, toApiError } from '../api';
import { assetHash } from '../images/image-model';

/** How long a saved file's object URL lives: the browser has taken the bytes by then. */
const KEEP_URL_MS = 30_000;

/**
 * Saves attached files to the person's device. The bytes are read through the API (so the demo
 * identity and the chosen branch apply, as for images): `GET /assets/{hash}` at the branch, else a
 * fresh upload from the change set's preview. They are handed to the browser only as a file to
 * save: a `blob:` URL typed `application/octet-stream` behind a link with `download`, never shown,
 * opened or put in the page, whatever the file is (an HTML or SVG attachment included).
 */
@Injectable()
export class AttachmentFiles {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);

  /**
   * Saves the file under the name the API serves it under: a name that fits the file's stored type
   * (`Content-Disposition`), never the block's `fileName` as such, which content could set to
   * `notes.vbs` on harmless text. A picture the API shows in place (no disposition) keeps
   * `fileName` only when its extension is the picture's own. Resolves to false when there is no
   * such file or the person may not see it; rejects when it could not be read.
   */
  async save(
    asset: string,
    fileName: string,
    changeSetId: string | null,
  ): Promise<boolean> {
    const response = await this.read(asset, changeSetId);
    const bytes = response?.body;
    if (!response || !bytes) return false;
    const name =
      servedName(response.headers.get('Content-Disposition')) ??
      pictureName(fileName, bytes.type) ??
      assetHash(asset) ??
      'file';
    // Never the file's own type: a `blob:` URL is of the editor's origin, and a page or an SVG
    // opened from it would run there. As octet-stream the browser only ever saves it.
    const file = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(file);
    const link = this.document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.hidden = true;
    this.document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS);
    }
    return true;
  }

  private async read(
    asset: string,
    changeSetId: string | null,
  ): Promise<HttpResponse<Blob> | null> {
    const hash = assetHash(asset);
    if (!hash) return null;
    // Not there, or not for this person: both read as "not found or not visible".
    const absent = (error: unknown): null => {
      if ([403, 404].includes(toApiError(error).status)) return null;
      throw error;
    };
    const atBranch = await firstValueFrom(
      this.api.file('/assets/{hash}', { path: { hash } }),
    ).catch(absent);
    if (atBranch || !changeSetId) return atBranch;
    return firstValueFrom(
      this.api.file('/change-sets/{changeSetId}/assets/{hash}', {
        path: { changeSetId, hash },
      }),
    ).catch(absent);
  }
}

/**
 * The file name a `Content-Disposition` header gives: its RFC 8187 `filename*` (UTF-8), else its
 * plain `filename`; null without one. Path separators never survive (the browser drops them too).
 */
export function servedName(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  let name: string | null = null;
  if (encoded) {
    try {
      name = decodeURIComponent(encoded.trim());
    } catch {
      name = null;
    }
  }
  name ??= /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? null;
  const clean = name?.replace(/[/\\]/g, '_').trim();
  return clean ? clean : null;
}

/** The pictures the API shows in place, by the extensions that are theirs. */
const PICTURE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
};

/** `fileName` for a picture served in place, when its extension is the picture's own; else null. */
function pictureName(fileName: string, type: string): string | null {
  const extensions = PICTURE_EXTENSIONS[type.split(';')[0]?.trim() ?? ''];
  const lower = fileName.toLowerCase();
  return extensions?.some((e) => lower.endsWith(e) && lower.length > e.length)
    ? fileName
    : null;
}
