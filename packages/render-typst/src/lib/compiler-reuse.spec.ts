import {
  closeWorkerPool,
  compilePagePngInWorker,
  compilePdf,
  compilePdfInWorker,
  configureWorkerPool,
  TypstCompileError,
  type CompileInput,
} from './compile.js';
import { repositoryTemplate, templateProbe } from './own-template.js';
import { renderTypst } from './render.js';
import { themeFont } from '../testing/fonts.js';

// The pool's worker keeps one compiler from job to job (#436). One worker that is never
// replaced in this file, so every job below runs in the same process, on the compiler the job
// before it left (a job that failed drops it: each case runs a job that ends well first). That
// a compiler is in fact reused is asserted in `compiler-cache.spec.ts` (`CompilerCache.created`).

const SLOW = { timeout: 120_000 };
beforeAll(() => configureWorkerPool({ size: 1, jobsPerWorker: 1000 }));
afterAll(() => closeWorkerPool());

const encode = (text: string) => new TextEncoder().encode(text);
const doc = (body: string) =>
  `#set document(title: "T")\n#set text(lang: "en")\n= Title\n${body}`;
const IMAGE = encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#9fb8cf"/></svg>',
);

/** The messages a compilation failed with; fails the test if it compiled. */
async function failure(input: CompileInput): Promise<string> {
  const error: unknown = await compilePdfInWorker(input).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TypstCompileError);
  return (error as TypstCompileError).diagnostics
    .map((d) => (d as { message: string }).message)
    .join('\n');
}

const OTHER_IMAGE = encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><circle cx="5" cy="5" r="5" fill="#b45309"/></svg>',
);

const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';

describe('one compiler per worker (#436): a job reads only its own files', () => {
  it(
    "finds no image or symbol of the job before (the same path is 'file not found')",
    SLOW,
    async () => {
      for (const path of ['assets/photo.svg', 'symbols/W001.svg']) {
        const uses = doc(`#image("/${path}", alt: "Picture")`);
        // As an image, and as raw bytes.
        for (const reads of [uses, doc(`#read("/${path}")`)]) {
          expect(
            isPdf(
              await compilePdfInWorker({
                source: uses,
                files: { [path]: IMAGE },
              }),
            ),
          ).toBe(true);
          const found = await failure({ source: reads });
          expect(found).toContain('file not found');
          expect(found).toContain(path);
        }
      }
      // Nor through a page image.
      await compilePdfInWorker({
        source: doc('page'),
        files: { 'assets/photo.svg': IMAGE },
      });
      await expect(
        compilePagePngInWorker(
          { source: doc('#image("/assets/photo.svg", alt: "Picture")') },
          { number: 1, width: 100 },
        ),
      ).rejects.toBeInstanceOf(TypstCompileError);
    },
  );

  it(
    "keeps one product's own template from another's: templates/<id>/ of the job before is gone",
    SLOW,
    async () => {
      const manual = templateProbe();
      const product = (id: string, manualTyp: string) => {
        const own = repositoryTemplate(id, {
          'manual.typ': encode(
            // The default template, as a repository's own would copy it.
            `#import "/template.typ": *\n${manualTyp}\n`,
          ),
          'secret.txt': encode(`${id}'s own file`),
        });
        return {
          source: renderTypst(manual, { templatePath: own.templatePath })
            .source,
          files: own.files,
        };
      };
      // Product one: its template reads its own file.
      const one = product('one', '#let own = read("secret.txt")');
      expect(isPdf(await compilePdfInWorker(one))).toBe(true);
      // Product two, next on the same compiler: one's folder is not there, by any path.
      for (const read of [
        'read("/templates/one/secret.txt")',
        'read("../one/secret.txt")',
        'read("/templates/one/manual.typ")',
      ]) {
        expect(isPdf(await compilePdfInWorker(one))).toBe(true);
        const found = await failure(product('two', `#let leaked = ${read}`));
        expect(found).toContain('file not found');
        expect(found).toContain('templates/one/');
      }
      // Nor can the document import one's template once one is done.
      expect(isPdf(await compilePdfInWorker(one))).toBe(true);
      const imports = renderTypst(manual, {
        templatePath: '/templates/one/manual.typ',
      }).source;
      expect(await failure({ source: imports })).toContain('file not found');
      // Two's own file is still read: what fails above is the other template's.
      expect(
        isPdf(
          await compilePdfInWorker(
            product('two', '#let own = read("/templates/two/secret.txt")'),
          ),
        ),
      ).toBe(true);
    },
  );

  it(
    'never gives a job the fonts or inputs of the job before',
    SLOW,
    async () => {
      // Geist Mono as "Isolated": in it, four i are as wide as four m. Without it, the text
      // falls back to a proportional font and the assertion fails.
      const font = {
        data: themeFont('ttf/GeistMono-Regular.ttf'),
        family: 'Isolated',
      };
      const usesFont = doc(
        '#context assert(measure(text(font: "Isolated")[iiii]).width == measure(text(font: "Isolated")[mmmm]).width, message: "no Isolated font")',
      );
      expect(
        isPdf(await compilePdfInWorker({ source: usesFont, fonts: [font] })),
      ).toBe(true);
      expect(await failure({ source: usesFont })).toContain('no Isolated font');

      const secret = { 'openfolia-design': '{"secret":"job A"}' };
      expect(
        isPdf(
          await compilePdfInWorker({
            source: doc('#assert("openfolia-design" in sys.inputs)'),
            inputs: secret,
          }),
        ),
      ).toBe(true);
      expect(
        isPdf(
          await compilePdfInWorker({
            source: doc('#if sys.inputs.len() > 0 { panic(repr(sys.inputs)) }'),
          }),
        ),
      ).toBe(true);
    },
  );
});

describe('one compiler per worker (#436): the same input, the same bytes (#328)', () => {
  it(
    'gives the bytes of a compiler of its own after other jobs ran on the worker',
    SLOW,
    async () => {
      const input: CompileInput = {
        source: doc(
          '#outline()\n= One\n#lorem(150)\n#image("/assets/a.svg", alt: "A")\n= Two\n#lorem(250)',
        ),
        files: { 'assets/a.svg': IMAGE },
        creationTimestamp: 1_700_000_000,
      };
      // A one-off compilation: a new process, a new compiler.
      const fresh = compilePdf(input);
      const first = await compilePdfInWorker(input);
      for (let i = 0; i < 5; i++) {
        await compilePdfInWorker({
          source: doc(
            `= Other ${i}\n#lorem(${100 * (i + 1)})\n#image("/assets/a.svg", alt: "Other")`,
          ),
          files: { 'assets/a.svg': OTHER_IMAGE, 'x.txt': encode(String(i)) },
          inputs: { other: String(i) },
          creationTimestamp: 1_600_000_000 + i,
        });
      }
      const after = await compilePdfInWorker(input);
      expect(first.equals(fresh)).toBe(true);
      expect(after.equals(fresh)).toBe(true);
    },
  );
});
