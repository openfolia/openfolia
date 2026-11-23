import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFiles } from '@openfolia/connector-wiki-markup';
import {
  type Module,
  parseConfig,
  validateImport,
} from '@openfolia/content-model';
import { parse as parseYaml } from 'yaml';
import { runCli } from './cli.js';
import {
  apiBaseUrl,
  ImportApi,
  type ImportReport,
  readSessionCookie,
} from './client.js';
import { convertItems } from './convert.js';
import { TrackerMapping } from './mapping.js';
import { runOnce } from './run.js';
import { FixtureSource } from './source.js';
import { TRIGGER_SIGNATURE_HEADER, triggerSignatureHeader } from './webhook.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const ITEMS = join(FIXTURES, 'items.json');
const MAPPING = join(FIXTURES, 'mapping.yaml');
const config = parseConfig(
  readFileSync(join(FIXTURES, 'openfolia.yaml'), 'utf8'),
);
const mapping = TrackerMapping.parse(parseYaml(readFileSync(MAPPING, 'utf8')));
const SESSION = 's'.repeat(43);
/** A cookie file as curl writes it, holding the session. */
const COOKIES = `# Netscape HTTP Cookie File\n#HttpOnly_openfolia.example.com\tFALSE\t/\tTRUE\t0\t__Host-openfolia-session\t${SESSION}\n`;
const sessionDir = mkdtempSync(join(tmpdir(), 'tracker-connector-'));
const SESSION_FILE = join(sessionDir, 'cookies.txt');
writeFileSync(SESSION_FILE, COOKIES, { mode: 0o600 });
afterAll(() => rmSync(sessionDir, { recursive: true, force: true }));

describe('convertItems', () => {
  it('maps the included items onto modules, a manual and the variants they show in', async () => {
    const items = await new FixtureSource(ITEMS).items();
    const { document, included } = convertItems(items, mapping);
    expect(included.map((i) => i.id)).toEqual(['PRJ-101', 'PRJ-102']);
    const [faster, quiet] = document.modules as Module[];
    expect(faster?.id).toBe('note-prj-101');
    expect(faster?.meta).toEqual({
      title: 'Faster charging',
      type: 'concept',
      lang: 'en',
      audience: 'public',
      facets: { region: ['north'] },
      source: { system: 'Issue tracker', id: 'PRJ-101' },
    });
    expect(quiet?.meta).toMatchObject({
      audience: 'internal',
      facets: { region: ['south'] },
    });
    // A link to another item's key is a cross-reference to its module.
    expect(JSON.stringify(faster?.blocks)).toContain(
      '{"type":"xref","module":"note-prj-102"}',
    );
    expect(document.manuals?.[0]?.entries).toEqual([
      {
        module: 'note-prj-101',
        when: { op: 'in', attr: 'model', values: ['large', 'small'] },
      },
      {
        module: 'note-prj-102',
        when: { op: 'in', attr: 'model', values: ['large'] },
      },
    ]);
  });

  it('reports what it could not map, by item', async () => {
    const { document } = convertItems(
      await new FixtureSource(ITEMS).items(),
      mapping,
    );
    expect(
      (document.report ?? []).map((e) => [
        e.sourceId,
        e.sourceKind,
        /^\[([a-z-]+)\]/.exec(e.message)?.[1],
      ]),
    ).toEqual([
      ['PRJ-102', 'item', 'unknown-macro'],
      ['PRJ-102', 'item', 'strikethrough'],
      ['PRJ-102', 'item', 'unmapped-value'],
    ]);
  });

  it('gives a bundle the target configuration accepts', async () => {
    const conversion = convertItems(
      await new FixtureSource(ITEMS).items(),
      mapping,
    );
    const validation = await validateImport(
      { files: bundleFiles(conversion) },
      config,
    );
    expect(
      [
        ...validation.issues,
        ...validation.items.flatMap((i) => i.issues),
      ].filter((i) => i.severity === 'error'),
    ).toEqual([]);
  });

  it('gives the same bundle for the same items, in any order', async () => {
    const items = [...(await new FixtureSource(ITEMS).items())];
    const a = JSON.stringify(convertItems(items, mapping).document);
    const b = JSON.stringify(convertItems(items.reverse(), mapping).document);
    expect(a).toBe(b);
  });
});

/** The content API's import routes, in memory: what each call asked, and the answers a test sets. */
class StubApi {
  readonly calls: {
    method: string;
    url: string;
    cookie: string | null;
    authorization: string | null;
    redirect?: RequestRedirect;
    fields?: Record<string, string>;
  }[] = [];
  report: ImportReport = {
    valid: true,
    applicable: true,
    items: [],
    issues: [],
    counts: { create: 2, update: 0, skip: 0, refuse: 0 },
  };
  /** The states `GET /imports/:id` answers, in turn. */
  states: {
    state: string;
    changeSetId?: string;
    failure?: { code: string; detail: string };
  }[] = [{ state: 'applying' }, { state: 'applied', changeSetId: 'cs-1' }];
  /** Lock subject → the change set holding it. */
  locks: Record<string, string> = {};

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const fields: Record<string, string> = {};
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body) if (typeof v === 'string') fields[k] = v;
    }
    this.calls.push({
      method: init?.method ?? 'GET',
      url: url.href,
      cookie: headers.get('cookie'),
      authorization: headers.get('authorization'),
      ...(init?.redirect && { redirect: init.redirect }),
      ...(Object.keys(fields).length > 0 && { fields }),
    });
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (route === 'POST /api/imports') {
      return answer(
        201,
        this.importDoc(fields['dryRun'] === 'true' ? 'dry-run' : 'validated'),
      );
    }
    if (route === 'GET /api/locks') {
      const held = this.locks[url.searchParams.get('filter[subject]') ?? ''];
      return answer(200, {
        data: held
          ? [
              {
                type: 'Lock',
                id: 'lock-1',
                relationships: {
                  changeSet: { data: { type: 'ChangeSet', id: held } },
                },
              },
            ]
          : [],
      });
    }
    if (route === 'POST /api/imports/imp-1/apply')
      return answer(202, this.importDoc('applying'));
    if (route === 'GET /api/imports/imp-1') {
      const next = this.states.shift() ?? {
        state: 'applied',
        changeSetId: 'cs-1',
      };
      return answer(
        200,
        this.importDoc(next.state, next.changeSetId, next.failure),
      );
    }
    if (route === 'POST /api/change-sets/cs-1/submit') {
      return answer(200, {
        data: {
          type: 'ChangeSet',
          id: 'cs-1',
          attributes: { state: 'in-review' },
        },
      });
    }
    return answer(404, {
      errors: [{ status: '404', code: 'not-found', detail: 'No such route.' }],
    });
  }) as typeof fetch;

  private importDoc(
    state: string,
    changeSetId?: string,
    failure?: { code: string; detail: string },
  ) {
    return {
      data: {
        type: 'Import',
        id: 'imp-1',
        attributes: { state },
        ...(changeSetId && {
          relationships: {
            changeSet: { data: { type: 'ChangeSet', id: changeSetId } },
          },
        }),
        meta: { report: this.report, failure: failure ?? null },
      },
    };
  }
}

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  });
}

describe('runOnce', () => {
  const setup = () => {
    const stub = new StubApi();
    const api = new ImportApi({
      baseUrl: 'https://openfolia.example.com/api',
      credential: { session: SESSION },
      fetch: stub.fetch,
    });
    const run = () =>
      runOnce({
        source: new FixtureSource(ITEMS),
        mapping,
        api,
        wait: async () => undefined,
      });
    return { stub, run };
  };

  it('checks, uploads, applies and submits the change set for review', async () => {
    const { stub, run } = setup();
    expect(await run()).toEqual({
      outcome: 'imported',
      importId: 'imp-1',
      changeSetId: 'cs-1',
      changeSetState: 'in-review',
      counts: stub.report.counts,
    });
    expect(
      stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ).toEqual([
      'POST /api/imports',
      'POST /api/imports',
      'POST /api/imports/imp-1/apply',
      'GET /api/imports/imp-1',
      'GET /api/imports/imp-1',
      'POST /api/change-sets/cs-1/submit',
    ]);
    expect(stub.calls[0]?.fields).toEqual({
      importer: 'bundle',
      updateExisting: 'true',
      dryRun: 'true',
    });
    expect(stub.calls[1]?.fields).toMatchObject({ dryRun: 'false' });
    // The session goes to the configured API only, and a redirect is never followed.
    for (const call of stub.calls) {
      expect(call.url.startsWith('https://openfolia.example.com/api/')).toBe(
        true,
      );
      expect(call.cookie).toBe(`__Host-openfolia-session=${SESSION}`);
      expect(call.authorization).toBeNull();
      expect(call.redirect).toBe('error');
    }
  });

  it('uploads nothing when the target holds every item as it is', async () => {
    const { stub, run } = setup();
    stub.report = {
      ...stub.report,
      applicable: false,
      counts: { create: 0, update: 0, skip: 2, refuse: 0 },
    };
    expect(await run()).toMatchObject({ outcome: 'nothing-new' });
    expect(stub.calls).toHaveLength(1);
  });

  it('writes nothing when the check refuses an item, and says why', async () => {
    const { stub, run } = setup();
    stub.report = {
      ...stub.report,
      valid: false,
      applicable: false,
      items: [
        {
          kind: 'module',
          id: 'note-prj-101',
          action: 'refuse',
          reasons: [{ code: 'unknown-audience', message: 'no such audience' }],
        },
      ],
      counts: { create: 1, update: 0, skip: 0, refuse: 1 },
    };
    expect(await run()).toEqual({
      outcome: 'refused',
      counts: stub.report.counts,
      reasons: ['module note-prj-101: unknown-audience: no such audience'],
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('uploads nothing while an open change set holds what it would write', async () => {
    const { stub, run } = setup();
    stub.report = {
      ...stub.report,
      items: [
        {
          kind: 'module',
          id: 'note-prj-101',
          lang: 'en',
          action: 'update',
          reasons: [],
        },
        {
          kind: 'module',
          id: 'note-prj-102',
          lang: 'en',
          action: 'skip',
          reasons: [],
        },
        { kind: 'manual', id: 'release-notes', action: 'update', reasons: [] },
      ],
      counts: { create: 0, update: 2, skip: 1, refuse: 0 },
    };
    stub.locks = { 'module/en/note-prj-101': 'cs-0' };
    expect(await run()).toEqual({
      outcome: 'held',
      counts: stub.report.counts,
      held: [{ subject: 'module/en/note-prj-101', changeSetId: 'cs-0' }],
    });
    // The check, then one lookup per subject it would write, and no upload.
    expect(
      stub.calls.map((c) => `${c.method} ${new URL(c.url).search}`),
    ).toEqual([
      'POST ',
      'GET ?filter%5Bsubject%5D=module%2Fen%2Fnote-prj-101&page%5Bsize%5D=1',
      'GET ?filter%5Bsubject%5D=manual%2Frelease-notes&page%5Bsize%5D=1',
    ]);
  });

  it('reports a failed import with its reason, and submits nothing', async () => {
    const { stub, run } = setup();
    stub.states = [
      {
        state: 'failed',
        changeSetId: 'cs-1',
        failure: { code: 'locked', detail: 'held' },
      },
    ];
    expect(await run()).toEqual({
      outcome: 'failed',
      importId: 'imp-1',
      changeSetId: 'cs-1',
      failure: { code: 'locked', detail: 'held' },
    });
    expect(stub.calls.some((c) => c.url.endsWith('/submit'))).toBe(false);
  });

  it('gives up waiting after the longest wait', async () => {
    const stub = new StubApi();
    stub.states = Array.from({ length: 100 }, () => ({ state: 'applying' }));
    let clock = 0;
    const api = new ImportApi({
      baseUrl: 'https://openfolia.example.com/api',
      credential: { session: SESSION },
      fetch: stub.fetch,
    });
    await expect(
      runOnce({
        source: new FixtureSource(ITEMS),
        mapping,
        api,
        wait: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        maxWaitMs: 10_000,
      }),
    ).rejects.toThrow(/still being applied/);
  });
});

describe('the API address', () => {
  it('is https, or http to this machine only, and holds no credentials', () => {
    expect(apiBaseUrl('https://openfolia.example.com').href).toBe(
      'https://openfolia.example.com/',
    );
    expect(apiBaseUrl('http://127.0.0.1:3101').href).toBe(
      'http://127.0.0.1:3101/',
    );
    expect(apiBaseUrl('http://localhost:3101/api').href).toBe(
      'http://localhost:3101/api/',
    );
    expect(() => apiBaseUrl('http://openfolia.example.com')).toThrow(/https/);
    expect(() => apiBaseUrl('http://127.0.0.1.example.com')).toThrow(/https/);
    expect(() => apiBaseUrl('https://user:pw@openfolia.example.com')).toThrow(
      /credentials/,
    );
    expect(() => apiBaseUrl('https://openfolia.example.com/?token=x')).toThrow(
      /query/,
    );
    expect(() => apiBaseUrl('file:///etc/passwd')).toThrow(/https/);
  });
});

const env = () => ({
  CCMS_CONNECTOR_API_URL: 'https://openfolia.example.com/api',
  CCMS_CONNECTOR_SESSION_FILE: SESSION_FILE,
});

describe('the command line', () => {
  it('runs once and says what it did', async () => {
    const stub = new StubApi();
    const out: string[] = [];
    const code = await runCli(
      ['--mapping', MAPPING, '--items', ITEMS],
      env(),
      { out: (l) => out.push(l), err: (l) => out.push(l) },
      { fetch: stub.fetch, pollMs: 1 },
    );
    expect(code).toBe(0);
    expect(out).toEqual([
      'Imported 2 new and 0 changed items into change set cs-1 (in-review).',
    ]);
  });

  it('runs on a schedule until stopped, and goes on after a failed run without the token in what it prints', async () => {
    const stub = new StubApi();
    const stop = new AbortController();
    let runs = 0;
    const lines: string[] = [];
    const failing: typeof fetch = async (input, init) => {
      runs += 1;
      if (runs === 1)
        return answer(503, {
          errors: [{ status: '503', code: 'import-busy', detail: 'busy' }],
        });
      return stub.fetch(input, init);
    };
    const code = await runCli(
      ['--mapping', MAPPING, '--items', ITEMS, '--every', '5'],
      env(),
      { out: (l) => lines.push(l), err: (l) => lines.push(l) },
      {
        fetch: failing,
        pollMs: 1,
        signal: stop.signal,
        sleep: async (ms) => {
          expect(ms).toBe(5 * 60_000);
          if (lines.length >= 2) stop.abort();
        },
      },
    );
    expect(code).toBe(0);
    expect(lines[0]).toBe('The API answered 503 import-busy: busy');
    expect(lines[1]).toMatch(/^Imported 2 new/);
    expect(lines.join('\n')).not.toContain(SESSION);
  });

  it('listens for signed triggers, answers at once and runs once per trigger, never two at once', async () => {
    const stub = new StubApi();
    const stop = new AbortController();
    const lines: string[] = [];
    const secret = 'w'.repeat(40);
    let listening: (port: number) => void = () => undefined;
    const port = new Promise<number>((r) => (listening = r));
    const done = runCli(
      ['--mapping', MAPPING, '--items', ITEMS, '--listen', '127.0.0.1:0'],
      { ...env(), CCMS_CONNECTOR_WEBHOOK_SECRET: secret },
      { out: (l) => lines.push(l), err: (l) => lines.push(l) },
      {
        fetch: stub.fetch,
        pollMs: 1,
        signal: stop.signal,
        triggerGapMs: 0,
        onListening: (a) => listening(a.port),
      },
    );
    const url = `http://127.0.0.1:${await port}/trigger`;
    const trigger = (b: string) =>
      fetch(url, {
        method: 'POST',
        body: b,
        headers: {
          [TRIGGER_SIGNATURE_HEADER]: triggerSignatureHeader(
            secret,
            Math.floor(Date.now() / 1000),
            b,
          ),
        },
      });
    expect((await trigger('{"n":1}')).status).toBe(202);
    await vi.waitFor(() =>
      expect(lines.some((l) => l.startsWith('Imported 2 new'))).toBe(true),
    );
    stub.report = {
      ...stub.report,
      counts: { create: 0, update: 0, skip: 2, refuse: 0 },
    };
    expect((await trigger('{"n":2}')).status).toBe(202);
    await vi.waitFor(() =>
      expect(lines).toContain('Nothing new: 2 items unchanged.'),
    );
    stop.abort();
    expect(await done).toBe(0);
    expect(lines[0]).toMatch(
      /^Listening for triggers on http:\/\/127\.0\.0\.1:\d+\/trigger\.$/,
    );
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(SESSION);
  });

  it('with a schedule too, stops at once on a signal: the listener closes and a waiting run is dropped', async () => {
    const stub = new StubApi();
    const stop = new AbortController();
    const lines: string[] = [];
    const secret = 'w'.repeat(40);
    let listening: (port: number) => void = () => undefined;
    const port = new Promise<number>((r) => (listening = r));
    const done = runCli(
      [
        ...['--mapping', MAPPING, '--items', ITEMS],
        ...['--every', '60', '--listen', '127.0.0.1:0'],
      ],
      { ...env(), CCMS_CONNECTOR_WEBHOOK_SECRET: secret },
      { out: (l) => lines.push(l), err: (l) => lines.push(l) },
      {
        fetch: stub.fetch,
        pollMs: 1,
        signal: stop.signal,
        onListening: (a) => listening(a.port),
        // The next scheduled run is due at once: it waits for its gap.
        sleep: async () => undefined,
      },
    );
    const url = `http://127.0.0.1:${await port}/trigger`;
    await vi.waitFor(() =>
      expect(lines.some((l) => l.startsWith('Imported 2 new'))).toBe(true),
    );
    // A trigger folds into the run waiting for its gap.
    const res = await fetch(url, {
      method: 'POST',
      body: '{}',
      headers: {
        [TRIGGER_SIGNATURE_HEADER]: triggerSignatureHeader(
          secret,
          Math.floor(Date.now() / 1000),
          '{}',
        ),
      },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run: 'already-queued' });
    const started = Date.now();
    stop.abort();
    expect(await done).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(lines.filter((l) => l.startsWith('Imported'))).toHaveLength(1);
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('refuses --listen without a long enough secret, or with a bad address', async () => {
    const err: string[] = [];
    const io = { out: () => undefined, err: (l: string) => err.push(l) };
    const args = ['--mapping', MAPPING, '--items', ITEMS, '--listen'];
    expect(await runCli([...args, '8080'], env(), io)).toBe(2);
    expect(
      await runCli(
        [...args, '8080'],
        { ...env(), CCMS_CONNECTOR_WEBHOOK_SECRET: 'short' },
        io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        [...args, 'nowhere:port'],
        { ...env(), CCMS_CONNECTOR_WEBHOOK_SECRET: 'w'.repeat(40) },
        io,
      ),
    ).toBe(2);
    expect(err.join('\n')).toMatch(
      /CCMS_CONNECTOR_WEBHOOK_SECRET[\s\S]*CCMS_CONNECTOR_WEBHOOK_SECRET[\s\S]*--listen is a port/,
    );
  });

  it('refuses a missing setting, a plain-http remote API and a bad schedule', async () => {
    const err: string[] = [];
    const io = { out: () => undefined, err: (l: string) => err.push(l) };
    expect(await runCli(['--mapping', MAPPING, '--items', ITEMS], {}, io)).toBe(
      2,
    );
    expect(
      await runCli(
        ['--mapping', MAPPING, '--items', ITEMS],
        { ...env(), CCMS_CONNECTOR_API_URL: 'http://openfolia.example.com' },
        io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        ['--mapping', MAPPING, '--items', ITEMS, '--every', '0'],
        env(),
        io,
      ),
    ).toBe(2);
    expect(err.join('\n')).toMatch(
      /CCMS_CONNECTOR_API_URL[\s\S]*https[\s\S]*--every/,
    );
  });
});

describe('the session file', () => {
  it('gives the session cookie of a curl cookie file, unless it expired', () => {
    const host = 'openfolia.example.com';
    expect(readSessionCookie(COOKIES, host)).toBe(SESSION);
    const expired = COOKIES.replace('\t0\t', '\t1000\t');
    expect(readSessionCookie(expired, host, 2_000_000)).toBeUndefined();
    // An expired line is passed over for a current one after it.
    expect(
      readSessionCookie(expired + COOKIES.split('\n')[1], host, 2_000_000),
    ).toBe(SESSION);
    expect(readSessionCookie('# nothing\n', host)).toBeUndefined();
    for (const [domain, urlHost] of [
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['::1', '[::1]'],
    ]) {
      const local = COOKIES.replace('openfolia.example.com', domain as string);
      expect(readSessionCookie(local, urlHost as string)).toBe(SESSION);
    }
    // Another deployment's session is never sent to this one.
    expect(readSessionCookie(COOKIES, 'staging.example.com')).toBeUndefined();
    // A value that could smuggle another header is no session.
    expect(
      readSessionCookie(COOKIES.replace(SESSION, 'a;b'), host),
    ).toBeUndefined();
  });

  it('is refused when others can read it, and a run without a session says to sign in again', async () => {
    const err: string[] = [];
    const io = { out: () => undefined, err: (l: string) => err.push(l) };
    const open = join(sessionDir, 'open.txt');
    writeFileSync(open, COOKIES);
    chmodSync(open, 0o644);
    expect(
      await runCli(
        ['--mapping', MAPPING, '--items', ITEMS],
        { ...env(), CCMS_CONNECTOR_SESSION_FILE: open },
        io,
      ),
    ).toBe(2);
    expect(err.pop()).toMatch(/readable by others/);
    const none = join(sessionDir, 'none.txt');
    writeFileSync(none, '# Netscape HTTP Cookie File\n', { mode: 0o600 });
    const stub = new StubApi();
    expect(
      await runCli(
        ['--mapping', MAPPING, '--items', ITEMS],
        { ...env(), CCMS_CONNECTOR_SESSION_FILE: none },
        io,
        { fetch: stub.fetch },
      ),
    ).toBe(1);
    expect(err.pop()).toMatch(/sign in again/);
    expect(stub.calls).toEqual([]);
  });
});

describe('the fixture source', () => {
  it('refuses a file of another shape, naming the field', async () => {
    await expect(
      new FixtureSource(join(FIXTURES, 'openfolia.json')).items(),
    ).rejects.toThrow();
    await expect(
      new FixtureSource(join(FIXTURES, 'bad-items.json')).items(),
    ).rejects.toThrow(/items\.0\.title/);
  });
});
