import {
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { MeService } from '../permissions/me';
import { DemoSession } from '../session/demo-session';
import {
  releaseIdsOf,
  type NotificationItem,
  type Who,
} from './notification-model';

/** How often the unread count is asked for while the tab is visible. */
export const POLL_MS = 30_000;
/** Notifications per page of the sheet. */
export const NOTIFICATION_PAGE_SIZE = 20;

/**
 * The acting person's notifications: the unread count for the bell, polled every 30 s while the
 * tab is visible and at once when it comes back, and the sheet's list, newest first, paged with
 * "Load more". Marking read is eager: the row and the count change at once and go back, with a
 * Retry toast, when the API refuses. Everything belongs to one person: a switch of the person
 * (the demo user) starts over, and an answer for the previous one is dropped.
 */
@Injectable({ providedIn: 'root' })
export class NotificationCenter {
  private readonly api = inject(ApiClient);
  private readonly meService = inject(MeService);
  private readonly demo = inject(DemoSession);
  private readonly toast = inject(ToastService);
  private readonly document = inject(DOCUMENT);

  private readonly count = signal<number | null>(null);
  private readonly list = signal<readonly NotificationItem[]>([]);
  private readonly busy = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly answered = signal(false);
  private readonly more = signal(false);
  private readonly labels = signal<ReadonlyMap<string, string | null>>(
    new Map(),
  );

  /** How many are unread; null until the first answer. */
  readonly unread = this.count.asReadonly();
  /** The rows loaded so far, newest first. */
  readonly items = this.list.asReadonly();
  /** A page is being read (the first, again, or the next). */
  readonly loading = this.busy.asReadonly();
  /** Why the last read of the list failed; null when it did not. */
  readonly error = this.failure.asReadonly();
  /** The list has been read at least once for the filter shown (the empty state may show). */
  readonly loaded = this.answered.asReadonly();
  /** There is another page to load. */
  readonly hasMore = this.more.asReadonly();

  /** Whose notifications these are (`me().id`); '' while nobody is acting. */
  private owner = '';
  /** Bumped whenever the list starts over (a person, a filter): older answers are dropped. */
  private generation = 0;
  /** Bumped by every local change of the count: a poll sent before it is not trusted. */
  private countVersion = 0;
  /** The owner a poll is in flight for; '' when none is. */
  private polling = '';
  private latest: string | null | undefined = undefined;
  private unreadOnly = false;
  private open = false;
  private page = 0;

  /**
   * Starts following the acting person: the count now and on every poll, focus and return to
   * the tab. Called once, by the bell, in its injection context: it stops with the bell.
   */
  watch(): void {
    const destroyRef = inject(DestroyRef);
    effect(() => {
      const me = this.meService.me();
      const acting =
        this.meService.presence() === 'person' && me.kind === 'user';
      const id = acting ? me.id : '';
      untracked(() => {
        if (id === this.owner) return;
        this.reset(id);
        if (id) void this.refreshCount();
      });
    });
    const view = this.document.defaultView;
    const timer = setInterval(() => {
      if (this.document.visibilityState === 'visible') void this.refreshCount();
    }, POLL_MS);
    const onVisible = () => {
      if (this.document.visibilityState === 'visible') void this.refreshCount();
    };
    this.document.addEventListener('visibilitychange', onVisible);
    view?.addEventListener('focus', onVisible);
    destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.document.removeEventListener('visibilitychange', onVisible);
      view?.removeEventListener('focus', onVisible);
    });
  }

  /** Asks for the unread count; a new notification while the sheet is open is added to it. */
  async refreshCount(): Promise<void> {
    const owner = this.owner;
    if (!owner || this.polling === owner) return;
    this.polling = owner;
    const version = this.countVersion;
    try {
      const doc = await firstValueFrom(
        this.api.get('/me/notifications/unread-count'),
      );
      if (owner !== this.owner) return;
      if (version === this.countVersion) this.count.set(doc.meta.unreadCount);
      const latest = doc.meta.latest;
      const arrived = this.latest !== undefined && latest !== this.latest;
      this.latest = latest;
      if (arrived && this.open && this.answered()) void this.load('newer');
    } catch {
      // The bell keeps its last count; the next poll tries again.
    } finally {
      if (this.polling === owner) this.polling = '';
    }
  }

  /** The sheet opens (or its filter changes): the first page, read again. */
  show(unreadOnly: boolean): void {
    const changed = unreadOnly !== this.unreadOnly;
    this.open = true;
    this.unreadOnly = unreadOnly;
    // Before the person is known (a link opened cold): `reset` reads it once they are.
    if (!this.owner) return;
    if (changed) {
      // Another filter: the rows shown stay, dimmed, until its first page replaces them.
      this.generation++;
      this.answered.set(false);
    }
    void this.load('first');
  }

  /** The sheet closed: nothing new is added to it until it opens again. */
  hide(): void {
    this.open = false;
  }

  /** The next page, after the rows shown. */
  loadMore(): void {
    if (this.busy() || !this.more()) return;
    void this.load('next');
  }

  /** Reads the first page again (after a failure). */
  retry(): void {
    void this.load('first');
  }

  /** A person's name, when the editor knows it (themself, or a demo user). */
  nameOf(who: Who): string | null {
    if (who.kind !== 'user') return null;
    const me = this.meService.me();
    if (me.id === who.id && me.name) return me.name;
    return this.demo.users().find((u) => u.id === who.id)?.name ?? null;
  }

  /** A release's label ("Product 2.1"), once read; null when it could not be. */
  releaseLabel(id: string): string | null {
    return this.labels().get(id) ?? null;
  }

  /** Marks one read, eagerly; a refusal puts it back with a Retry toast. */
  async markRead(id: string): Promise<void> {
    const owner = this.owner;
    const item = this.list().find((i) => i.id === id);
    if (!owner || !item || item.attributes.readAt !== null) return;
    this.setRead([id], new Date().toISOString());
    this.changeCount((n) => Math.max(0, n - 1));
    const version = this.countVersion;
    try {
      const doc = await firstValueFrom(
        this.api.act(
          '/me/notifications/read',
          { path: {} as never },
          {
            meta: { ids: [id] },
          },
        ),
      );
      if (owner === this.owner && version === this.countVersion) {
        this.count.set(doc.meta.unreadCount);
      }
    } catch (error) {
      if (owner !== this.owner) return;
      this.setRead([id], null);
      this.changeCount((n) => n + 1);
      this.failed(error, () => void this.markRead(id));
    }
  }

  /** Marks all read, eagerly; a refusal puts the rows and the count back with a Retry toast. */
  async markAllRead(): Promise<void> {
    const owner = this.owner;
    if (!owner || this.count() === 0) return;
    const before = this.count();
    const unread = this.list()
      .filter((i) => i.attributes.readAt === null)
      .map((i) => i.id);
    this.setRead(unread, new Date().toISOString());
    this.changeCount(() => 0);
    const version = this.countVersion;
    try {
      const doc = await firstValueFrom(
        this.api.act(
          '/me/notifications/read',
          { path: {} as never },
          {
            meta: { all: true },
          },
        ),
      );
      if (owner === this.owner && version === this.countVersion) {
        this.count.set(doc.meta.unreadCount);
      }
    } catch (error) {
      if (owner !== this.owner) return;
      this.setRead(unread, null);
      this.changeCount((n) => n + (before ?? unread.length));
      this.failed(error, () => void this.markAllRead());
    }
  }

  private failed(error: unknown, retry: () => void): void {
    const kind = toApiError(error).kind;
    this.toast.error(
      translated(
        kind === 'network'
          ? 'editor.notifications.markFailedOffline'
          : 'editor.notifications.markFailed',
      ),
      {
        actionLabel: translated('editor.notifications.retry'),
        onAction: retry,
      },
    );
  }

  private changeCount(change: (n: number) => number): void {
    this.countVersion++;
    this.count.update((n) => (n === null ? n : change(n)));
  }

  private setRead(ids: readonly string[], readAt: string | null): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    this.list.update((items) =>
      items.map((i) =>
        set.has(i.id) ? { ...i, attributes: { ...i.attributes, readAt } } : i,
      ),
    );
  }

  /**
   * Reads a page: `first` replaces the rows (they stay, dimmed, until it arrives), `next`
   * appends the following page, `newer` adds what arrived since at the top.
   */
  private async load(mode: 'first' | 'next' | 'newer'): Promise<void> {
    const owner = this.owner;
    const generation = this.generation;
    const version = this.countVersion;
    const number = mode === 'next' ? this.page + 1 : 1;
    if (mode !== 'newer') {
      this.busy.set(true);
      this.failure.set(null);
    }
    try {
      const doc = await firstValueFrom(
        this.api.get('/me/notifications', {
          query: {
            ...pageQuery({ number, size: NOTIFICATION_PAGE_SIZE }),
            ...(this.unreadOnly ? { 'filter[unread]': 'true' } : {}),
          },
        }),
      );
      await this.readLabels(doc.data, owner);
      if (owner !== this.owner || generation !== this.generation) return;
      if (version === this.countVersion) this.count.set(doc.meta.unreadCount);
      const page = doc.meta.page;
      if (mode === 'newer') {
        const known = new Set(this.list().map((i) => i.id));
        const fresh = doc.data.filter((i) => !known.has(i.id));
        if (fresh.length > 0) this.list.update((items) => [...fresh, ...items]);
        return;
      }
      if (mode === 'first') {
        this.list.set(doc.data);
      } else {
        const known = new Set(this.list().map((i) => i.id));
        const next = doc.data.filter((i) => !known.has(i.id));
        this.list.update((items) => [...items, ...next]);
      }
      this.page = page.currentPage;
      this.more.set(page.currentPage < page.lastPage);
      this.answered.set(true);
    } catch (error) {
      if (owner !== this.owner || generation !== this.generation) return;
      if (mode === 'newer') return;
      if (mode === 'first') this.failure.set(toApiError(error));
      else
        this.toast.error(translated('editor.notifications.loadMoreFailed'), {
          actionLabel: translated('editor.notifications.retry'),
          onAction: () => this.loadMore(),
        });
    } finally {
      if (
        mode !== 'newer' &&
        owner === this.owner &&
        generation === this.generation
      ) {
        this.busy.set(false);
      }
    }
  }

  /** Reads the labels of the releases a page names that are not known yet. */
  private async readLabels(
    items: readonly NotificationItem[],
    owner: string,
  ): Promise<void> {
    const known = this.labels();
    const ids = releaseIdsOf(items).filter((id) => !known.has(id));
    if (ids.length === 0) return;
    const read = await Promise.all(
      ids.map(async (id): Promise<[string, string | null]> => {
        try {
          const doc = await firstValueFrom(
            this.api.get('/releases/{releaseId}', {
              path: { releaseId: id },
            }),
          );
          const a = doc.data.attributes;
          return [id, `${a.product} ${a.revision}`];
        } catch {
          // Not readable (gone, no longer allowed, offline): the sentence names no release.
          return [id, null];
        }
      }),
    );
    // Read with one person's rights: never kept for the next one.
    if (owner !== this.owner) return;
    this.labels.update((map) => new Map([...map, ...read]));
  }

  private reset(owner: string): void {
    this.owner = owner;
    this.generation++;
    this.countVersion++;
    this.latest = undefined;
    this.page = 0;
    this.count.set(null);
    this.list.set([]);
    this.labels.set(new Map());
    this.busy.set(false);
    this.failure.set(null);
    this.answered.set(false);
    this.more.set(false);
    if (this.open && owner) void this.load('first');
  }
}
