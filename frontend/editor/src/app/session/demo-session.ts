import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ToastService, translated } from '@openfolia/ui/startup';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Item,
} from '../api';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from './change-set-session';
import { injectFailureText } from './failure-text';
import { readStored, writeStored } from './stored';

const STORAGE_KEY = 'openfolia.demo-user';
/** The API's largest page: the demo's users fit in one, and more are read page by page. */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/** A seeded user the presenter can act as. */
export interface DemoUser {
  readonly id: string;
  readonly name: string;
  /** The IDs of the roles the user holds (their names come with `GET /me` once chosen). */
  readonly roleIds: readonly string[];
  /** What those roles hold, in any scope (the API's `meta.permissions`). */
  readonly permissions: ReadonlySet<string>;
}

/**
 * Whether the API is in demo mode, as the client learns it:
 * - `checking`: not asked yet;
 * - `on`: `GET /demo/users` answered;
 * - `off`: it did not (404 outside demo mode): there is no switcher and no header is sent;
 * - `failed`: it could not be asked (the API busy or unreachable): the switcher shows the
 *   failure with a retry, since this may be a demo.
 */
export type DemoStatus = 'checking' | 'on' | 'off' | 'failed';

const toUser = (item: Item<'/demo/users'>): DemoUser => ({
  id: item.id,
  name: item.attributes.name,
  roleIds: item.relationships.roles.data.map((role) => role.id),
  permissions: new Set(item.meta.permissions),
});

/**
 * The demo identity: which seeded user the presenter acts as. The API accepts
 * `X-Ccms-User` only in demo mode, so everything here hangs on `GET /demo/users` answering: until
 * then (and when it never does) no header is sent and no switcher is shown, so a production
 * build against a production API has no trace of it.
 *
 * Switching is eager: the name, the checkmark and the header change at once, the permissions
 * follow when `GET /me` answers, and a refusal puts the previous user back with a toast offering
 * a retry. The choice survives a reload (local storage).
 */
@Injectable({ providedIn: 'root' })
export class DemoSession {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  private readonly state = signal<DemoStatus>('checking');
  private readonly failed = signal<ApiError | null>(null);
  private readonly list = signal<readonly DemoUser[]>([]);
  private readonly current = signal<string | null>(readStored(STORAGE_KEY));
  private readonly busy = signal(false);

  readonly status = this.state.asReadonly();
  /** Why `status` is `failed`. */
  readonly failure = this.failed.asReadonly();
  readonly users = this.list.asReadonly();
  /** True while the users are being read (again). */
  readonly loading = this.busy.asReadonly();
  /** The user chosen, or null: the token's own read-only service. */
  readonly userId = this.current.asReadonly();
  /** Whether the account menu offers the switcher. */
  readonly enabled = computed(
    () => this.state() === 'on' || this.state() === 'failed',
  );
  /** What `X-Ccms-User` carries: the chosen user, only while the API is known to be in demo mode. */
  readonly actingAs = computed(() =>
    this.state() === 'on' ? this.current() : null,
  );

  /**
   * Start-up: asks whether this is demo mode, then reads who is acting and which change sets
   * they have. Never rejects: a failure is a state of what it was reading.
   */
  async start(): Promise<void> {
    await this.probe();
    await this.reload();
  }

  /** Reads who is acting and their change sets, for the identity the next request carries. */
  async reload(): Promise<void> {
    // Nobody is confirmed while a switch is unanswered: its own answer reads them.
    if (this.changeSets.switching()) return;
    await Promise.all([
      this.me.refresh().catch(() => undefined),
      this.changeSets.refresh(),
    ]);
  }

  /** Asks `GET /demo/users`; also the retry of a failed ask. */
  async probe(): Promise<void> {
    this.busy.set(true);
    this.failed.set(null);
    try {
      const users = await this.loadUsers();
      this.list.set(users);
      this.state.set('on');
      // An identity that is no longer seeded is forgotten rather than sent.
      const stored = this.current();
      if (stored !== null && !users.some((user) => user.id === stored)) {
        this.setCurrent(null);
      }
    } catch (error) {
      const failure = toApiError(error);
      // Only "it could not be asked" is a failure to show; any answer that is not the list
      // (404 outside demo mode, a refused token) means there is no demo to switch in.
      if (failure.kind === 'network' || failure.kind === 'unavailable') {
        this.failed.set(failure);
        this.state.set('failed');
      } else {
        this.state.set('off');
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** The retry of a failed ask in the menu: asks again, then reads who is acting. */
  async retry(): Promise<void> {
    await this.probe();
    if (this.state() === 'on') await this.reload();
  }

  /**
   * Acts as another user: at once, then confirmed by `GET /me`. A refusal restores the previous
   * user and offers the same switch again in a toast. Only the latest choice counts.
   */
  async switchTo(id: string): Promise<void> {
    if (this.state() !== 'on' || id === this.current()) return;
    const user = this.list().find((candidate) => candidate.id === id);
    if (!user) return;
    this.changeSets.beginSwitch();
    this.setCurrent(id);
    this.me.show({ id, name: user.name, role: user.roleIds.join(', ') });
    try {
      // Overtaken (by a later switch): this one is unanswered, the later one answers for both.
      if (!(await this.me.refresh(true))) return;
    } catch (error) {
      // Another choice came meanwhile: it has its own answer to wait for.
      if (this.current() !== id) return;
      // Back to the last person the API confirmed, not to a switch still unanswered.
      const confirmed = this.me.confirmed.id;
      this.setCurrent(
        this.list().some((candidate) => candidate.id === confirmed)
          ? confirmed
          : null,
      );
      this.me.restoreConfirmed();
      void this.changeSets.endSwitch(true);
      // Nothing was confirmed yet (the first read was cut short): ask again.
      if (!this.me.confirmed.id) void this.me.refresh().catch(() => undefined);
      this.toast.error(
        this.failureText(
          translated('editor.demo.switchFailed', { name: user.name }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => void this.switchTo(id),
        },
      );
      return;
    }
    if (this.current() !== id) return;
    await this.changeSets.endSwitch(false);
  }

  /**
   * The sign-in page's choice: acts as a seeded user (`switchTo`, or reads `/me` again when that
   * user is already chosen but not confirmed). Resolves true once the API confirmed that user is
   * acting; false otherwise (not demo mode, not seeded, refused: `switchTo` has shown why).
   */
  async signIn(id: string): Promise<boolean> {
    if (this.state() !== 'on' || !this.list().some((user) => user.id === id)) {
      return false;
    }
    if (this.current() === id) await this.reload();
    else await this.switchTo(id);
    const me = this.me.me();
    return (
      this.current() === id &&
      this.me.presence() === 'person' &&
      this.me.confirmed.id === id &&
      me.id === id
    );
  }

  private setCurrent(id: string | null): void {
    this.current.set(id);
    writeStored(STORAGE_KEY, id);
  }

  private async loadUsers(): Promise<DemoUser[]> {
    const users: DemoUser[] = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const page = await firstValueFrom(
        this.api.get('/demo/users', {
          query: pageQuery({ number, size: PAGE_SIZE }),
        }),
      );
      users.push(...page.data.map(toUser));
      if (number >= page.meta.page.lastPage) break;
    }
    return users;
  }
}
