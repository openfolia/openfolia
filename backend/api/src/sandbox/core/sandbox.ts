import { ForbiddenError, UnprocessableError } from '../../base/core/errors.js';

/**
 * The caps of a public sandbox (#826, `CCMS_SANDBOX_*`): what one visitor may make, so nothing
 * grows without bound. They apply only while the sandbox is on.
 */
export interface SandboxLimits {
  /** The largest working copy (a module, a manual, a setting, a design), in bytes of its JSON. */
  readonly moduleBytes: number;
  /** The longest comment, in characters. */
  readonly commentLength: number;
  /** The most change sets (revisions) made. */
  readonly changeSets: number;
  /** The most modules made (a module, or a module's language, that had no file). */
  readonly modules: number;
  /** The most manuals made. */
  readonly manuals: number;
  /** The most releases cut in any hour. */
  readonly releasesPerHour: number;
  /** The most PDFs rendered at once (the PDF workers). */
  readonly renderJobs: number;
  /**
   * The most bytes written over the sandbox's life: every working copy saved (any kind, the
   * same one again included), every comment written or edited, every commit (whichever action
   * makes it) and every file stored in the blob store. It bounds the database, Git and the disk.
   */
  readonly writeBytes: number;
}

/** What a sandbox counts against its caps. */
export type SandboxCounted = 'change-sets' | 'modules' | 'manuals' | 'releases';

/** What a sandbox refuses outright, each with its own sentence. */
export type SandboxRefusal =
  | 'users'
  | 'service-accounts'
  | 'tokens'
  | 'invitations'
  | 'uploads'
  | 'imports'
  | 'templates'
  | 'webhooks'
  | 'mail'
  | 'backups';

const REFUSALS: Record<SandboxRefusal, string> = {
  users: 'Adding users is off in a public sandbox: it is yours alone.',
  'service-accounts':
    'Service accounts are off in a public sandbox: nothing outside it may reach it.',
  tokens:
    'Issuing tokens is off in a public sandbox: nothing outside it may reach it.',
  invitations:
    'Invitations and sign-in links are off in a public sandbox: it is yours alone.',
  uploads:
    'Uploads are off in a public sandbox: pick an image from the media library.',
  imports: 'Imports are off in a public sandbox.',
  templates: 'Changing a page design’s template is off in a public sandbox.',
  webhooks: 'Webhooks are off in a public sandbox: nothing leaves it.',
  mail: 'Email is off in a public sandbox: nothing leaves it.',
  backups:
    'Backups are off in a public sandbox: it is deleted after the session.',
};

const COUNTED: Record<SandboxCounted, keyof SandboxLimits> = {
  'change-sets': 'changeSets',
  modules: 'modules',
  manuals: 'manuals',
  releases: 'releasesPerHour',
};

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** 403 `sandbox-not-allowed`: what a public sandbox never does (`meta.refused` says what). */
export class SandboxNotAllowedError extends ForbiddenError {
  override readonly code = 'sandbox-not-allowed';

  constructor(readonly refused: SandboxRefusal) {
    super(REFUSALS[refused], { refused });
  }
}

/**
 * 422 `sandbox-limit-reached`: past one of the sandbox's caps. `meta.limit` names the cap
 * (`SandboxLimits`' key), `meta.max` its value.
 */
export const sandboxLimitReached = (
  limit: keyof SandboxLimits,
  max: number,
  detail: string,
): UnprocessableError =>
  new UnprocessableError('sandbox-limit-reached', detail, { limit, max });

/** How long a sandbox lives (`CCMS_SANDBOX_IDLE_MINUTES`, `CCMS_SANDBOX_MAX_MINUTES`). */
export interface SandboxLifetime {
  /** It ends this many minutes after the last request that did something. */
  readonly idleMinutes: number;
  /** It ends this many minutes after it started, however busy. */
  readonly maxMinutes: number;
}

export interface SandboxOptions {
  readonly limits: SandboxLimits;
  readonly lifetime: SandboxLifetime;
  /** The shared reader portal's address (https), which the editor's banner links (#837). */
  readonly portalUrl?: string;
  /** Where the banner ends the sandbox (a same-origin path or https), for "End demo" (#846). */
  readonly endUrl?: string;
  /** The time now, in ms (tests set it). */
  readonly now?: () => number;
}

/** What `GET /sandbox` tells: the caps, what is used of them, and when the sandbox ends. */
export interface SandboxStatus {
  readonly limits: SandboxLimits;
  readonly used: Readonly<Record<SandboxCounted, number>>;
  /** The bytes written of `limits.writeBytes`. */
  readonly writtenBytes: number;
  readonly lifetime: SandboxLifetime;
  /** The reader portal's address, when one is set. */
  readonly portalUrl?: string;
  /** Where the banner ends the sandbox, when one is set. */
  readonly endUrl?: string;
  readonly startedAt: Date;
  /** The earlier of the idle end and the hard end. */
  readonly endsAt: Date;
}

/**
 * The public sandbox (#826, `CCMS_PUBLIC_SANDBOX=on`): a mode in which a stranger may use the
 * instance without harm to anyone else. Actions ask it before what a sandbox never does
 * (`refuse`: 403 `sandbox-not-allowed`) and around what it counts (`counted`, `checkBytes`,
 * `checkCommentLength`: 422 `sandbox-limit-reached`). Off (`Sandbox.OFF`), every check passes.
 *
 * The counts are this server's, in memory: a sandbox is one process for one visitor's session,
 * thrown away with everything in it, so they never need to outlive it.
 */
export class Sandbox {
  /** No sandbox: nothing is refused or counted. */
  static readonly OFF = new Sandbox(false);

  readonly limits: SandboxLimits | undefined;
  readonly lifetime: SandboxLifetime | undefined;
  private readonly portalUrl: string | undefined;
  private readonly endUrl: string | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;
  private lastActive: number;
  private readonly made: Record<Exclude<SandboxCounted, 'releases'>, number> = {
    'change-sets': 0,
    modules: 0,
    manuals: 0,
  };
  /** Running ones count too, so two at once never both pass the cap. */
  private readonly pending: Record<SandboxCounted, number> = {
    'change-sets': 0,
    modules: 0,
    manuals: 0,
    releases: 0,
  };
  private releases: number[] = [];
  private written = 0;

  private constructor(
    readonly on: boolean,
    options?: SandboxOptions,
  ) {
    this.limits = options?.limits;
    this.lifetime = options?.lifetime;
    this.portalUrl = options?.portalUrl;
    this.endUrl = options?.endUrl;
    this.now = options?.now ?? Date.now;
    this.startedAt = this.now();
    this.lastActive = this.startedAt;
  }

  /** A sandbox that is on, with its caps and lifetime. */
  static on(options: SandboxOptions): Sandbox {
    return new Sandbox(true, options);
  }

  /** Throws 403 `sandbox-not-allowed` while the sandbox is on. */
  refuse(what: SandboxRefusal): void {
    if (this.on) throw new SandboxNotAllowedError(what);
  }

  /**
   * Runs `make` when one more of `kind` fits under its cap, and counts it once `make` has
   * succeeded (one that fails counts nothing); else 422 `sandbox-limit-reached` without
   * running it. Releases count over the last hour, the rest over the sandbox's life.
   */
  async counted<T>(kind: SandboxCounted, make: () => Promise<T>): Promise<T> {
    const limits = this.limits;
    if (!this.on || limits === undefined) return make();
    const limit = COUNTED[kind];
    const max = limits[limit];
    if (this.count(kind) + this.pending[kind] >= max) {
      throw sandboxLimitReached(limit, max, LIMIT_DETAIL[kind](max));
    }
    this.pending[kind] += 1;
    try {
      const made = await make();
      if (kind === 'releases') this.releases.push(this.now());
      else this.made[kind] += 1;
      return made;
    } finally {
      this.pending[kind] -= 1;
    }
  }

  /** Throws 422 `sandbox-limit-reached` for a working copy past `moduleBytes`. */
  checkBytes(bytes: number): void {
    const max = this.limits?.moduleBytes;
    if (!this.on || max === undefined || bytes <= max) return;
    throw sandboxLimitReached(
      'moduleBytes',
      max,
      `In a public sandbox a module (or another working copy) holds at most ${max} bytes.`,
    );
  }

  /**
   * Throws 422 `sandbox-limit-reached` for a comment past `commentLength` characters, and
   * spends its bytes (`spend`).
   */
  checkCommentLength(body: string): void {
    const max = this.limits?.commentLength;
    if (!this.on || max === undefined) return;
    if ([...body].length > max) {
      throw sandboxLimitReached(
        'commentLength',
        max,
        `In a public sandbox a comment holds at most ${max} characters.`,
      );
    }
    this.spend(new TextEncoder().encode(body).length);
  }

  /**
   * Counts `bytes` about to be written against `writeBytes`, or throws 422
   * `sandbox-limit-reached` when they do not fit (counting nothing). Counted when offered, so
   * a write that then fails counts too: never more written than the budget, at once or not.
   */
  spend(bytes: number): void {
    const max = this.limits?.writeBytes;
    if (!this.on || max === undefined) return;
    if (this.written + bytes > max) {
      throw sandboxLimitReached(
        'writeBytes',
        max,
        `A public sandbox writes at most ${max} bytes over its session.`,
      );
    }
    this.written += bytes;
  }

  /** Notes a request that did something: the idle end moves on. */
  touch(): void {
    this.lastActive = this.now();
  }

  /** The caps, what is used and when it ends; undefined while off. */
  status(): SandboxStatus | undefined {
    const { limits, lifetime } = this;
    if (!this.on || limits === undefined || lifetime === undefined) {
      return undefined;
    }
    const idleEnd = this.lastActive + lifetime.idleMinutes * MINUTE_MS;
    const hardEnd = this.startedAt + lifetime.maxMinutes * MINUTE_MS;
    return {
      limits,
      used: {
        'change-sets': this.made['change-sets'],
        modules: this.made.modules,
        manuals: this.made.manuals,
        releases: this.count('releases'),
      },
      writtenBytes: this.written,
      lifetime,
      ...(this.portalUrl === undefined ? {} : { portalUrl: this.portalUrl }),
      ...(this.endUrl === undefined ? {} : { endUrl: this.endUrl }),
      startedAt: new Date(this.startedAt),
      endsAt: new Date(Math.min(idleEnd, hardEnd)),
    };
  }

  private count(kind: SandboxCounted): number {
    if (kind !== 'releases') return this.made[kind];
    const since = this.now() - HOUR_MS;
    this.releases = this.releases.filter((at) => at > since);
    return this.releases.length;
  }
}

const LIMIT_DETAIL: Record<SandboxCounted, (max: number) => string> = {
  'change-sets': (max) =>
    `A public sandbox makes at most ${max} revisions (change sets).`,
  modules: (max) => `A public sandbox makes at most ${max} modules.`,
  manuals: (max) => `A public sandbox makes at most ${max} manuals.`,
  releases: (max) => `A public sandbox cuts at most ${max} releases an hour.`,
};
