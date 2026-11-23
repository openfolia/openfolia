import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompilerCache,
  compilerKey,
  createWorkspace,
  WORKER_ARG,
  WORKER_URL,
  type CoreInput,
  type CoreResult,
  type WorkerResponse,
} from './compile-core.js';
import { childOptions } from './compile.js';
import { themeFont } from '../testing/fonts.js';

// One compiler reused from job to job (#436), in this process: what one job leaves must never
// reach the next. The pool's workers run the same `CompilerCache` (`compiler-reuse.spec.ts`).

const SLOW = { timeout: 60_000 };
const encode = (text: string) => new TextEncoder().encode(text);

const workspaces: string[] = [];
afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});
function workspace(): string {
  const path = createWorkspace();
  workspaces.push(path);
  return path;
}

const SVG = encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1f4e79"/></svg>',
);

function input(source: string, more: Partial<CoreInput> = {}): CoreInput {
  return {
    source: `#set document(title: "T", date: none)\n#set text(lang: "en")\n${source}`,
    template: '',
    files: {},
    fonts: [],
    fontDirs: [],
    tokens: '',
    standard: 'none',
    creationTimestamp: 1_700_000_000,
    ...more,
  };
}

/** The messages of a compilation that failed with diagnostics; fails the test for any other result. */
function messages(result: CoreResult): string[] {
  expect(result.ok).toBe(false);
  expect(result).toHaveProperty('diagnostics');
  return (result as { diagnostics: { message: string }[] }).diagnostics.map(
    (d) => d.message,
  );
}

function pdf(result: CoreResult): Buffer {
  expect(result).toMatchObject({ ok: true });
  return Buffer.from((result as { data: Uint8Array }).data);
}

describe('a compiler reused from job to job (#436)', () => {
  it('serves jobs that end well on one compiler', SLOW, () => {
    const cache = new CompilerCache();
    const ws = workspace();
    for (let i = 0; i < 3; i++) pdf(cache.compile(input(`= Job ${i}`), ws));
    expect(cache.created).toBe(1);
  });

  it(
    "never lets a job read the previous job's files, sources or images",
    SLOW,
    () => {
      const cache = new CompilerCache();
      const ws = workspace();
      const files = {
        'assets/a.svg': SVG,
        'symbols/w001.svg': SVG,
        'templates/one/parts.typ': encode('#let part = "from job A"'),
        'notes.txt': encode('job A only'),
      };
      const jobA = input(
        [
          '#image("/assets/a.svg", alt: "A")',
          '#image("/symbols/w001.svg", alt: "W")',
          '#import "/templates/one/parts.typ": part',
          '#part #read("/notes.txt")',
        ].join('\n'),
        { files },
      );
      for (const [read, path] of [
        ['#image("/assets/a.svg", alt: "A")', 'assets/a.svg'],
        ['#image("/symbols/w001.svg", alt: "W")', 'symbols/w001.svg'],
        ['#import "/templates/one/parts.typ": part', 'templates/one/parts.typ'],
        ['#read("/notes.txt")', 'notes.txt'],
      ] as const) {
        pdf(cache.compile(jobA, ws));
        const made = cache.created;
        // On the compiler job A ran on (it ended well), the same path is not there any more.
        const found = messages(cache.compile(input(read), ws)).join('\n');
        expect(cache.created).toBe(made);
        expect(found).toContain('file not found');
        expect(found).toContain(path);
      }
    },
  );

  it('maps the same path anew for each job', SLOW, () => {
    const cache = new CompilerCache();
    const ws = workspace();
    const reads = (text: string) =>
      input(
        '#let t = read("/data.txt")\n#if t != sys.inputs.expected { panic("read " + t) }\nok',
        {
          files: { 'data.txt': encode(text) },
          inputs: { expected: text },
        },
      );
    pdf(cache.compile(reads('first'), ws));
    pdf(cache.compile(reads('second'), ws));
    pdf(cache.compile(reads('first'), ws));
    expect(cache.created).toBe(1);
  });

  it("never gives a job the previous job's inputs", SLOW, () => {
    const cache = new CompilerCache();
    const ws = workspace();
    pdf(
      cache.compile(
        input('#assert("secret" in sys.inputs)\nwith inputs', {
          inputs: { secret: 'job A', 'openfolia-design': '{}' },
        }),
        ws,
      ),
    );
    pdf(
      cache.compile(
        input(
          '#if sys.inputs.len() > 0 { panic(repr(sys.inputs)) }\nwithout inputs',
        ),
        ws,
      ),
    );
    expect(cache.created).toBe(1);
  });

  it(
    'drops the compiler after a job that failed, and makes a new one',
    SLOW,
    () => {
      const cache = new CompilerCache();
      const ws = workspace();
      pdf(cache.compile(input('= Fine'), ws));
      messages(cache.compile(input('#panic("broken template")'), ws));
      expect(cache.created).toBe(1);
      pdf(cache.compile(input('= Fine again'), ws));
      expect(cache.created).toBe(2);
      // A refused export is a failed job too.
      expect(
        cache.compile(
          input('#image("/a.svg")', {
            files: { 'a.svg': SVG },
            standard: 'ua-1',
          }),
          ws,
        ),
      ).toMatchObject({ ok: false, accessibility: expect.any(Array) });
      pdf(cache.compile(input('= And again'), ws));
      expect(cache.created).toBe(3);
    },
  );

  it(
    'keeps a compiler for one font set and workspace, and makes a new one for another',
    SLOW,
    () => {
      const cache = new CompilerCache();
      const ws = workspace();
      const font = { data: themeFont('ttf/Geist-Regular.ttf'), family: 'One' };
      const usesFont = (fonts: CoreInput['fonts']) =>
        input('#text(font: "One")[With a font]', { fonts });
      pdf(cache.compile(usesFont([font]), ws));
      pdf(cache.compile(usesFont([font]), ws));
      expect(cache.created).toBe(1);
      pdf(cache.compile(usesFont([{ ...font, family: 'Two' }]), ws));
      expect(cache.created).toBe(2);
      pdf(cache.compile(usesFont([]), ws));
      expect(cache.created).toBe(3);
      pdf(cache.compile(usesFont([]), workspace()));
      expect(cache.created).toBe(4);
    },
  );

  it('keys a compiler by every font byte, family and directory', () => {
    const ws = '/w';
    const a = encode('font a');
    const key = (more: Partial<CoreInput>, at = ws) =>
      compilerKey(input('', more), at);
    const keys = [
      key({}),
      key({}, '/other'),
      key({ fonts: [a] }),
      key({ fonts: [encode('font b')] }),
      key({ fonts: [{ data: a, family: 'X' }] }),
      key({ fonts: [{ data: a, family: 'Y' }] }),
      key({ fonts: [a, a] }),
      key({ fontDirs: ['/fonts'] }),
      key({ fontDirs: ['/fonts', '/more'] }),
      // A different split of the same characters.
      key({ fontDirs: ['/fonts/', 'more'] }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(key({ fonts: [encode('font a')] })).toBe(key({ fonts: [a] }));
  });

  it(
    'gives the same bytes after other jobs as a new compiler gives (#328)',
    SLOW,
    () => {
      const ws = workspace();
      const manual = input(
        '#outline()\n= One\n#lorem(200)\n#image("/assets/a.svg", alt: "A")\n= Two\n#lorem(300)',
        { files: { 'assets/a.svg': SVG } },
      );
      const fresh = pdf(new CompilerCache().compile(manual, ws));
      const cache = new CompilerCache();
      pdf(cache.compile(manual, ws));
      for (let i = 0; i < 4; i++) {
        pdf(
          cache.compile(
            input(`= Other ${i}\n#lorem(${100 * (i + 1)})\n#read("/x.txt")`, {
              files: { 'x.txt': encode(`other ${i}`) },
              inputs: { other: String(i) },
            }),
            ws,
          ),
        );
      }
      expect(pdf(cache.compile(manual, ws)).equals(fresh)).toBe(true);
      expect(cache.created).toBe(1);
    },
  );

  it(
    'keeps the compiler after asking for a page the document does not have',
    SLOW,
    () => {
      const cache = new CompilerCache();
      const ws = workspace();
      expect(
        cache.compile(
          input('= One page', { page: { number: 5, width: 100 } }),
          ws,
        ),
      ).toEqual({ ok: false, pages: 1 });
      pdf(cache.compile(input('= Next'), ws));
      expect(cache.created).toBe(1);
    },
  );

  it(
    'drops the compiler after a job that threw, and makes a new one',
    SLOW,
    () => {
      const cache = new CompilerCache();
      const ws = workspace();
      pdf(cache.compile(input('= Fine'), ws));
      // A path that leaves the root throws while the files are mapped: not a Typst error.
      expect(() =>
        cache.compile(input('= Thrown', { files: { '../x.txt': SVG } }), ws),
      ).toThrow(/invalid file path/);
      pdf(cache.compile(input('= Fine again'), ws));
      expect(cache.created).toBe(2);
    },
  );
});

describe('a pool worker (#436)', () => {
  it(
    'counts its compilers in every answer, one that failed internally too',
    SLOW,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'openfolia-typst-pool-'));
      workspaces.push(root);
      const worker = fork(
        fileURLToPath(WORKER_URL),
        [WORKER_ARG, root, createWorkspace(root), '0'],
        {
          ...childOptions(root),
          execArgv: [],
          serialization: 'advanced',
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        },
      );
      const answer = () =>
        new Promise<WorkerResponse>((resolve) =>
          worker.once('message', (m: WorkerResponse) => {
            resolve(m);
          }),
        );
      try {
        const ask = (id: number, job: CoreInput) => {
          const next = answer();
          worker.send({ id, input: job });
          return next;
        };
        // Each throws while its files are mapped, each on a compiler of its own.
        for (let id = 1; id <= 3; id++) {
          const reply = await ask(
            id,
            input('= Thrown', { files: { '../x.txt': SVG } }),
          );
          expect(reply).toMatchObject({
            type: 'result',
            id,
            result: { ok: false, internal: expect.any(String) },
            compilers: id,
          });
        }
        // A job that ends well makes a fourth; the next reuses it.
        expect(await ask(4, input('= Fine'))).toMatchObject({
          result: { ok: true },
          compilers: 4,
        });
        expect(await ask(5, input('= Fine again'))).toMatchObject({
          result: { ok: true },
          compilers: 4,
        });
      } finally {
        worker.kill('SIGKILL');
      }
    },
  );
});
