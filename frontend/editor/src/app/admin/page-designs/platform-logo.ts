import type { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import type { ApiClient } from '../../api';
import { imageUrl } from '../../branding/branding-model';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether these bytes are a PNG (its signature): the change set's image upload takes PNG and JPEG. */
export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * The platform's light logo (#169's branding, `sha256:<hash>`) as a PNG file, for "Use the
 * platform logo": read from the branding's public image route; a WebP (which the change set's
 * upload does not take) is drawn into a canvas and exported as PNG.
 */
export async function platformLogoFile(
  http: HttpClient,
  apiBase: string,
  reference: string,
): Promise<File> {
  const url = imageUrl(apiBase, reference);
  if (!url) throw new Error('not a branding image');
  const blob = await firstValueFrom(http.get(url, { responseType: 'blob' }));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isPng(bytes)) {
    return new File([bytes], 'platform-logo.png', { type: 'image/png' });
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  const png = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!png) throw new Error('the logo could not be converted');
  return new File([png], 'platform-logo.png', { type: 'image/png' });
}

/** Uploads a logo into the change set (`POST /change-sets/{id}/assets`); resolves to its reference. */
export async function uploadLogo(
  api: ApiClient,
  changeSetId: string,
  file: File,
): Promise<string> {
  const doc = await firstValueFrom(
    api.upload(
      '/change-sets/{changeSetId}/assets',
      { path: { changeSetId } },
      file,
    ),
  );
  return doc.data.attributes.reference;
}
