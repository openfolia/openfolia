import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_REFUSED } from './compile-core.js';
import {
  BLOCKED_PROXY,
  childOptions,
  closeWorkerPool,
  compilePdf,
  compilePdfInWorker,
  TypstCompileError,
} from './compile.js';

/** Each case starts compiling processes, which a loaded machine makes slow. */
const SLOW = { timeout: 60_000 };

/**
 * A host whose package cache and data directories (macOS and Linux) hold
 * a package `planted`, as the compiler would find it outside the sandbox:
 * the test process's own home is pointed there.
 */
const host = mkdtempSync(join(tmpdir(), 'openfolia-sandbox-test-'));
const packageDirs = [
  'Library/Caches/typst/packages/preview',
  'Library/Application Support/typst/packages/local',
  '.cache/typst/packages/preview',
  '.local/share/typst/packages/local',
];
for (const dir of packageDirs) {
  const at = join(host, dir, 'planted', '0.1.0');
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, 'typst.toml'),
    '[package]\nname = "planted"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n',
  );
  writeFileSync(join(at, 'lib.typ'), '#let planted = "read from the host"\n');
}
const saved = {
  HOME: process.env['HOME'],
  XDG_CACHE_HOME: process.env['XDG_CACHE_HOME'],
  XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
};
process.env['HOME'] = host;
delete process.env['XDG_CACHE_HOME'];
delete process.env['XDG_DATA_HOME'];
afterAll(async () => {
  await closeWorkerPool();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(host, { recursive: true, force: true });
});

const doc = (body: string) =>
  `#set document(title: "T")\n#set text(lang: "en")\n= Title\n${body}`;
const IMPORTS = [
  '#import "@preview/planted:0.1.0": planted\n#planted',
  '#import "@local/planted:0.1.0": planted\n#planted',
  // Built at run time: no scan of the source could see it.
  '#import ("@pre" + "view/planted:0.1.0"): planted\n#planted',
  // Not on the host: the compiler would download it from the registry. With
  // the network up, this fails only through BLOCKED_PROXY; offline it fails
  // either way (the environment test below holds the proxy then).
  '#import "@preview/example:0.1.0": *',
];

/** The diagnostics a compilation failed with; fails the test if it succeeded. */
async function diagnostics(run: () => Promise<unknown>): Promise<unknown[]> {
  const error: unknown = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TypstCompileError);
  return (error as TypstCompileError).diagnostics;
}

const messages = (list: unknown[]) =>
  list.map((d) => (d as { message: string }).message);

describe('the compiler sandbox', () => {
  it('finds the planted package without the sandbox, so the tests below mean something', () => {
    // The compiler in this process reads this process's home, as the
    // server's own process would.
    const require = createRequire(import.meta.url);
    const { NodeCompiler } =
      require('@myriaddreamin/typst-ts-node-compiler') as {
        NodeCompiler: typeof import('@myriaddreamin/typst-ts-node-compiler').NodeCompiler;
      };
    const workspace = mkdtempSync(join(tmpdir(), 'openfolia-sandbox-control-'));
    try {
      const compiler = NodeCompiler.create({ workspace });
      compiler.addSource(
        join(workspace, 'main.typ'),
        '#import "@preview/planted:0.1.0": planted\n#planted',
      );
      const result = compiler.compile({
        mainFilePath: join(workspace, 'main.typ'),
      });
      expect(result.takeError()).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each(IMPORTS)(
    'refuses a package import in the document, in a worker and on the calling thread: %s',
    SLOW,
    async (body) => {
      for (const run of [
        () => compilePdfInWorker({ source: doc(body) }),
        async () => compilePdf({ source: doc(body) }),
      ]) {
        expect(messages(await diagnostics(run))).toContain(PACKAGE_REFUSED);
      }
    },
  );

  it('refuses a package import in a custom template', SLOW, async () => {
    const template = [
      '#import "@preview/planted:0.1.0": planted',
      '#let manual(..args, body) = [#planted #body]',
    ].join('\n');
    const source = doc('').replace(
      '= Title',
      '#import "template.typ": *\n#show: manual\n= Title',
    );
    for (const run of [
      () => compilePdfInWorker({ source, template }),
      async () => compilePdf({ source, template }),
    ]) {
      const found = await diagnostics(run);
      expect(messages(found)).toContain(PACKAGE_REFUSED);
      expect(found).toContainEqual(
        expect.objectContaining({ path: '/template.typ' }),
      );
    }
  });

  it('gives the compiler an empty home and no network, and nothing of the server', () => {
    process.env['CCMS_SANDBOX_CANARY'] = 'secret';
    process.env['NO_PROXY'] = '*';
    process.env['NODE_OPTIONS'] = '--require=/planted.js';
    let options: ReturnType<typeof childOptions>;
    try {
      options = childOptions('/pool');
    } finally {
      delete process.env['CCMS_SANDBOX_CANARY'];
      delete process.env['NO_PROXY'];
      delete process.env['NODE_OPTIONS'];
    }
    const { env, cwd } = options;
    expect(cwd).toBe('/pool');
    expect(env).toMatchObject({
      HOME: '/pool/home',
      XDG_CACHE_HOME: '/pool/home/.cache',
      XDG_DATA_HOME: '/pool/home/.local/share',
      HTTPS_PROXY: BLOCKED_PROXY,
      https_proxy: BLOCKED_PROXY,
      HTTP_PROXY: BLOCKED_PROXY,
      ALL_PROXY: BLOCKED_PROXY,
    });
    expect(BLOCKED_PROXY).toBe('http://127.0.0.1:0');
    const allowed = /^(HOME|XDG_\w+|(HTTPS?|ALL)_PROXY|TZ|SystemRoot)$/i;
    for (const name of Object.keys(env)) expect(name).toMatch(allowed);
  });

  it(
    'names files from the project root in diagnostics, never by the server path',
    SLOW,
    async () => {
      for (const run of [
        () => compilePdfInWorker({ source: doc('#image("missing.png")') }),
        async () => compilePdf({ source: doc('#image("missing.png")') }),
      ]) {
        const found = await diagnostics(run);
        expect(found).toContainEqual(
          expect.objectContaining({
            path: '/main.typ',
            message: 'file not found (searched at /missing.png)',
          }),
        );
        const text = JSON.stringify(found);
        expect(text).not.toContain(tmpdir());
        expect(text).not.toContain('openfolia-typst-');
      }
    },
  );
});
