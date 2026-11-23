import { DOCUMENT, inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError, type Response } from '../api';
import { apiErrorText } from '../i18n';

export type StableAddressDoc = Response<'/stable-addresses'>;
export type StableAddressItem = StableAddressDoc['data'][number];
/** Who may open the addresses (`delivery.access`) and `CCMS_PUBLIC_URL`. */
export type AddressSettings = Pick<
  StableAddressDoc['meta'],
  'access' | 'publicUrl'
>;

/** One stable address in the dialog: the resource and the settings it was listed with. */
export interface ShownAddress {
  readonly item: StableAddressItem;
  readonly settings: AddressSettings;
}

/** How a link reads: its URL, or its path while `CCMS_PUBLIC_URL` is not set. */
export const linkText = (link: { path: string; url: string | null }) =>
  link.url ?? link.path;

/** How long a saved file's object URL lives: the browser has taken the bytes by then. */
const KEEP_URL_MS = 30_000;

/**
 * The stable addresses (#450) as the editor uses them: one found for a release's file, the QR
 * code read through the API (so the demo identity applies), copied or saved as a file.
 */
@Injectable({ providedIn: 'root' })
export class StableAddresses {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly document = inject(DOCUMENT);

  /**
   * The address of one manual, variant and language of a release; null when the reader may
   * not read it there (the API leaves it out).
   */
  async find(query: {
    readonly releaseId: string;
    readonly manual: string;
    readonly variant: string;
    readonly lang: string;
  }): Promise<ShownAddress | null> {
    const doc = await firstValueFrom(
      this.api.get('/stable-addresses', {
        query: {
          'filter[release]': query.releaseId,
          'filter[manual]': query.manual,
          'filter[lang]': query.lang,
          ...pageQuery({ number: 1, size: 100 }),
        },
      }),
    );
    const item = doc.data.find((a) => a.attributes.variant === query.variant);
    return item ? { item, settings: settingsOf(doc) } : null;
  }

  /** The QR code of `path` as an image for the page: a `blob:` URL, the caller's to revoke. */
  async preview(path: string): Promise<string> {
    const response = await firstValueFrom(this.api.qrCode(path, 'svg'));
    if (!response.body) throw new Error('The QR code was empty.');
    return URL.createObjectURL(
      new Blob([response.body], { type: 'image/svg+xml' }),
    );
  }

  /** Saves the QR code of `path` as `<name>.<format>`; says so in a toast when it fails. */
  async save(path: string, format: 'svg' | 'png', name: string): Promise<void> {
    try {
      const response = await firstValueFrom(this.api.qrCode(path, format));
      if (!response.body) throw new Error('The QR code was empty.');
      this.hand(response.body, `${name}.${format}`);
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    }
  }

  /** Copies `text`; says in a toast whether it worked. */
  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success(translated('editor.addresses.copied'));
    } catch {
      this.toast.error(translated('editor.addresses.copyFailed'));
    }
  }

  /** Hands the bytes to the browser as a file to save, never opened in the page. */
  private hand(bytes: Blob, name: string): void {
    const url = URL.createObjectURL(
      new Blob([bytes], { type: 'application/octet-stream' }),
    );
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
  }
}

export const settingsOf = (doc: StableAddressDoc): AddressSettings => ({
  access: doc.meta.access,
  publicUrl: doc.meta.publicUrl,
});

/** A file name for an address's QR code: `qr_<product>_<slug>_<variant>_<lang>[_<revision>]`. */
export function qrFileName(item: StableAddressItem, pinned: boolean): string {
  const a = item.attributes;
  return [
    'qr',
    a.product,
    a.slug,
    a.variant,
    a.lang,
    ...(pinned ? [a.revision] : []),
  ]
    .join('_')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
}
