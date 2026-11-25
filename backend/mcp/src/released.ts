import { z } from 'zod';
import {
  Paged,
  parseAnswer,
  ToolError,
  type ContentApi,
} from './api-client.js';

/** The branch whose head is the current released content. */
export const RELEASED_BRANCH = 'main';
/** How long the lists of tags, releases and the token's permissions are kept. */
export const LOOKUP_TTL_MS = 60_000;
/** The lists are read again early (for a name not in them) at most once in this time. */
export const REFRESH_MIN_MS = 10_000;
/** How long a name found in no list is refused without looking again, and how many are kept. */
export const UNKNOWN_TTL_MS = 10_000;
const UNKNOWN_KEPT = 1_000;
/** At most this many pages of 200 are read for one lookup (refs, releases). */
export const MAX_LOOKUP_PAGES = 20;

/** A ref argument, as tools take it: `main` or a release tag, checked for its form only. */
export const RefArgument = z
  .string()
  .min(1)
  .max(256)
  .describe(
    'Which released content to read: `main` (the current content, the default) or the tag of a release (`list_releases`). Drafts and change-set branches are not readable here.',
  );

/**
 * Refuses, before any API call, what can never be released content: a
 * change set's branch, a commit ID, anything that is no well-formed ref
 * name. `main` passes; a tag is checked against the API afterwards.
 */
export function checkRefForm(ref: string): void {
  const refused = (detail: string) =>
    new ToolError('ref-not-released', 'Not released content', detail);
  if (ref === RELEASED_BRANCH) return;
  if (/^change-sets(\/|$)/i.test(ref)) {
    throw refused(
      'A change set’s branch is a draft; only `main` and release tags are readable.',
    );
  }
  if (/^[0-9a-f]{7,64}$/i.test(ref)) {
    throw refused('A commit ID is not accepted; give `main` or a release tag.');
  }
  if (
    !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(ref) ||
    ref.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock')) ||
    ref.includes('..') ||
    /^(refs|heads)\//i.test(ref)
  ) {
    throw refused('Not a ref name; give `main` or a release tag.');
  }
}

const RefsPage = Paged.extend({
  data: z.array(
    z.looseObject({
      attributes: z.looseObject({
        kind: z.enum(['branch', 'tag']),
        name: z.string(),
      }),
    }),
  ),
});

export const ReleasesPage = Paged.extend({
  data: z.array(
    z.looseObject({
      id: z.string(),
      attributes: z.looseObject({
        product: z.string(),
        revision: z.string(),
        tag: z.string(),
        commit: z.string(),
        publishedAt: z.string(),
        major: z.boolean().optional(),
        notes: z.string().nullable().optional(),
        withdrawal: z
          .looseObject({ at: z.string(), reason: z.string() })
          .nullable(),
      }),
    }),
  ),
});

export type Release = z.infer<typeof ReleasesPage>['data'][number];

/**
 * One value, worked out at most once per `ttl`, one load at a time. A
 * failed load is not kept, but a value still within its `ttl` is kept
 * through it.
 */
export class Cached<T> {
  /** The last value loaded, and when its load started. */
  #value: { at: number; value: T } | undefined;
  /** The load under way, if any: every caller shares it. */
  #loading: Promise<T> | undefined;
  /** When the last refresh started, whatever came of it (a load that succeeded counts too). */
  #refreshedAt = -Infinity;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttl = LOOKUP_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<T> {
    if (this.#value && this.now() - this.#value.at < this.ttl) {
      return Promise.resolve(this.#value.value);
    }
    return this.#start();
  }

  /**
   * The value loaded again, at most once in `minAge` ms for every caller
   * together (failed refreshes count), never beside a load under way;
   * otherwise what `get` gives.
   */
  refresh(minAge = REFRESH_MIN_MS): Promise<T> {
    if (this.#loading) return this.#loading;
    const last = Math.max(this.#refreshedAt, this.#value?.at ?? -Infinity);
    if (this.now() - last < minAge) return this.get();
    this.#refreshedAt = this.now();
    return this.#start();
  }

  #start(): Promise<T> {
    if (this.#loading) return this.#loading;
    const at = this.now();
    const loading = this.load().then(
      (value) => {
        this.#value = { at, value };
        return value;
      },
      (error: unknown) => {
        // A value still fresh is served on; a stale one is not.
        if (this.#value && this.now() - this.#value.at < this.ttl) {
          return this.#value.value;
        }
        throw error;
      },
    );
    this.#loading = loading;
    const done = () => {
      if (this.#loading === loading) this.#loading = undefined;
    };
    loading.then(done, done);
    return loading;
  }
}

/** Every item of a paged list, at most `MAX_LOOKUP_PAGES` pages of 200. */
export async function allPages<T extends z.ZodType<z.infer<typeof Paged>>>(
  api: ContentApi,
  path: string,
  schema: T,
  query: Record<string, string> = {},
): Promise<z.infer<T>[]> {
  const pages: z.infer<T>[] = [];
  for (let number = 1; number <= MAX_LOOKUP_PAGES; number++) {
    const { body } = await api.get(path, {
      ...query,
      'page[number]': String(number),
      'page[size]': '200',
    });
    const page: z.infer<typeof Paged> & z.infer<T> = parseAnswer(schema, body);
    pages.push(page);
    if (number >= page.meta.page.lastPage) return pages;
  }
  // Past the bound a lookup would be partial (a withdrawn release missed): refused, never half-read.
  throw new ToolError(
    'lookup-too-large',
    'Too many refs or releases to check the ref against',
    `More than ${MAX_LOOKUP_PAGES * 200}.`,
  );
}

/**
 * Which refs a tool may read: `main`, and the tags the API lists for this
 * token (`GET /refs`, released refs only for a `content.read` reader) that
 * are not a withdrawn release's (`GET /releases`): a withdrawn release is
 * not served as content to rely on.
 */
export class ReleasedRefs {
  readonly #tags: Cached<Set<string>>;
  readonly #releases: Cached<Release[]>;
  /** Names found in no list, with when: refused again without a lookup for a while. */
  readonly #unknown = new Map<string, number>();

  constructor(
    api: ContentApi,
    private readonly now: () => number = Date.now,
  ) {
    this.#tags = new Cached(
      async () =>
        new Set(
          (await allPages(api, '/refs', RefsPage)).flatMap((p) =>
            p.data
              .filter((r) => r.attributes.kind === 'tag')
              .map((r) => r.attributes.name),
          ),
        ),
      LOOKUP_TTL_MS,
      now,
    );
    this.#releases = new Cached(
      async () =>
        (await allPages(api, '/releases', ReleasesPage)).flatMap((p) => p.data),
      LOOKUP_TTL_MS,
      now,
    );
  }

  /** The releases, newest first, withdrawn ones too. */
  releases(): Promise<Release[]> {
    return this.#releases.get();
  }

  /**
   * The ref to read: `ref` (default `main`) once it is known to be released
   * and not withdrawn. The lists are shared by every call and read in the
   * background of `signal`: a call given up stops waiting, the read goes on
   * for the others.
   */
  async resolve(
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const name = ref ?? RELEASED_BRANCH;
    checkRefForm(name);
    if (name === RELEASED_BRANCH) return name;
    const notReleased = () =>
      new ToolError(
        'ref-not-released',
        'Not released content',
        'No release tag of that name; give `main` or a tag `list_releases` lists.',
      );
    const seen = this.#unknown.get(name);
    if (seen !== undefined && this.now() - seen < UNKNOWN_TTL_MS) {
      throw notReleased();
    }
    let [tags, releases] = await until(
      Promise.all([this.#tags.get(), this.#releases.get()]),
      signal,
    );
    if (!tags.has(name)) {
      // A release cut since the lists were read: look again, at most once in
      // `REFRESH_MIN_MS` for every caller together.
      [tags, releases] = await until(
        Promise.all([this.#tags.refresh(), this.#releases.refresh()]),
        signal,
      );
    }
    if (!tags.has(name)) {
      if (this.#unknown.size >= UNKNOWN_KEPT) {
        const oldest = this.#unknown.keys().next().value;
        if (oldest !== undefined) this.#unknown.delete(oldest);
      }
      this.#unknown.delete(name);
      this.#unknown.set(name, this.now());
      throw notReleased();
    }
    if (
      releases.some((r) => r.attributes.tag === name && r.attributes.withdrawal)
    ) {
      throw new ToolError(
        'release-withdrawn',
        'The release is withdrawn',
        'Its content is not served; read `main` or another release.',
      );
    }
    return name;
  }
}

/** `promise`, or a `cancelled` refusal as soon as `signal` aborts (the promise itself goes on). */
export function until<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  const cancelled = () =>
    new ToolError(
      'cancelled',
      'The call was cancelled or ran past its deadline',
    );
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

const Me = z.object({
  data: z.looseObject({
    meta: z.looseObject({
      permissions: z.array(z.looseObject({ permission: z.string() })),
    }),
  }),
});

/**
 * Checks, at most once a minute, that the API token acts with `content.read`
 * alone (`GET /me`): a token that may also read drafts, edit or administer is
 * refused, so a misconfigured token never widens what an agent reads.
 */
export class TokenCheck {
  readonly #check: Cached<void>;

  constructor(api: ContentApi) {
    this.#check = new Cached(async () => {
      const me = parseAnswer(Me, (await api.get('/me')).body);
      const held = me.data.meta.permissions.map((p) => p.permission);
      const other = held.filter((p) => p !== 'content.read');
      if (other.length > 0 || !held.includes('content.read')) {
        throw new ToolError(
          'token-not-read-only',
          'The API token must hold `content.read` alone',
          `It holds: ${held.join(', ') || 'nothing'}. Give the service account a role with only \`content.read\`.`,
        );
      }
    });
  }

  ensure(signal?: AbortSignal): Promise<void> {
    return until(this.#check.get(), signal);
  }
}
