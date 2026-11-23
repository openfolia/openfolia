import {
  Manifest,
  parsePageDesign,
  ProjectConfig,
  resolvePageDesign,
  type ResolvedManual,
  type ResolvedPageDesign,
} from '@openfolia/content-model';
import {
  closeWorkerPool,
  compilePagePngInWorker,
  compilePdf,
  compilePdfReport,
  compilePdfReportInWorker,
  configureWorkerPool,
  type CompileInput,
  TypstCompileError,
  TypstMemoryError,
  TypstPageNotFoundError,
  TypstTimeoutError,
} from './compile.js';
import { PACKAGE_REFUSED } from './compile-core.js';
import { designTemplate } from './design.js';
import {
  EXAMPLE_TEMPLATE,
  exampleTemplateFiles,
  repositoryTemplate,
  SAMPLE_BROKEN_LINE,
  SAMPLE_TEMPLATES,
  TemplateFolderError,
  templateProbe,
  templateProblems,
} from './own-template.js';
import { renderTypst } from './render.js';

/** Each case starts compiling processes, which a loaded machine makes slow. */
const SLOW = { timeout: 120_000 };

// A pool of its own, with a memory limit low enough to reach quickly and far above a worker's.
const MEMORY_LIMIT_MB = 640;
beforeAll(() =>
  configureWorkerPool({ size: 2, memoryLimitMb: MEMORY_LIMIT_MB }),
);
afterAll(() => closeWorkerPool());

const encode = (text: string) => new TextEncoder().encode(text);

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: [] },
  moduleTypes: [{ id: 'probe', label: 'Probe' }],
  audiences: [{ id: 'all', label: 'All' }],
  manufacturer: {
    name: 'Example Works Ltd',
    address: ['1 Sample Street', '12345 Sample Town'],
    website: 'https://example.com',
  },
});

const LOGO = 'sha256:' + '1'.repeat(64);
const COVER = 'sha256:' + '2'.repeat(64);
const ASSETS: Record<string, Uint8Array> = {
  [`assets/${'1'.repeat(64)}`]: encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="40" height="40" rx="8" fill="#1f4e79"/></svg>',
  ),
  [`assets/${'2'.repeat(64)}`]: encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#9fb8cf"/><circle cx="300" cy="90" r="50" fill="#f2d16b"/></svg>',
  ),
};

/** A classic design with every part on: logo, cover image, regions, running head, back page. */
const DESIGN = `schemaVersion: 1
name: Test design
preset: classic
page:
  doubleSided: true
colours:
  primary: "#1f4e79"
  accent: "#b45309"
  text: "#1f2328"
logo:
  light: ${LOGO}
titlePage:
  fields: [title, subtitle, variant, language, release, date]
regions:
  above-title: |-
    [#intro]
    Original instructions
  below-fields: |-
    [#numbers]
    Document placeholder:title[]
  footer: |-
    [#keep]
    Keep this manual with the product.
  back: |-
    [#imprint]
    The imprint.
coverImage:
  default:
    asset: ${COVER}
    alt: The product
backPage:
  copyright: © Example Works.
  date: true
header:
  default:
    left: placeholder:title[]
    right: placeholder:chapter[]
footer:
  default:
    right: Page placeholder:page[] of placeholder:page-count[]
`;

function designFor(manual: ResolvedManual, yaml = DESIGN): ResolvedPageDesign {
  return resolvePageDesign({
    design: parsePageDesign(yaml, { id: 'test' }),
    manifest: Manifest.parse({
      schemaVersion: 1,
      id: 'template-check',
      title: manual.title,
      variants: [{}],
      entries: [{ module: 'probe' }],
    }),
    variant: {},
    lang: manual.lang,
    config,
    release: '2.3.0',
    date: '2026-11-20',
  }).design;
}

/** The probe laid out with the design: by the preset, or by a repository template. */
function compileInput(
  own?: { id: string; files: Record<string, Uint8Array> },
  manual = templateProbe(),
): CompileInput {
  const design = designFor(manual);
  const template = own && repositoryTemplate(own.id, own.files);
  const { source, inputs } = renderTypst(manual, {
    design,
    ...(template && { templatePath: template.templatePath }),
  });
  return {
    source,
    inputs,
    files: { ...ASSETS, ...template?.files },
    ...(!template && { template: designTemplate(design.preset) }),
    creationTimestamp: 1_700_000_000,
  };
}

/** Every page of a compilation as PNG, in order. */
async function pages(compile: CompileInput, width = 600): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (let number = 1; ; number++) {
    try {
      out.push(await compilePagePngInWorker(compile, { number, width }));
    } catch (e) {
      if (e instanceof TypstPageNotFoundError) return out;
      throw e;
    }
  }
}

/** A template whose `manual.typ` is the example's with `body` added at its end. */
function exampleWith(body: string, more: Record<string, string> = {}) {
  const files = exampleTemplateFiles();
  files['manual.typ'] = encode(`${EXAMPLE_TEMPLATE['manual.typ']}\n${body}\n`);
  for (const [path, text] of Object.entries(more)) files[path] = encode(text);
  return { id: 'house', files };
}

/** The problems a compilation failed with; fails the test if it compiled. */
async function problemsOf(compile: CompileInput) {
  const error: unknown = await compilePdfReportInWorker(compile).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TypstCompileError);
  return templateProblems((error as TypstCompileError).diagnostics);
}

describe('an own template (#396)', () => {
  it(
    'renders, as the example template, a manual identical to the classic preset: every page, pixel by pixel',
    SLOW,
    async () => {
      const preset = compileInput();
      const own = compileInput({ id: 'house', files: exampleTemplateFiles() });
      expect(own.source).toContain('#import "/templates/house/manual.typ": *');
      const [presetPages, ownPages] = [await pages(preset), await pages(own)];
      // Title page, back of it, contents, body, back page: several pages, so the layout counts.
      expect(presetPages.length).toBeGreaterThanOrEqual(4);
      expect(ownPages.length).toBe(presetPages.length);
      ownPages.forEach((png, i) => {
        expect(png.equals(presetPages[i] as Buffer), `page ${i + 1}`).toBe(
          true,
        );
      });
      // And the PDFs read the same: same text, same structure, same layout warnings.
      const [a, b] = await Promise.all([
        compilePdfReportInWorker(preset),
        compilePdfReportInWorker(own),
      ]);
      expect(b.warnings).toEqual(a.warnings);
      expect(b.pdf.equals(a.pdf)).toBe(true);
    },
  );

  it('keeps the example on its own: no import of the compiler’s layer or default template', () => {
    const text = Object.values(EXAMPLE_TEMPLATE).join('\n');
    expect(text).not.toContain('/openfolia/design.typ');
    expect(text).not.toContain('/openfolia/default.typ');
    expect(Object.keys(EXAMPLE_TEMPLATE).sort()).toEqual([
      'default.typ',
      'design.typ',
      'manual.typ',
    ]);
  });

  it(
    'reads its own files: relative imports, an image in its folder',
    SLOW,
    async () => {
      const own = exampleWith(
        [
          '#import "parts/notice.typ": framed',
          '#let admonition(kind: "note", body) = framed(body)',
        ].join('\n'),
        {
          'parts/notice.typ': [
            '#let framed(body) = block(stroke: 1pt, inset: 6pt, {',
            '  image("../mark.svg", height: 8pt, alt: "Mark")',
            '  body',
            '})',
          ].join('\n'),
          'mark.svg':
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
        },
      );
      const { pdf } = await compilePdfReportInWorker(compileInput(own));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    },
  );

  it.each([
    ['an absolute host path', '#read("/etc/passwd")', 'file not found'],
    [
      'a path above the project',
      '#read("../../../../etc/passwd")',
      'access denied',
    ],
    [
      'the host through an image',
      '#image("/etc/hosts", alt: "x")',
      'file not found',
    ],
    [
      'another template’s folder',
      '#read("/templates/other/manual.typ")',
      'file not found',
    ],
    [
      'a module of the repository',
      '#read("/modules/en/probe.adoc")',
      'file not found',
    ],
    ['the configuration', '#read("/openfolia.yaml")', 'file not found'],
    ['the server’s home', '#read("/home/.ssh/id_rsa")', 'file not found'],
    ['a plugin from outside', '#plugin("/usr/lib/libc.so")', 'file not found'],
  ])(
    'cannot read %s: the compilation fails, with its file and line',
    SLOW,
    async (_what, code, message) => {
      const found = await problemsOf(compileInput(exampleWith(code)));
      expect(found[0]).toMatchObject({
        file: 'templates/house/manual.typ',
        line: EXAMPLE_TEMPLATE['manual.typ']!.split('\n').length + 1,
      });
      expect(found[0]?.message).toContain(message);
    },
  );

  it.each([
    '#import "@preview/example:0.1.0": *',
    '#import ("@pre" + "view/example:0.1.0"): *',
    '#import "@local/example:0.1.0": *',
  ])('cannot import a package: %s', SLOW, async (code) => {
    const found = await problemsOf(compileInput(exampleWith(code)));
    expect(found.map((p) => p.message)).toContain(PACKAGE_REFUSED);
    expect(found[0]?.file).toBe('templates/house/manual.typ');
  });

  it(
    'names the file and line of an error in a file it imports, and the calls that led there',
    SLOW,
    async () => {
      const own = exampleWith('#import "parts.typ": broken\n#broken()', {
        'parts.typ': '#let broken() = {\n  let a = 1\n  a.nope()\n}\n',
      });
      const [problem] = await problemsOf(compileInput(own));
      expect(problem).toMatchObject({
        file: 'templates/house/parts.typ',
        line: 3,
        column: 5,
        message: 'type integer has no method `nope`',
      });
      expect(problem?.trace[0]).toMatchObject({
        file: 'templates/house/manual.typ',
        message: 'while calling broken',
      });
      expect(JSON.stringify(problem)).not.toMatch(
        /openfolia-typst-|\/var\/|\/tmp\//,
      );
    },
  );

  it(
    'says what is missing when it lacks a function of the contract',
    SLOW,
    async () => {
      const own = {
        id: 'bare',
        files: { 'manual.typ': encode('#let manual(..args, body) = body\n') },
      };
      const problems = await problemsOf(compileInput(own));
      expect(problems[0]).toMatchObject({ file: 'main.typ' });
      expect(problems.map((p) => p.message).join('\n')).toMatch(
        /unknown variable: (safety|admonition|procedure|anchor|ui|code-span|kbd|xref)/,
      );
    },
  );

  it(
    'is stopped when it loops forever: the worker is killed at the timeout',
    SLOW,
    async () => {
      const own = exampleWith(
        '#for i in range(100000) { for j in range(100000) { } }',
      );
      const started = Date.now();
      await expect(
        compilePdfReportInWorker(compileInput(own), { timeoutMs: 3_000 }),
      ).rejects.toBeInstanceOf(TypstTimeoutError);
      expect(Date.now() - started).toBeLessThan(20_000);
      // The pool goes on: the next compilation gets a new worker.
      const { pdf } = await compilePdfReportInWorker(compileInput());
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    },
  );

  it('is stopped when it loops forever on the calling thread too', SLOW, () => {
    const own = exampleWith(
      '#for i in range(100000) { for j in range(100000) { } }',
    );
    expect(() => compilePdf(compileInput(own), { timeoutMs: 3_000 })).toThrow(
      TypstTimeoutError,
    );
  });

  it(
    'is stopped when it exhausts memory, in a worker and on the calling thread',
    SLOW,
    async () => {
      // About 3 GB of values: far past the limit, which stops it within a fraction of that.
      const own = exampleWith('#let all = range(100000000)\n#all.len()');
      const error: unknown = await compilePdfReportInWorker(compileInput(own), {
        timeoutMs: 60_000,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TypstMemoryError);
      expect((error as TypstMemoryError).limitMb).toBe(MEMORY_LIMIT_MB);
      expect(() =>
        compilePdfReport(compileInput(own), { memoryLimitMb: MEMORY_LIMIT_MB }),
      ).toThrow(TypstMemoryError);
      // The pool goes on.
      const { pdf } = await compilePdfReportInWorker(compileInput());
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    },
  );

  it('refuses a folder it cannot compile, before compiling', () => {
    const entry = { 'manual.typ': encode('#let manual(..a, body) = body') };
    expect(() => repositoryTemplate('../x', entry)).toThrow(
      TemplateFolderError,
    );
    expect(() => repositoryTemplate('house', {})).toThrow(/no manual\.typ/);
    expect(() =>
      repositoryTemplate('house', {
        ...entry,
        '../../openfolia.yaml': encode(''),
      }),
    ).toThrow(/outside its folder/);
    expect(() =>
      repositoryTemplate(
        'house',
        Object.fromEntries(
          Array.from({ length: 201 }, (_, i) => [`f${i}.typ`, encode('')]),
        ),
      ),
    ).toThrow(/more than 200/);
    expect(() =>
      repositoryTemplate('house', {
        ...entry,
        'big.bin': new Uint8Array(16 * 1024 * 1024 + 1),
      }),
    ).toThrow(/more than/);
    expect(repositoryTemplate('house', entry)).toEqual({
      templatePath: '/templates/house/manual.typ',
      files: { 'templates/house/manual.typ': entry['manual.typ'] },
    });
  });

  it(
    'sets code on its title page left to right in right-to-left text (#524)',
    SLOW,
    async () => {
      const arabic = { ...templateProbe('ar') };
      const own = exampleWith(
        [
          '#let manual = design-manual.with(title-page: (title, subtitle) => page({',
          '  show raw: it => { context assert(text.dir == ltr, message: "code set right to left"); it }',
          '  raw("a -> b")',
          '}))',
        ].join('\n'),
      );
      const { pdf } = await compilePdfReportInWorker({
        ...compileInput(own, arabic),
        standard: 'none',
      });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    },
  );

  it(
    'sets code in its header and footer left to right in right-to-left text (#396)',
    SLOW,
    async () => {
      const arabic = templateProbe('ar');
      // The template's own header and footer, each with code: on its title page, which comes
      // before the body (so before any rule after the template's), and on the body's pages.
      const own = exampleWith(
        [
          '#let ltr-code(where) = {',
          '  show raw: it => { context assert(text.dir == ltr, message: "code set right to left in the " + where); it }',
          '  raw("a -> b")',
          '}',
          '#let manual(title: none, subtitle: none, lang: "en", body) = design-manual(',
          '  title-page: (title, subtitle) => page(',
          '    header: ltr-code("title page header"),',
          '    footer: ltr-code("title page footer"),',
          '    title,',
          '  ),',
          '  title: title, subtitle: subtitle, lang: lang, {',
          '    set page(header: ltr-code("header"), footer: ltr-code("footer"))',
          '    body',
          '  })',
        ].join('\n'),
      );
      const { pdf } = await compilePdfReportInWorker({
        ...compileInput(own, arabic),
        standard: 'none',
      });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    },
  );
});

describe('the sample templates', () => {
  it(
    'compile as the example, and the broken one fails at its last line',
    SLOW,
    async () => {
      const files = (id: 'example' | 'broken') => ({
        id,
        files: Object.fromEntries(
          Object.entries(SAMPLE_TEMPLATES[id]).map(([p, t]) => [p, encode(t)]),
        ),
      });
      await compilePdfReportInWorker(compileInput(files('example')));
      const [problem] = await problemsOf(compileInput(files('broken')));
      expect(problem).toMatchObject({
        file: 'templates/broken/manual.typ',
        line: SAMPLE_BROKEN_LINE,
      });
    },
  );
});

describe('the template probe', () => {
  it('uses every function of the contract', () => {
    const { source } = renderTypst(templateProbe());
    for (const call of [
      '#show: manual.with(',
      '#safety(severity: "danger"',
      '#safety(severity: "warning"',
      '#safety(severity: "caution"',
      '#safety(severity: "notice"',
      '#admonition(kind: "note"',
      '#admonition(kind: "tip"',
      '#admonition(kind: "important"',
      '#procedure(',
      '#ui[',
      '#code-span[',
      '#kbd(',
      '#xref(',
      '#anchor(',
      'header-cell(',
      '#faq(',
      '#strong[',
      '#emph[',
      '#link("https://example.com")[',
    ]) {
      expect(source, call).toContain(call);
    }
  });
});
