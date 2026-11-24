import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
  private readonly clock = inject(SANDBOX_CLOCK);

  private readonly state = signal<SandboxStatus>('checking');
  private readonly value = signal<SandboxInfo | null>(null);
  private readonly now = signal(this.clock());
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
      this.now.set(this.clock());
      this.tick ??= setInterval(() => this.now.set(this.clock()), TICK_MS);
    } catch (error) {
      const failure = toApiError(error);
      // An answer that is not the sandbox (404 on a normal instance) settles it.
      if (failure.kind !== 'network' && failure.kind !== 'unavailable') {
        if (this.state() !== 'on') {
          this.state.set('off');
          this.stop();
        }
      }
    }
  }

  private stop(): void {
    if (this.refresh !== null) clearInterval(this.refresh);
    if (this.tick !== null) clearInterval(this.tick);
    this.refresh = null;
    this.tick = null;
  }
}
