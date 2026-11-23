import { computed, inject, Injectable, signal } from '@angular/core';

import { isUnconfirmed, MeService } from '../permissions/me';
import { readStored, writeStored } from '../session/stored';

/** Something the person opened from the palette, as the palette lists it again. */
export interface RecentItem {
  readonly kind: 'module' | 'manual';
  /** The module's ID (without its language) or the manual's ID. */
  readonly id: string;
  /** A module's language; a manual has none. */
  readonly lang?: string;
  readonly title: string;
}

/** How many recent items are kept, newest first. */
export const RECENT_MAX = 6;
const PREFIX = 'openfolia.recent.';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LANG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const TITLE_MAX = 500;

/** Whether a value is a well-formed recent item (also used for API results before they show). */
export const isRecent = (value: unknown): value is RecentItem => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  if (item['kind'] !== 'module' && item['kind'] !== 'manual') return false;
  if (typeof item['id'] !== 'string' || !ID.test(item['id'])) return false;
  if (
    typeof item['title'] !== 'string' ||
    item['title'].length === 0 ||
    item['title'].length > TITLE_MAX
  ) {
    return false;
  }
  return item['kind'] === 'module'
    ? typeof item['lang'] === 'string' && LANG.test(item['lang'])
    : item['lang'] === undefined;
};

const sameItem = (a: RecentItem, b: RecentItem): boolean =>
  a.kind === b.kind && a.id === b.id && a.lang === b.lang;

/** Reads a stored list; anything that is not a well-formed list of ours is ignored. */
function readList(key: string): RecentItem[] {
  const raw = readStored(key);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(isRecent)
      .slice(0, RECENT_MAX)
      .map(({ kind, id, lang, title }) =>
        kind === 'module' ? { kind, id, lang, title } : { kind, id, title },
      );
  } catch {
    return [];
  }
}

/**
 * What the person last opened from the search palette, per viewer: kept in this browser's local
 * storage under the acting person's ID, so a demo switch to another user shows that user's own
 * list. Storage that is blocked or full only means nothing is remembered. Nothing is kept until
 * `GET /me` has said who is acting.
 */
@Injectable({ providedIn: 'root' })
export class RecentItems {
  private readonly meService = inject(MeService);
  /** Bumped on every write, so `items` reads storage again. */
  private readonly version = signal(0);
  private readonly key = computed(() => {
    const id = this.meService.me().id;
    // Not while another tab's sign-in is unconfirmed here: kept for nobody (#716).
    return id && !isUnconfirmed(id) ? `${PREFIX}${id}` : null;
  });

  /** Newest first, at most `RECENT_MAX`. */
  readonly items = computed<readonly RecentItem[]>(() => {
    this.version();
    const key = this.key();
    return key ? readList(key) : [];
  });

  /** Puts an item first (once: an older entry for it goes). */
  add(item: RecentItem): void {
    const key = this.key();
    if (!key || !isRecent(item)) return;
    const list = [item, ...readList(key).filter((i) => !sameItem(i, item))];
    writeStored(key, JSON.stringify(list.slice(0, RECENT_MAX)));
    this.version.update((v) => v + 1);
  }
}
