import { DestroyRef, Injectable, inject, untracked } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';

import { ApiClient, ReadRef, toApiError, type RenditionWidth } from '../api';
import { MeService } from '../permissions/me';
import { assetHash, SHOWN_TYPES } from './image-model';

/** At most this many images are read at once (a grid of tiles, a module with many images). */
const READS = 4;

/**
 * A busy answer (503 with `Retry-After`: renditions being made, say) is asked again this many
 * times, after the seconds it names (at most `MAX_WAIT_S`), while the picture stays pending.
 */
const BUSY_RETRIES = 3;
const MAX_WAIT_S = 5;

/** A read asked for the person before the one acting now: never sent for them. */
class StaleRead extends Error {
  constructor() {
    super('Read for another person');
  }
}

/** How an image is read. */
export interface SourceOptions {
  /**
   * A fresh upload into the change set that no module at the ref shows yet (the media list's
   * `meta.uploaded` with no use): read from the change set's preview first, which is where the
   * API serves it until a module shows it, so `GET /assets/{hash}` is not asked for a 404.
   */
  readonly upload?: boolean;
}

/**
 * Shows images: reads an image's bytes through the API (so the demo identity and the chosen
 * change set's branch apply, which an `<img src>` would not carry) and hands out an object URL,
 * once per image, branch and change set. An image a module at the branch shows comes from
 * `GET /assets/{hash}`; a fresh upload no module shows yet from the change set's preview
 * (`GET /change-sets/{id}/assets/{hash}`, its author only), asked first for a file the caller
 * knows is such an upload (`SourceOptions.upload`). Provided per page: its URLs are revoked when
 * the page goes.
 *
 * What is read for one person is kept for them alone (#706): the person is part of the key, a
 * read still waiting for its turn when another person acts is never sent, and one answered after
 * it is never handed on: either is asked again for the person acting now.
 */
@Injectable()
export class ImageSources {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService).me;
  private readonly urls = new Map<string, Promise<string | null>>();
  private readonly made = new Set<string>();
  private reading = 0;
  private readonly waiting: (() => void)[] = [];
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.gone = true;
      // Reads still waiting for their turn give up without asking.
      for (const next of this.waiting.splice(0)) next();
      for (const url of this.made) URL.revokeObjectURL(url);
      this.made.clear();
      this.urls.clear();
    });
  }

  /**
   * An address to show the image at, or null when there is no such image or the person may not
   * see it. Rejects when it could not be read (asked again next time: Retry). `ref` reads it at
   * that ref (a commit, say) in place of the chosen change set's branch; `width` reads its
   * rendition at most that wide (PNG, JPEG, GIF and WebP images only: the API has none of others).
   * The same image is the same bytes by whichever route it is read, so `options` does not split
   * the cache.
   */
  source(
    asset: string,
    changeSetId: string | null,
    ref?: string,
    width?: RenditionWidth,
    options: SourceOptions = {},
  ): Promise<string | null> {
    const hash = assetHash(asset);
    if (!hash) return Promise.resolve(null);
    const key = this.key(hash, changeSetId, ref, width);
    let found = this.urls.get(key);
    if (!found) {
      const read: Promise<string | null> = this.read(
        this.person(),
        hash,
        changeSetId,
        ref,
        width,
        options.upload === true,
      ).catch((error: unknown) => {
        if (!(error instanceof StaleRead) || this.gone) throw error;
        // Asked for the person before: whoever waits for it gets the one acting now's image.
        if (this.urls.get(key) === read) this.urls.delete(key);
        return this.source(asset, changeSetId, ref, width, options);
      });
      read.catch(() => {
        if (this.urls.get(key) === read) this.urls.delete(key);
      });
      this.urls.set(key, read);
      found = read;
    }
    return found;
  }

  /**
   * The bytes of an image this page uploaded, as the API typed them: shown from them, never read
   * again. `uploadedBy` is who uploaded it (`MeService`, as the upload started): kept for them
   * only, so an upload that answers after another person acts is read for that one like any
   * other image (#716).
   */
  remember(
    asset: string,
    bytes: Blob,
    contentType: string,
    changeSetId: string | null,
    uploadedBy: string,
  ): void {
    const hash = assetHash(asset);
    if (!hash || this.gone || uploadedBy !== this.person()) return;
    // A URL made before for the same image may still be shown: it stays until the page goes.
    this.urls.set(
      this.key(hash, changeSetId),
      Promise.resolve(this.objectUrl(new Blob([bytes], { type: contentType }))),
    );
  }

  /**
   * An object URL for bytes this page holds, revoked with the page; null for a type not shown
   * from one (`SHOWN_TYPES`: never SVG).
   */
  objectUrl(bytes: Blob): string | null {
    if (!SHOWN_TYPES.has(bytes.type)) return null;
    const url = URL.createObjectURL(bytes);
    this.made.add(url);
    return url;
  }

  /** Lets go of an object URL made here before the page goes (an upload taken back). */
  release(url: string): void {
    if (this.made.delete(url)) URL.revokeObjectURL(url);
  }

  private key(
    hash: string,
    changeSetId: string | null,
    ref?: string,
    width?: RenditionWidth,
  ): string {
    const base = `${this.person()}\n${ref ?? this.readRef.ref() ?? ''}\n${changeSetId ?? ''}\n${hash}`;
    return width ? `${base}\n${width}` : base;
  }

  /** Who acts now: what a read is kept for (not tracked: a read is no reactive context). */
  private person(): string {
    return untracked(() => this.me().id);
  }

  private async read(
    who: string,
    hash: string,
    changeSetId: string | null,
    ref: string | undefined,
    width: RenditionWidth | undefined,
    upload: boolean,
  ): Promise<string | null> {
    await this.turn();
    try {
      if (this.gone) return null;
      // Asked for the person before: sent now, it would carry the next one's identity.
      if (who !== this.person()) throw new StaleRead();
      const atRef = () =>
        this.api.image('/assets/{hash}', {
          path: { hash },
          ...(ref !== undefined && { ref }),
          ...(width !== undefined && { width }),
        });
      const preview = (id: string) => () =>
        this.api.image('/change-sets/{changeSetId}/assets/{hash}', {
          path: { changeSetId: id, hash },
          ...(width !== undefined && { width }),
        });
      // A known fresh upload from the change set's preview first; else at the ref first. The
      // other is still asked when the first has none: the list may be older than the content.
      const routes = !changeSetId
        ? [atRef]
        : upload
          ? [preview(changeSetId), atRef]
          : [atRef, preview(changeSetId)];
      let bytes: Blob | null = null;
      for (const route of routes) {
        if (who !== this.person()) throw new StaleRead();
        bytes = await this.fetch(route, who);
        if (bytes || this.gone) break;
      }
      // Answered after another person acts: theirs to read again, not this one's to show.
      if (who !== this.person()) throw new StaleRead();
      return bytes && !this.gone ? this.objectUrl(bytes) : null;
    } finally {
      this.done();
    }
  }

  /**
   * One route's bytes; null when it has none for this person (403 or 404: "not found or not
   * visible"). A busy answer (503 with `Retry-After`) is asked again after that wait, a few times.
   */
  private async fetch(
    route: () => Observable<Blob>,
    who: string,
  ): Promise<Blob | null> {
    for (let attempt = 0; ; attempt += 1) {
      if (who !== this.person()) throw new StaleRead();
      try {
        return await firstValueFrom(route());
      } catch (error) {
        const failure = toApiError(error);
        if ([403, 404].includes(failure.status)) return null;
        const wait = failure.retryAfter;
        if (
          failure.status !== 503 ||
          wait === undefined ||
          attempt >= BUSY_RETRIES ||
          this.gone
        ) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(wait, MAX_WAIT_S) * 1000),
        );
        if (this.gone) return null;
      }
    }
  }

  private turn(): Promise<void> {
    return new Promise((resolve) => {
      if (this.reading < READS) {
        this.reading += 1;
        resolve();
      } else this.waiting.push(resolve);
    });
  }

  private done(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.reading -= 1;
  }
}
