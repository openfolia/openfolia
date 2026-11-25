import { ToolError } from './api-client.js';
import type { McpContext } from './server.js';

/** A service account's API token, as the API issues them: `ccms_sat_` + 16 hex + `_` + 64 hex. */
export const SERVICE_TOKEN = /^ccms_sat_[0-9a-f]{16}_[0-9a-f]{64}$/;
/** The most callers kept at once; past it, the one used longest ago is forgotten (and checked again). */
export const MAX_CALLERS = 256;
/** A caller not seen for this long is forgotten, its token with it. */
export const CALLER_IDLE_MS = 15 * 60_000;
/** How long a refused token is refused again without asking the API, and how many are kept. */
export const REFUSED_TTL_MS = 10_000;
export const MAX_REFUSED = 1_000;

/**
 * The API's codes refusing a token itself (`actor.guard.ts`): unknown or a
 * wrong secret (`unauthorized`), revoked, expired, its account deactivated,
 * or the API's lockout (a valid service token is never locked out there).
 */
const API_REFUSALS = new Set([
  'unauthorized',
  'token-revoked',
  'token-expired',
  'service-account-deactivated',
  'too-many-failed-attempts',
]);

/**
 * Whether `error` from a token's check (`GET /me`) means the token itself is
 * refused: one of the API's codes for it (`API_REFUSALS`) with a 401, 403 or
 * 429, or a token holding more than `content.read`. Anything else (the API
 * down, a timeout, a 5xx, a 401 or 403 of something in front of the API
 * without the API's code, an answer of the wrong form) is no refusal: it
 * says nothing about the token.
 */
export function isRefusal(error: unknown): error is ToolError {
  if (!(error instanceof ToolError)) return false;
  if (error.code === 'token-not-read-only') return true;
  return (
    API_REFUSALS.has(error.code) &&
    (error.status === 401 || error.status === 403 || error.status === 429)
  );
}

interface Caller {
  readonly context: McpContext;
  seen: number;
}

/**
 * The callers of the HTTP transport (#861), each with a service account
 * token of its own: per token a context of its own (its API client sending
 * that token, its check of the token, its lists of tags and releases), so
 * nothing one caller's token reads is ever served to another, whatever their
 * scopes. Kept by the SHA-256 of the token, at most `MAX_CALLERS` and
 * `CALLER_IDLE_MS`, and only once the token passed its check: a token the
 * API refuses is never kept, so wrong tokens cannot push real callers out;
 * it is refused again without asking the API for `REFUSED_TTL_MS`. Checks of
 * the same token at once share one. The check (`TokenCheck`, `GET /me`) is
 * kept for `LOOKUP_TTL_MS`: a token revoked meanwhile is refused at its next
 * check, and every content read sends the token, so the API refuses those
 * on the next read.
 */
export class Callers {
  readonly #known = new Map<string, Caller>();
  readonly #checking = new Map<string, Promise<McpContext>>();
  readonly #refused = new Map<string, { at: number; error: ToolError }>();

  constructor(
    private readonly make: (token: string) => McpContext,
    private readonly now: () => number = Date.now,
    private readonly max = MAX_CALLERS,
  ) {}

  /** How many callers are kept (for tests). */
  get size(): number {
    return this.#known.size;
  }

  /** Whether the token (`key`, its SHA-256 in hex) passed its check and was not refused since. */
  known(key: string): boolean {
    return this.#known.has(key);
  }

  /**
   * The caller's context once its token passed its check (`key`: the token's
   * SHA-256, hex). Throws the check's `ToolError`: a refusal (`isRefusal`)
   * forgets the caller; anything else keeps it as it was.
   */
  admit(token: string, key: string): Promise<McpContext> {
    this.#forgetIdle();
    const refused = this.#refused.get(key);
    if (refused && this.now() - refused.at < REFUSED_TTL_MS) {
      return Promise.reject(refused.error);
    }
    let checking = this.#checking.get(key);
    if (!checking) {
      checking = this.#check(token, key);
      this.#checking.set(key, checking);
      const done = () => this.#checking.delete(key);
      checking.then(done, done);
    }
    return checking;
  }

  async #check(token: string, key: string): Promise<McpContext> {
    const context = this.#known.get(key)?.context ?? this.make(token);
    try {
      await context.token.ensure();
    } catch (error) {
      if (isRefusal(error)) {
        this.#known.delete(key);
        this.#refused.delete(key);
        if (this.#refused.size >= MAX_REFUSED) {
          const oldest = this.#refused.keys().next().value;
          if (oldest !== undefined) this.#refused.delete(oldest);
        }
        this.#refused.set(key, { at: this.now(), error });
      }
      throw error;
    }
    // Most recently used last, so the first is the one to forget.
    this.#known.delete(key);
    this.#known.set(key, { context, seen: this.now() });
    if (this.#known.size > this.max) {
      const oldest = this.#known.keys().next().value;
      if (oldest !== undefined) this.#known.delete(oldest);
    }
    return context;
  }

  #forgetIdle(): void {
    const now = this.now();
    for (const [key, caller] of this.#known) {
      if (now - caller.seen < CALLER_IDLE_MS) return;
      this.#known.delete(key);
    }
  }
}
