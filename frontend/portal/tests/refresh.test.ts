import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiClient, JsonApiResource } from '../build/api-client.ts';
import { NothingReleased } from '../build/fetch.ts';
import {
  DEFAULT_REFRESH_SECONDS,
  MAX_RETRY_MS,
  publishedReleases,
  readRefreshMs,
  refreshLoop,
  type RefreshOptions,
  settingsKey,
  shownReleases,
  withdrawnSince,
  writeBuildRecord,
} from '../build/refresh.ts';
import { replaceOutput, writeHoldingPage } from '../build/run.ts';
import { SettingsError } from '../build/settings.ts';

const INTERVAL = 300_000;

/**
 * Runs the loop over the answers of `published`, one per read, with a clock that moves one
 * interval per wait; stops after the last answer. Answers what was logged.
 */
async function run(
  answers: readonly (string | Error)[],
  options: Partial<RefreshOptions> & Pick<RefreshOptions, 'build'>,
): Promise<string[]> {
  const lines: string[] = [];
  const stop = new AbortController();
  let clock = 0;
  let read = 0;
  await refreshLoop({
    published: async () => {
      const answer = answers[read++]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    holding: () => {
      throw new Error('no holding page expected');
    },
    intervalMs: INTERVAL,
    log: (line) => lines.push(line),
    signal: stop.signal,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (read >= answers.length) stop.abort();
    },
    ...options,
  });
  return lines;
}

describe('the rebuild interval (CCMS_PORTAL_REFRESH_SECONDS)', () => {
  it('is 300 s by default, and whole seconds from 5 to a day', () => {
    expect(readRefreshMs({})).toBe(DEFAULT_REFRESH_SECONDS * 1000);
    expect(readRefreshMs({ CCMS_PORTAL_REFRESH_SECONDS: '' })).toBe(300_000);
    expect(readRefreshMs({ CCMS_PORTAL_REFRESH_SECONDS: '5' })).toBe(5_000);
    expect(readRefreshMs({ CCMS_PORTAL_REFRESH_SECONDS: '86400' })).toBe(
      86_400_000,
    );
    for (const bad of ['4', '86401', '1.5', '-10', 'often', '1e3'])
      expect(() => readRefreshMs({ CCMS_PORTAL_REFRESH_SECONDS: bad })).toThrow(
        SettingsError,
      );
  });
});

describe('what is published', () => {
  it('changes with a release published or withdrawn, not with the order of the list', async () => {
    const release = (
      id: string,
      withdrawn = false,
      outputs: { state: string; done: number } | null = {
        state: 'done',
        done: 2,
      },
    ): JsonApiResource => ({
      type: 'Release',
      id,
      attributes: { withdrawal: withdrawn ? { reason: 'x' } : null },
      meta: { outputs },
    });
    const calls: unknown[] = [];
    const client = (releases: JsonApiResource[]) =>
      ({
        list: async (path: string, query: Record<string, string>) => {
          calls.push([path, query]);
          return releases;
        },
      }) as unknown as ApiClient;
    const a = await publishedReleases(client([release('b'), release('a')]));
    expect(a).toBe(
      await publishedReleases(client([release('a'), release('b')])),
    );
    expect(a).not.toBe(
      await publishedReleases(
        client([release('a'), release('b'), release('c')]),
      ),
    );
    expect(a).not.toBe(
      await publishedReleases(client([release('a'), release('b', true)])),
    );
    expect(calls[0]).toEqual(['/releases', { 'filter[state]': 'published' }]);
  });

  it('changes once a release has rendered its PDFs, not with each one done meanwhile', async () => {
    const release = (state: string, done: number): JsonApiResource => ({
      type: 'Release',
      id: 'a',
      attributes: { withdrawal: null },
      meta: { outputs: { state, done } },
    });
    const of = (r: JsonApiResource) =>
      publishedReleases({
        list: async () => [r],
      } as unknown as ApiClient);
    const planning = await of(release('planning', 0));
    expect(await of(release('rendering', 1))).toBe(planning);
    expect(await of(release('rendering', 3))).toBe(planning);
    const done = await of(release('done', 4));
    expect(done).not.toBe(planning);
    expect(await of(release('failed', 3))).not.toBe(done);
  });
});

describe('a withdrawal', () => {
  it('is a release served before that is withdrawn or gone now', () => {
    expect(withdrawnSince('a@pdfs-1,b@pdfs-2', 'a@pdfs-1,b@pdfs-2')).toBe(
      false,
    );
    expect(withdrawnSince('a@rendering', 'a@pdfs-3,b@rendering')).toBe(false);
    expect(
      withdrawnSince('a@pdfs-1,b@pdfs-2', 'a@pdfs-1,b@pdfs-2:withdrawn'),
    ).toBe(true);
    expect(withdrawnSince('a@pdfs-1,b@pdfs-2', 'a@pdfs-1')).toBe(true);
    expect(withdrawnSince('', 'a@pdfs-1:withdrawn')).toBe(false);
  });
});

describe('the rebuild loop', () => {
  let root: string;
  let out: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openfolia-portal-refresh-'));
    out = join(root, 'site');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A build as buildPortal does it: into `<out>.next`, swapped in when it completes. */
  const builds = (...outcomes: (string | Error)[]) => {
    let n = 0;
    return vi.fn(async () => {
      const outcome = outcomes[n++] ?? 'unexpected build';
      const next = `${out}.next`;
      mkdirSync(next, { recursive: true });
      writeFileSync(join(next, 'index.html'), 'half a build');
      if (outcome instanceof Error) {
        rmSync(next, { recursive: true, force: true });
        throw outcome;
      }
      writeFileSync(join(next, 'index.html'), outcome);
      replaceOutput(next, out);
    });
  };
  const served = () => readFileSync(join(out, 'index.html'), 'utf8');

  it('builds at start, and again only when what is published changed', async () => {
    const build = builds('first', 'second');
    const lines = await run(['r1', 'r1', 'r1,r2', 'r1,r2'], { build });
    expect(build).toHaveBeenCalledTimes(2);
    expect(served()).toBe('second');
    expect(lines.filter((l) => l.startsWith('Portal built'))).toHaveLength(2);
  });

  it('keeps the last good build served when a build fails, and logs it', async () => {
    const build = builds('good', new Error('astro build failed (1)'));
    const lines = await run(['r1', 'r1,r2'], { build });
    expect(build).toHaveBeenCalledTimes(2);
    expect(served()).toBe('good');
    expect(existsSync(`${out}.next`)).toBe(false);
    expect(lines.at(-1)).toMatch(
      /^Portal build failed \(astro build failed \(1\)\); the last good build is still served\./,
    );
  });

  it("serves a previous container's build until the first one of this one completes", async () => {
    mkdirSync(out);
    writeFileSync(join(out, 'index.html'), 'from before');
    const build = builds(new Error('the API answered 503'));
    const lines = await run(['r1'], { build, shownAtStart: 'r1' });
    expect(served()).toBe('from before');
    expect(lines[0]).toContain('the last good build is still served');
  });

  it('tries a failed build again after a wait that doubles, at once when a release changes', async () => {
    const build = builds(
      new Error('one'),
      new Error('two'),
      new Error('three'),
      'built',
    );
    // Reads one interval apart: a build at 0, again at 1 interval, then at 3 (2 later); r2 at 4.
    await run(['r1', 'r1', 'r1', 'r1', 'r2'], { build });
    expect(build).toHaveBeenCalledTimes(4);
    expect(served()).toBe('built');
  });

  it('waits at most an hour between tries of one failing build', async () => {
    const build = vi.fn(async () => {
      throw new Error('refused');
    });
    const lines = await run(Array(40).fill('r1'), { build });
    const waits = lines.map((l) => Number(/again in (\d+) s/.exec(l)?.[1]));
    expect(waits.at(-1)).toBe(MAX_RETRY_MS / 1000);
    expect(waits.slice(0, 5)).toEqual([300, 600, 1200, 2400, 3600]);
  });

  it('keeps serving when the releases cannot be read, and builds once they can', async () => {
    const build = builds('first', 'second');
    const lines = await run(['r1', new Error('fetch failed'), 'r1', 'r1,r2'], {
      build,
    });
    expect(build).toHaveBeenCalledTimes(2);
    expect(lines).toContain(
      'Could not read the releases (fetch failed); the last good build is still served.',
    );
    expect(served()).toBe('second');
  });

  it('shows the holding page while nothing is released, and the portal once something is', async () => {
    const build = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new NothingReleased())
      .mockImplementationOnce(builds('portal'));
    const holding = vi.fn(() => writeHoldingPage(out));
    const lines = await run(['', '', 'r1'], { build, holding });
    expect(holding).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(2);
    expect(lines[0]).toMatch(/^Nothing is released for the portal yet/);
    expect(served()).toBe('portal');
  });
  it('puts the holding page in place of a withdrawn release when the build without it fails', async () => {
    const build = builds('both', new Error('astro build failed (1)'));
    const holding = vi.fn(() => writeHoldingPage(out));
    const lines = await run(
      ['a@pdfs-1,b@pdfs-1', 'a@pdfs-1,b@pdfs-1:withdrawn'],
      {
        build,
        holding,
      },
    );
    expect(holding).toHaveBeenCalledTimes(1);
    expect(served()).toContain('No manuals have been released yet');
    expect(lines.at(-1)).toMatch(
      /^Portal build failed \(astro build failed \(1\)\); a release it showed is withdrawn, so the holding page is shown\./,
    );
  });

  it('keeps the build when a release is added and the build fails', async () => {
    const build = builds('a', new Error('refused'));
    const holding = vi.fn();
    await run(['a@pdfs-1', 'a@pdfs-1,b@rendering'], { build, holding });
    expect(holding).not.toHaveBeenCalled();
    expect(served()).toBe('a');
  });

  it('keeps running when the holding page cannot be written, and tries again', async () => {
    const build = vi.fn(async () => {
      throw new NothingReleased();
    });
    const holding = vi.fn(() => {
      throw new Error('no space left on device');
    });
    const lines = await run(['', '', ''], { build, holding });
    expect(holding).toHaveBeenCalledTimes(2);
    expect(lines[0]).toMatch(
      /^Portal build failed \(no space left on device\); nothing is served yet\. Tried again in 300 s/,
    );
  });
});

describe('the holding page', () => {
  it('takes the place of the output, a page and its stylesheet, and no inline style or script', () => {
    const root = mkdtempSync(join(tmpdir(), 'openfolia-portal-holding-'));
    try {
      const out = join(root, 'site');
      mkdirSync(out);
      writeFileSync(join(out, 'index.html'), 'old');
      writeHoldingPage(out);
      const page = readFileSync(join(out, 'index.html'), 'utf8');
      expect(page).toContain('No manuals have been released yet');
      expect(page).toContain('lang="de"');
      expect(page).not.toMatch(/<script|<style|style=/);
      expect(existsSync(join(out, 'holding.css'))).toBe(true);
      expect(existsSync(`${out}.next`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the record of what is served', () => {
  const settings = (audience: string) =>
    settingsKey({
      apiUrl: new URL('http://api:3000'),
      token: 'never in the key',
      audience,
      languages: undefined,
      releases: undefined,
      outDir: '/out/site',
      basePath: '/',
      branding: true,
    });
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openfolia-portal-record-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('gives the releases served for the same settings, nothing for others or none recorded', () => {
    const out = join(root, 'site');
    expect(settings('public')).not.toContain('never in the key');
    expect(shownReleases(out, settings('public'))).toBeUndefined();
    writeBuildRecord(out, settings('internal'), 'a@pdfs-1');
    expect(shownReleases(out, settings('internal'))).toBe('a@pdfs-1');
    expect(shownReleases(out, settings('public'))).toBeUndefined();
    expect(existsSync(join(out, 'site.json'))).toBe(false);
    writeFileSync(`${out}.json`, 'not json');
    expect(shownReleases(out, settings('internal'))).toBeUndefined();
  });
});
