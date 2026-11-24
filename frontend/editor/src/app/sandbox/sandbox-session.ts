import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { LanguageService } from '@openfolia/ui/i18n';

import { ApiClient, toApiError, type Schema } from '../api';

type Resource = Schema<'SandboxResource'>;

/** The caps of a public sandbox (`CCMS_SANDBOX_*`): past one, 422 `sandbox-limit-reached`. */
export type SandboxLimits = Resource['attributes']['limits'];

/** What `GET /sandbox` says about this sandbox. */
export interface SandboxInfo {
  readonly limits: SandboxLimits;
  readonly idleMinutes: number;
  readonly maxMinutes: number;
  readonly used: Resource['meta']['used'];
  /** The shared reader portal's address (https), when the operator set one (#837). */
  readonly portalUrl: string | null;
  /** Where "End demo" posts (#846): the launcher's route; null when the operator set none. */
  readonly endUrl: string | null;
  readonly startedAt: Date;
  /**
   * When the session ends, in the browser's clock: the server's `endsAt` (the last request plus
   * the idle minutes, at most start plus max) moved by how far the two clocks differ.
   */
  readonly endsAt: Date;
}

/**
 * Whether the API is a public sandbox (#826), as the client learns it:
 * - `checking`: not answered yet;
 * - `on`: `GET /sandbox` answered;
 * - `off`: it answered 404 (a normal instance), or could not be asked yet (asked again later).
 */
export type SandboxStatus = 'checking' | 'on' | 'off';

/** How often the session's end is read again: every request moves it, so it is kept fresh. */
export const SANDBOX_REFRESH_MS = 60_000;
/** How often the time left is counted down between reads. */
const TICK_MS = 5_000;

/** The clock the time left is counted against (a test sets its own). */
export const SANDBOX_CLOCK = new InjectionToken<() => number>('SANDBOX_CLOCK', {
  providedIn: 'root',
  factory: () => () => Date.now(),
});

/** Goes to another page, leaving the editor (a test sets its own). */
export const SANDBOX_NAVIGATE = new InjectionToken<(url: string) => void>(
  'SANDBOX_NAVIGATE',
  {
    providedIn: 'root',
    factory: () => {
      const location = inject(DOCUMENT).location;
      return (url) => location.assign(url);
    },
  },
);

/**
 * The resource, its times in the browser's clock: `skew` is how far the server's clock is ahead
 * (its `Date` header against the browser's at the answer; 0 without one), so a device whose clock
 * is off still counts the right time left.
 */
const toInfo = (resource: Resource, skew: number): SandboxInfo => ({
  limits: resource.attributes.limits,
  idleMinutes: resource.attributes.idleMinutes,
  maxMinutes: resource.attributes.maxMinutes,
  used: resource.meta.used,
  portalUrl: resource.attributes.portalUrl ?? null,
  endUrl: resource.attributes.endUrl ?? null,
  startedAt: new Date(Date.parse(resource.meta.startedAt) - skew),
  endsAt: new Date(Date.parse(resource.meta.endsAt) - skew),
});

/** How far the server's clock is ahead of `now`, by its `Date` header (whole seconds). */
const skewOf = (date: string | null, now: number): number => {
  const server = date ? Date.parse(date) : NaN;
  return Number.isFinite(server) ? server - now : 0;
};

/**
 * The public sandbox mode (#826): read once before the first screen renders (`start()`, in the
 * app's initializer), so its banner is there at first paint and nothing moves. Off is a normal
 * instance: no banner and every control as always. On, the banner shows the time left, counted
 * down here and read again every minute (the API moves the end with every request, but not with
 * this read), and the screens hide what a sandbox refuses (uploads, imports, …).
 *
 * The UI only follows what the API enforces: a refused call still answers 403
 * `sandbox-not-allowed`.
 */
@Injectable({ providedIn: 'root' })
export class SandboxSession {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);
  private readonly clock = inject(SANDBOX_CLOCK);
  private readonly navigate = inject(SANDBOX_NAVIGATE);
  private readonly language = inject(LanguageService);
  private readonly document = inject(DOCUMENT);

  private readonly state = signal<SandboxStatus>('checking');
  private readonly value = signal<SandboxInfo | null>(null);
  private readonly now = signal(this.clock());
  /** The launcher answered that this browser's sandbox is gone (404): it has ended, whatever the clock says. */
  private readonly gone = signal(false);
  private refresh: ReturnType<typeof setInterval> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  readonly status = this.state.asReadonly();
  readonly info = this.value.asReadonly();
  /** True in a public sandbox: the screens leave out what it refuses. */
  readonly on = computed(() => this.state() === 'on');
  /** Whole minutes left, rounded up (0 once it ended); null when off. */
  readonly minutesLeft = computed(() => {
    const info = this.value();
    if (!this.on() || info === null) return null;
    if (this.gone()) return 0;
    const left = info.endsAt.getTime() - this.now();
    return left <= 0 ? 0 : Math.ceil(left / 60_000);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Asks `GET /sandbox`. Never rejects: a failure is off, asked again a minute later. */
  async start(): Promise<void> {
    await this.read();
    // Asked again in a minute: on, for the end; unanswered, in case it is one after all. A
    // normal instance (404) is not asked again.
    if (this.refresh === null && (this.on() || this.state() === 'checking')) {
      this.refresh = setInterval(() => void this.read(), SANDBOX_REFRESH_MS);
    }
    if (this.state() === 'checking') this.state.set('off');
  }

  private async read(): Promise<void> {
    try {
      const response = await firstValueFrom(this.api.getResponse('/sandbox'));
      const now = this.clock();
      const document = response.body;
      if (!document) throw new Error('GET /sandbox answered without a body');
      // `Date` has whole seconds: a skew under a few seconds is that rounding, not the clock.
      const skew = skewOf(response.headers.get('Date'), now);
      this.value.set(toInfo(document.data, Math.abs(skew) < 5_000 ? 0 : skew));
      this.state.set('on');
      // Answered after all: a 404 between was a moment (a restart), or another tab's new sandbox.
      this.gone.set(false);
      this.now.set(this.clock());
      this.tick ??= setInterval(() => this.now.set(this.clock()), TICK_MS);
    } catch (error) {
      const failure = toApiError(error);
      // Once on, a 404 is the launcher's: the sandbox has gone (removed on its time, or a restart).
      if (this.state() === 'on' && failure.status === 404) {
        this.gone.set(true);
        return;
      }
      // An answer that is not the sandbox (404 on a normal instance) settles it.
      if (failure.kind !== 'network' && failure.kind !== 'unavailable') {
        if (this.state() !== 'on') {
          this.state.set('off');
          this.stop();
        }
      }
    }
  }

  /**
   * Ends the sandbox (#846): posts the editor's language to `endUrl` (the launcher's route, which
   * removes this browser's sandbox and clears its cookie) and goes to the page its answer names,
   * the launcher's "thanks" dialog. Rejects when it could not; then nothing has changed here. Only
   * a `next` on the end address's own origin is followed; any other goes to that origin's start
   * page, and none (404: this browser has no sandbox any more) to its "it expired" dialog.
   */
  async end(): Promise<void> {
    const endpoint = this.endpoint();
    let answer: { next?: unknown };
    try {
      answer = await firstValueFrom(
        this.http.post<{ next?: unknown }>(endpoint.href, {
          lang: this.language.locale(),
        }),
      );
    } catch (error) {
      if (!(error instanceof HttpErrorResponse && error.status === 404)) {
        throw error;
      }
      return this.leave();
    }
    let target = new URL('/', endpoint);
    if (typeof answer.next === 'string') {
      const next = new URL(answer.next, endpoint);
      if (next.origin === endpoint.origin) target = next;
    }
    this.stop();
    this.navigate(target.href);
  }

  /**
   * The session has run out: to the launcher's start page and its "it expired" dialog. Ends
   * nothing: the launcher has removed it already, and should this browser have a running sandbox
   * after all (one started in another tab), that address opens it instead.
   */
  leave(): void {
    const target = new URL('/', this.endpoint());
    target.search = new URLSearchParams({
      ended: 'expired',
      lang: this.language.locale(),
    }).toString();
    this.stop();
    this.navigate(target.href);
  }

  private endpoint(): URL {
    const endUrl = this.value()?.endUrl;
    if (!endUrl) throw new Error('This sandbox has no end address.');
    return new URL(endUrl, this.document.baseURI);
  }

  private stop(): void {
    if (this.refresh !== null) clearInterval(this.refresh);
    if (this.tick !== null) clearInterval(this.tick);
    this.refresh = null;
    this.tick = null;
  }
}
