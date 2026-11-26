import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ApiClient } from './api-client.ts';
import { NothingReleased } from './fetch.ts';
import { type PortalSettings, SettingsError } from './settings.ts';

/**
 * The portal image's rebuilds (#819, `scripts/serve.ts`): the portal is built when it starts and
 * again whenever what the API has published changes, which it reads every
 * `CCMS_PORTAL_REFRESH_SECONDS` (polling, not the API's webhooks: a delivery goes only to a
 * public https address, never to a container beside the API). The web server serves the output
 * folder throughout, and a build replaces it only when it completes, so readers get the last good
 * build while a new one runs and after one fails.
 */

/** `CCMS_PORTAL_REFRESH_SECONDS`' default and range. */
export const DEFAULT_REFRESH_SECONDS = 300;
export const MIN_REFRESH_SECONDS = 5;
export const MAX_REFRESH_SECONDS = 86_400;
/** The longest wait before a build that failed is tried again for the same releases. */
export const MAX_RETRY_MS = 60 * 60 * 1000;

/** How often the API's releases are read, in ms. */
export function readRefreshMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env['CCMS_PORTAL_REFRESH_SECONDS'];
  if (raw === undefined || raw.trim() === '')
    return DEFAULT_REFRESH_SECONDS * 1000;
  const seconds = /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_REFRESH_SECONDS ||
    seconds > MAX_REFRESH_SECONDS
  )
    throw new SettingsError(
      `CCMS_PORTAL_REFRESH_SECONDS: whole seconds from ${MIN_REFRESH_SECONDS} to ${MAX_REFRESH_SECONDS}`,
    );
  return seconds * 1000;
}

/**
 * What the API has published, as one string that changes with every release published or
 * withdrawn, and when a release's PDFs finish rendering (a build takes only the done ones, so a
 * release built while it renders is built again once it is through): each published release's
 * ID, where its outputs stand and whether it is withdrawn, sorted.
 */
export async function publishedReleases(client: ApiClient): Promise<string> {
  const releases = await client.list('/releases', {
    'filter[state]': 'published',
  });
  return releases
    .map((r) => {
      const outputs = r.meta?.['outputs'] as
        { state?: unknown; done?: unknown } | null | undefined;
      // Under way: one mark, so a build is not repeated for each PDF done meanwhile.
      const pdfs =
        outputs?.state === 'done' || outputs?.state === 'failed'
          ? `pdfs-${typeof outputs.done === 'number' ? outputs.done : 0}`
          : 'rendering';
      const withdrawn =
        r.attributes['withdrawal'] === null ||
        r.attributes['withdrawal'] === undefined
          ? ''
          : ':withdrawn';
      return `${r.id}@${pdfs}${withdrawn}`;
    })
    .sort()
    .join(',');
}

/**
 * The settings a build depends on, as one string (never the token): a build made with other
 * settings (another audience, say) is not served once they change.
 */
export function settingsKey(settings: PortalSettings): string {
  return JSON.stringify({
    apiUrl: settings.apiUrl.href,
    audience: settings.audience,
    languages: settings.languages ?? null,
    releases: settings.releases ?? null,
    releasesPerProduct: settings.releasesPerProduct,
    olderNoindex: settings.olderNoindex,
    basePath: settings.basePath,
    branding: settings.branding,
    // Not in the key while unset, so a build from before they existed is still served.
    start: settings.start,
    portalOrigin: settings.portalOrigin,
  });
}

/** What the output folder shows: `<outDir>.json`, beside it, so never served. */
interface BuildRecord {
  readonly settings: string;
  /** `publishedReleases` when it was built; '' for the holding page. */
  readonly releases: string;
}

const recordPath = (outDir: string) => `${outDir}.json`;

/** Records what the output folder shows now, replacing the record in one step. */
export function writeBuildRecord(
  outDir: string,
  settings: string,
  releases: string,
): void {
  const record: BuildRecord = { settings, releases };
  writeFileSync(`${recordPath(outDir)}.next`, JSON.stringify(record));
  renameSync(`${recordPath(outDir)}.next`, recordPath(outDir));
}

/**
 * The releases the output folder shows if it was built with these settings; undefined when there
 * is no build, no record of it, or it was built with other settings.
 */
export function shownReleases(
  outDir: string,
  settings: string,
): string | undefined {
  if (!existsSync(recordPath(outDir))) return undefined;
  try {
    const record = JSON.parse(
      readFileSync(recordPath(outDir), 'utf8'),
    ) as Partial<BuildRecord>;
    return record.settings === settings && typeof record.releases === 'string'
      ? record.releases
      : undefined;
  } catch {
    return undefined;
  }
}

/** Releases served in `before` that are withdrawn or gone in `now` (`publishedReleases`). */
export function withdrawnSince(before: string, now: string): boolean {
  const active = (list: string) =>
    list
      .split(',')
      .filter((r) => r !== '' && !r.endsWith(':withdrawn'))
      .map((r) => r.split('@')[0]!);
  const still = new Set(active(now));
  return active(before).some((r) => !still.has(r));
}

export interface RefreshOptions {
  /** What the API has published now (`publishedReleases`). */
  readonly published: () => Promise<string>;
  /** One build of `releases` into the output folder, which it replaces only when it completes. */
  readonly build: (releases: string) => Promise<void>;
  /** The page shown while nothing is released (`writeHoldingPage`), in place of the output. */
  readonly holding: () => void;
  readonly intervalMs: number;
  /**
   * What the output folder shows at start (a previous container's build, `shownReleases`; '' for
   * the holding page): served until replaced. Undefined: nothing.
   */
  readonly shownAtStart?: string;
  readonly log: (line: string) => void;
  /** Stops the loop; a build in progress finishes first. */
  readonly signal: AbortSignal;
  /** For tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      done();
    }
    signal.addEventListener('abort', finish, { once: true });
  });

/** An error's message only: never a stack, which could show values. */
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'unknown error';

/**
 * Builds at once, then reads what is published every `intervalMs` and builds again when it
 * changed. A failed build leaves the output as it was (logged), and is tried again for the same
 * releases after a wait that doubles with each failure (one interval first, at most an hour);
 * releases that change meanwhile are built at the next read. Nothing released: the holding page.
 * A build that fails after a release it shows was withdrawn puts the holding page in its place:
 * withdrawn content is never served on. Resolves once `signal` aborts.
 */
export async function refreshLoop(options: RefreshOptions): Promise<void> {
  const { log, signal } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  /** What this process built; undefined until its first build (or holding page). */
  let served: string | undefined;
  /** What the output folder shows, from this process or a previous one; '' the holding page. */
  let shown = options.shownAtStart;
  const servedNow = () =>
    shown === undefined
      ? 'nothing is served yet'
      : shown === ''
        ? 'the holding page is shown'
        : 'the last good build is still served';
  let failed: { releases: string; count: number; retryAt: number } | undefined;
  while (!signal.aborted) {
    let releases: string | undefined;
    try {
      releases = await options.published();
    } catch (error) {
      log(`Could not read the releases (${messageOf(error)}); ${servedNow()}.`);
    }
    const due =
      releases !== undefined &&
      releases !== served &&
      (failed?.releases !== releases || now() >= failed.retryAt);
    if (due && !signal.aborted) {
      const started = now();
      let problem: unknown;
      try {
        await options.build(releases!);
        served = releases;
        shown = releases;
        failed = undefined;
        log(`Portal built in ${Math.round((now() - started) / 1000)} s.`);
      } catch (error) {
        problem = error;
      }
      if (problem instanceof NothingReleased) {
        try {
          options.holding();
          served = releases;
          shown = '';
          failed = undefined;
          problem = undefined;
          log(
            'Nothing is released for the portal yet: it shows a page that says so.',
          );
        } catch (error) {
          problem = error;
        }
      }
      if (problem !== undefined) {
        const count =
          failed && failed.releases === releases ? failed.count + 1 : 1;
        const wait = Math.min(
          options.intervalMs * 2 ** (count - 1),
          MAX_RETRY_MS,
        );
        failed = { releases: releases!, count, retryAt: now() + wait };
        let state = servedNow();
        if (shown && withdrawnSince(shown, releases!)) {
          try {
            options.holding();
            shown = '';
            state =
              'a release it showed is withdrawn, so the holding page is shown';
          } catch (error) {
            state = `a release it showed is withdrawn, and the holding page could not replace it (${messageOf(error)})`;
          }
        }
        log(
          `Portal build failed (${messageOf(problem)}); ${state}. Tried again in ${Math.round(wait / 1000)} s, or when a release changes.`,
        );
      }
    }
    await sleep(options.intervalMs, signal);
  }
}
