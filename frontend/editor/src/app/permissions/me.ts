import {
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  Injector,
  type Provider,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  API_UNAUTHORIZED,
  ApiClient,
  ApiError,
  toApiError,
  type Schema,
} from '../api';
import { readStored, writeStored } from '../session/stored';
import { UNCONFIRMED, isUnconfirmed } from './unconfirmed';

/**
 * Where a tab marks that the person it confirmed changed (a sign-in), for the other tabs: the
 * session cookie is shared, so they read `/me` again (#716). It holds a counter, never who.
 */
const SIGNED_IN = 'openfolia.signed-in';
export { UNCONFIRMED, isUnconfirmed } from './unconfirmed';

/** A permission the API knows (`GET /me`, `Role.permissions`): the generated type keeps this list true. */
export type ApiPermission = Schema<'Role'>['permissions'][number];

/**
 * Who `GET /me` names: a `user` (a person), the token's read-only `service` (nobody signed in),
 * or `nobody` (not known yet: `NOBODY`).
 */
export type MeKind = 'user' | 'service' | 'nobody';

/** The acting person as the shell needs it. */
export interface Me {
  /** The user's ID (or `service:api-token`): what a screen keys its data on, to follow a switch. */
  readonly id: string;
  readonly kind: MeKind;
  readonly name: string;
  /** The role names, shown under the name. */
  readonly role: string;
  /** Permission keys the role grants anywhere (`content.read`, `admin.roles`, ...). */
  readonly permissions: ReadonlySet<string>;
  /**
   * `content.read.draft` and `content.edit`, each in a role whose scope restricts nothing (no
   * languages, module types, audience or facets): what finding and deleting unused files needs, as
   * the API decides it (and checks again). A contributor (no drafts) has it not.
   * Absent: not known, taken as no.
   */
  readonly editsEverything?: boolean;
  /**
   * The permissions held in a role whose scope restricts nothing: what webhooks judge a manager
   * by (#254: who may reshape or rotate another's subscriber), as the API decides it (and checks
   * again). Absent: not known, taken as none.
   */
  readonly unrestricted?: ReadonlySet<string>;
  /**
   * The languages translations may be managed into (`translation.manage`): those of every role
   * holding it, `'all'` when one of them restricts no language, as the API decides what an export
   * may name. Absent: not known, taken as all (the API checks again).
   */
  readonly managedLanguages?: ReadonlySet<string> | 'all';
  /**
   * The signed-in session the request acts through (#37): the account menu offers signing out.
   * Absent: none (the token's service, demo mode, a test).
   */
  readonly session?: { readonly provider: string; readonly expiresAt: string };
}

/** Every permission the API knows; tests give a person all of them. */
export const ALL_PERMISSIONS = [
  'content.read',
  'content.read.draft',
  'content.edit',
  'content.review',
  'content.approve',
  'release.publish',
  'translation.manage',
  'webhook.manage',
  'admin.roles',
  'admin.branding',
  'admin.backups',
  'scim.provision',
] as const satisfies readonly ApiPermission[];

/** Nobody: what the shell holds until `GET /me` answers, and when it cannot. Grants nothing. */
export const NOBODY: Me = {
  id: '',
  kind: 'nobody',
  name: '',
  role: '',
  permissions: new Set(),
};

export type MeStatus = 'loading' | 'ready' | 'error';

/**
 * Whether a person is acting, as the routes and the shell need it:
 * - `pending`: `GET /me` has not answered yet;
 * - `person`: a user is acting;
 * - `nobody`: nobody is signed in: `/me` names the token's service, or refused the identity
 *   (401, 403): the sign-in page;
 * - `failed`: `/me` could not be read (network, busy): the shell shows the failure with a retry.
 */
export type Presence = 'pending' | 'person' | 'nobody' | 'failed';

/** What finding and deleting unused files needs, each in a role whose scope restricts nothing. */
const UNUSED_FILES: readonly ApiPermission[] = [
  'content.read.draft',
  'content.edit',
];

/** 16 random bytes as hex (also outside a secure context, where `randomUUID` is missing). */
function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `GET /me` document as `Me`. */
export function toMe(doc: Schema<'ActorDocument'>): Me {
  const { id, attributes, meta } = doc.data;
  return {
    id,
    kind: attributes.kind,
    name: attributes.name,
    role: attributes.roles.map((role) => role.name).join(', '),
    permissions: new Set(meta.permissions.map((p) => p.permission)),
    editsEverything: UNUSED_FILES.every((key) =>
      attributes.roles.some(
        (role) =>
          role.permissions.includes(key) &&
          Object.values(role.scope).every((value) => value === undefined),
      ),
    ),
    unrestricted: new Set(
      attributes.roles
        .filter((role) =>
          Object.values(role.scope).every((value) => value === undefined),
        )
        .flatMap((role) => role.permissions),
    ),
    managedLanguages: managedLanguages(attributes.roles),
    ...(meta.session && {
      session: {
        provider: meta.session.provider,
        expiresAt: meta.session.expiresAt,
      },
    }),
  };
}

/** The languages of the roles holding `translation.manage`; `'all'` when one restricts none. */
function managedLanguages(
  roles: Schema<'ActorDocument'>['data']['attributes']['roles'],
): ReadonlySet<string> | 'all' {
  const languages = new Set<string>();
  for (const role of roles) {
    if (!role.permissions.includes('translation.manage')) continue;
    if (role.scope.languages === undefined) return 'all';
    for (const lang of role.scope.languages) languages.add(lang);
  }
  return languages;
}

/**
 * The current person, from `GET /me`: what the shell hides or disables follows its permissions.
 * Until the API has answered (and when it cannot) nobody holds any permission: the shell never
 * offers more than the API allows. A switch of the demo user (`DemoSession`) shows the new name
 * at once (`show`) and keeps the old permissions until `refresh` has the new ones, or puts the
 * old person back (`restore`) when the API refuses. A sign-in in another tab changes the session
 * cookie this tab sends too: that tab says so (local storage), and this one reads `/me` again, so
 * its caches follow the person the API now answers for (#716).
 */
@Injectable({ providedIn: 'root' })
export class MeService {
  private readonly api = inject(ApiClient);
  private readonly state = signal<Me>(NOBODY);
  private readonly loadStatus = signal<MeStatus>('loading');
  private readonly loadError = signal<ApiError | null>(null);
  private sequence = 0;
  private checking = false;
  private confirmedMe: Me = NOBODY;
  /**
   * A read of `/me` for another tab's sign-in is on its way (another was told meanwhile): the
   * cookie this tab sends may be someone else's, so until it answers `me().id` is a placeholder
   * no person has (`UNCONFIRMED`): what is read meanwhile is kept for nobody (#716).
   */
  private following = false;
  private followAgain = false;

  constructor() {
    const view = inject(DOCUMENT).defaultView;
    if (!view) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIGNED_IN) this.otherTabSignedIn();
    };
    view.addEventListener('storage', onStorage);
    inject(DestroyRef).onDestroy(() =>
      view.removeEventListener('storage', onStorage),
    );
  }

  /**
   * Another tab signed someone in: this tab acts through the same cookie, so `/me` is read again
   * (quietly: a failure leaves the person as they were, and the next refused call ends them).
   * Only for a tab acting through a session: a demo user or the token sends no cookie.
   */
  private otherTabSignedIn(): void {
    if (!this.state().session) return;
    // One read at a time; a sign-in told meanwhile reads once more after it, as the read on its
    // way may have been sent with the cookie before. Apart from `sessionRefused`'s check.
    if (this.following) {
      this.followAgain = true;
      return;
    }
    this.following = true;
    // Until `/me` answers, nobody's: the reads sent now carry the other tab's cookie.
    this.state.update((me) => ({
      ...me,
      // Unique to this wait, so nothing stored under one ever matches another.
      id: `${UNCONFIRMED}${randomHex()}`,
    }));
    const before = this.sequence;
    void this.read(true, false)
      .catch((error: unknown) => {
        // Not known who acts here now: the failure is shown (with its retry), never the person
        // before. A later read or `set` has the last word.
        if (this.sequence === before + 1) {
          const failure = toApiError(error);
          this.loadError.set(failure);
          this.loadStatus.set('error');
          if (failure.kind === 'unauthorized') {
            this.state.set(NOBODY);
            this.confirmedMe = NOBODY;
          }
        }
      })
      .finally(() => {
        this.following = false;
        // Overtaken by a read that failed too (a refused call's check): still nobody known here.
        if (
          !this.followAgain &&
          isUnconfirmed(this.state().id) &&
          this.loadStatus() === 'ready'
        ) {
          // Not quiet: a failure shows, with its retry. Told nobody: this follows another tab.
          void this.read(false, false).catch(() => undefined);
        }
        if (this.followAgain) {
          this.followAgain = false;
          this.otherTabSignedIn();
        }
      });
  }

  /** The person confirmed through a session changed: the other tabs read `/me` again. */
  private announce(before: string): void {
    if (!this.confirmedMe.session || this.confirmedMe.id === before) return;
    const count = Number(readStored(SIGNED_IN) ?? '0');
    writeStored(SIGNED_IN, String(Number.isFinite(count) ? count + 1 : 1));
  }

  readonly me = this.state.asReadonly();
  readonly status = this.loadStatus.asReadonly();
  /** Why the last `refresh` failed; null while it has not. */
  readonly error = this.loadError.asReadonly();
  /** Whether a person is acting (`Presence`): only a confirmed `user` is one. */
  readonly presence = computed((): Presence => {
    switch (this.loadStatus()) {
      case 'loading':
        return 'pending';
      case 'ready':
        return this.state().kind === 'user' ? 'person' : 'nobody';
      case 'error':
        return this.loadError()?.kind === 'unauthorized' ? 'nobody' : 'failed';
    }
  });

  /**
   * An API call was refused 401: when the person acts through a signed-in session (#37), it may
   * have ended, so `/me` is read again (its 401 makes `presence` nobody, and the shell goes to the
   * sign-in page). Once at a time; outside a session nothing happens.
   */
  sessionRefused(): void {
    if (!this.state().session || this.checking) return;
    this.checking = true;
    const before = this.sequence;
    void this.refresh(true)
      .catch((error: unknown) => {
        // Only a refusal ends the person here; a failed read leaves them as they were, and a
        // later read or `set` (its own `sequence`) has the last word.
        if (
          error instanceof ApiError &&
          error.kind === 'unauthorized' &&
          this.sequence === before + 1
        ) {
          this.sequence++;
          this.loadError.set(error);
          this.loadStatus.set('error');
          this.state.set(NOBODY);
          this.confirmedMe = NOBODY;
        }
      })
      .finally(() => (this.checking = false));
  }

  /** Sets the person (a test, or a restore), ready. */
  set(me: Me): void {
    this.sequence++;
    this.confirmedMe = me;
    this.state.set(me);
    this.loadError.set(null);
    this.loadStatus.set('ready');
  }

  /** The next person's name and roles, before the API has confirmed them; permissions stay. */
  show(change: Pick<Me, 'id' | 'name' | 'role'>): void {
    this.state.update((me) => ({ ...me, ...change }));
  }

  /** The last person the API confirmed (or `set`): what a refused switch goes back to. */
  get confirmed(): Me {
    return this.confirmedMe;
  }

  /** Puts the last confirmed person back, e.g. after a refused switch. */
  restoreConfirmed(): void {
    this.set(this.confirmedMe);
  }

  /**
   * Reads `GET /me` for the identity the next request carries. Resolves true when it set the
   * person, false when a later `refresh` or `set` made this answer stale (the latest wins);
   * rejects with an `ApiError` when it failed (`status` is then `error` if still the latest,
   * unless `quiet`: a switch reports its own failure and puts the previous person back).
   */
  refresh(quiet = false): Promise<boolean> {
    return this.read(quiet, true);
  }

  /** `refresh`; a read following another tab's sign-in tells no tab (they heard it themselves). */
  private async read(quiet: boolean, tell: boolean): Promise<boolean> {
    const mine = ++this.sequence;
    if (!quiet) this.loadStatus.set('loading');
    this.loadError.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/me'));
      if (mine !== this.sequence) return false;
      const before = this.confirmedMe.id;
      this.confirmedMe = toMe(doc);
      this.state.set(this.confirmedMe);
      this.loadStatus.set('ready');
      if (tell) this.announce(before);
      return true;
    } catch (error) {
      const failure = toApiError(error);
      if (mine === this.sequence && !quiet) {
        this.loadError.set(failure);
        this.loadStatus.set('error');
      }
      throw failure;
    }
  }
}

/** A refused API call reads `/me` again when a signed-in session may have ended (#37). */
export function provideSessionEnd(): Provider {
  return {
    provide: API_UNAUTHORIZED,
    useFactory: () => {
      const injector = inject(Injector);
      return () => injector.get(MeService).sessionRefused();
    },
  };
}
