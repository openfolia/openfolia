import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, pageQuery } from '../api';
import { labelsInUi } from '../i18n';
import type { ManualItem } from '../preview/preview-model';
import { Generation } from '../shared/generation';
import {
  productFacetOf,
  productLabel,
  type ReleaseDetail,
  type StoredConfig,
} from './releases-model';

/** The branch releases are cut from. */
export const MAIN = 'main';
/** At most this many pages of manuals are read. */
const MANUAL_PAGES = 10;
const MANUAL_PAGE_SIZE = 100;

/**
 * What the release screens read besides releases, provided per page: the configuration at `main`
 * (the product facet and its labels, the languages), the manuals at a ref (their titles and
 * variants), and one release.
 *
 * What it keeps was read for one person: `forget()` (another person acts now) drops it, and a
 * read still running then never writes its answer (#706), nor does a read of the manuals at a tag
 * chosen before another.
 */
@Injectable()
export class ReleaseSource {
  private readonly api = inject(ApiClient);

  /** The configuration at `main` as read; null until read (or when it could not be). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration at `main`, its labels in the interface language (#731). */
  readonly config = labelsInUi(this.storedConfig);
  /** The manuals at the last tag `readManualsAt` read. */
  readonly manualsAtTag = signal<readonly ManualItem[]>([]);
  private manualsTag: string | null = null;
  private configRead: Promise<StoredConfig | null> | null = null;
  private readonly configReads = new Generation();
  private readonly manualsReads = new Generation();

  /** The product facet's values, to choose a product from. */
  readonly products = computed(() => {
    const config = this.config();
    return config ? (productFacetOf(config)?.values ?? []) : [];
  });

  productLabel(product: string): string {
    return productLabel(this.config(), product);
  }

  /** Reads the configuration at `main` once; null when it could not be read. */
  readConfig(): Promise<StoredConfig | null> {
    if (this.configRead) return this.configRead;
    const live = this.configReads.start();
    const read = firstValueFrom(
      this.api.get('/config', { query: { ref: MAIN } }),
    )
      .then((doc) => {
        // Read for whoever acted before `forget()`: neither kept nor handed on (a caller still
        // waiting for it, an open dialog, takes it as not read).
        if (!live()) return null;
        this.storedConfig.set(doc.data.attributes);
        return doc.data.attributes;
      })
      .catch(() => {
        if (live()) this.configRead = null;
        return null;
      });
    this.configRead = read;
    return read;
  }

  /** Forgets what was read (another person acts now): no read still running writes its answer. */
  forget(): void {
    this.configReads.end();
    this.manualsReads.end();
    this.configRead = null;
    this.manualsTag = null;
    this.storedConfig.set(null);
    this.manualsAtTag.set([]);
  }

  /** The release, with where its files stand (`meta.outputs`). */
  release(id: string): Promise<ReleaseDetail> {
    return firstValueFrom(
      this.api.get('/releases/{releaseId}', { path: { releaseId: id } }),
    ).then((doc) => doc.data);
  }

  /** The manuals the reader may read at `ref` (a tag, a branch), every page. */
  async manuals(ref: string): Promise<ManualItem[]> {
    const found: ManualItem[] = [];
    for (let page = 1; page <= MANUAL_PAGES; page++) {
      const doc = await firstValueFrom(
        this.api.get('/manuals', {
          query: {
            ref,
            ...pageQuery({ number: page, size: MANUAL_PAGE_SIZE }),
          },
        }),
      );
      for (const manual of doc.data) {
        if ('attributes' in manual) found.push(manual);
      }
      if (!doc.links.next) break;
    }
    return found;
  }

  /**
   * Reads the manuals at a release's tag into `manualsAtTag`, once per tag: another tag's are not
   * shown meanwhile, and titles fall back to IDs on failure (the tag is read again next time).
   * Only the read started last writes: one for a tag chosen before, or started before `forget()`,
   * never does.
   */
  async readManualsAt(tag: string): Promise<void> {
    if (this.manualsTag === tag) return;
    const live = this.manualsReads.start();
    this.manualsTag = tag;
    this.manualsAtTag.set([]);
    void this.readConfig();
    try {
      const manuals = await this.manuals(tag);
      if (live()) this.manualsAtTag.set(manuals);
    } catch {
      if (live()) {
        this.manualsTag = null;
        this.manualsAtTag.set([]);
      }
    }
  }
}
