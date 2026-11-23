/**
 * An organisation's own Typst template (#396): a folder of the content repository
 * (`templates/<id>/`, the content model's `designTemplateDir`) whose `manual.typ` lays a page
 * design out in place of its preset.
 *
 * - `repositoryTemplate` maps the folder's files into the compilation's workspace at their
 *   repository paths, so the generated document imports `/templates/<id>/manual.typ` and the
 *   template's relative imports and reads find its own files, and nothing else of the
 *   repository.
 * - `templateProblems` turns a failed compilation's diagnostics into what an author fixes: the
 *   file (its repository path), line, column and message.
 * - `EXAMPLE_TEMPLATE` is the complete starting point: the classic preset as files of its own,
 *   which renders exactly what the preset renders.
 * - `templateProbe` is a small manual that uses every function of the contract, for checking a
 *   template without a manual of the project's (a change set's design check).
 */
import {
  DESIGN_TEMPLATE_ENTRY,
  DesignTemplateId,
  designTemplateDir,
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_FILES,
  Manifest,
  ProjectConfig,
  parseModule,
  resolveManual,
  type ResolvedManual,
} from '@openfolia/content-model';
import { safeRelativePath } from './compile-core.js';
import {
  DEFAULT_TEMPLATE_PATH,
  DESIGN_LAYER,
  DESIGN_LAYER_PATH,
  PRESET_TITLE_PAGES,
} from './design.js';
import { DEFAULT_TEMPLATE } from './template.js';

/** A repository template, ready to compile: pass both to `renderTypst` and `compilePdf`. */
export interface RepositoryTemplate {
  /** `RenderOptions.templatePath`: the entry file, from the project root. */
  readonly templatePath: string;
  /** `CompileInput.files` to add: the folder's files at their repository paths. */
  readonly files: Record<string, Uint8Array>;
}

/** A template folder that cannot be compiled as it is (too many files, too large, a bad path). */
export class TemplateFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateFolderError';
  }
}

/**
 * The template `id` with its folder's files (paths relative to the folder, `manual.typ`, `parts/
 * notice.typ`, `logo.svg`): `TemplateFolderError` for an ID that is no slug, a path that leaves
 * the folder, no `manual.typ`, more than `MAX_TEMPLATE_FILES` files or more than
 * `MAX_TEMPLATE_BYTES` together. Nothing outside the folder is ever mapped, so a template reads
 * its own files, the design's assets and the manual's images (`CompileInput.files`), the
 * compiler's (`tokens.typ`, `openfolia/…`), and nothing of the host.
 */
export function repositoryTemplate(
  id: string,
  files: Readonly<Record<string, Uint8Array>>,
): RepositoryTemplate {
  if (!DesignTemplateId.safeParse(id).success) {
    throw new TemplateFolderError(`"${id}" is no template ID`);
  }
  const dir = designTemplateDir(id);
  const entries = Object.entries(files);
  if (entries.length > MAX_TEMPLATE_FILES) {
    throw new TemplateFolderError(
      `the template "${id}" has ${entries.length} files, more than ${MAX_TEMPLATE_FILES}`,
    );
  }
  let bytes = 0;
  const mapped: Record<string, Uint8Array> = {};
  for (const [path, data] of entries) {
    let relative: string;
    try {
      relative = safeRelativePath(path);
    } catch {
      throw new TemplateFolderError(
        `the template "${id}" has a file outside its folder: "${path}"`,
      );
    }
    bytes += data.byteLength;
    mapped[`${dir}/${relative}`] = data;
  }
  if (bytes > MAX_TEMPLATE_BYTES) {
    throw new TemplateFolderError(
      `the template "${id}" holds ${bytes} bytes, more than ${MAX_TEMPLATE_BYTES}`,
    );
  }
  if (!(`${dir}/${DESIGN_TEMPLATE_ENTRY}` in mapped)) {
    throw new TemplateFolderError(
      `the template "${id}" has no ${DESIGN_TEMPLATE_ENTRY}`,
    );
  }
  return { templatePath: `/${dir}/${DESIGN_TEMPLATE_ENTRY}`, files: mapped };
}

/** Why a template does not compile, where: what an author reads and fixes. */
export interface TemplateProblem {
  /** The file, by its repository path (`templates/house/manual.typ`, `main.typ` the document). */
  readonly file: string;
  /** 1-based; 0 when the compiler named no place. */
  readonly line: number;
  /** 1-based; 0 when the compiler named no place. */
  readonly column: number;
  readonly message: string;
  /**
   * Where it was called from, innermost first (`while calling notice` in `templates/house/
   * manual.typ`, line 12), as the compiler traced it.
   */
  readonly trace: readonly { file: string; line: number; message: string }[];
}

/** The most problems kept from one compilation, and calls traced per problem. */
export const MAX_TEMPLATE_PROBLEMS = 20;
const MAX_TRACE = 10;
/** The longest message kept, in characters. */
const MAX_MESSAGE = 1000;

/**
 * A failed compilation's diagnostics (`TypstCompileError.diagnostics`, paths already from the
 * project root) as problems: each error with its file, line and column, and the calls that led to
 * it. Warnings are left out; anything that is no diagnostic is skipped, never guessed at.
 */
export function templateProblems(
  diagnostics: readonly unknown[],
): TemplateProblem[] {
  const problems: {
    problem: TemplateProblem;
    trace: TemplateProblem['trace'][number][];
  }[] = [];
  for (const raw of diagnostics) {
    const d = diagnostic(raw);
    if (!d) continue;
    // Severity 1 is an error; the compiler's trace (4) follows the error it belongs to.
    if (d.severity === 4) {
      const last = problems.at(-1);
      if (last && last.trace.length < MAX_TRACE) {
        last.trace.push({ file: d.file, line: d.line, message: d.message });
      }
      continue;
    }
    if (d.severity !== 1) continue;
    if (problems.length >= MAX_TEMPLATE_PROBLEMS) continue;
    const trace: TemplateProblem['trace'][number][] = [];
    problems.push({
      problem: {
        file: d.file,
        line: d.line,
        column: d.column,
        message: d.message,
        trace,
      },
      trace,
    });
  }
  return problems.map(({ problem }) => problem);
}

function diagnostic(raw: unknown):
  | {
      severity: number;
      file: string;
      line: number;
      column: number;
      message: string;
    }
  | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['message'] !== 'string') return undefined;
  const path = typeof r['path'] === 'string' ? r['path'] : '';
  const start = (
    r['range'] as
      { start?: { line?: unknown; character?: unknown } } | undefined
  )?.start;
  const at = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n + 1 : 0;
  return {
    severity: typeof r['severity'] === 'number' ? r['severity'] : 1,
    file: path.replace(/^\/+/, ''),
    line: at(start?.line),
    column: at(start?.character),
    message: r['message'].slice(0, MAX_MESSAGE),
  };
}

/**
 * The example template (#396), by path in its folder: the classic preset as files of the
 * template's own, the starting point for an organisation's template. `manual.typ` is the classic
 * title page over `design.typ` (the page design layer: the design's settings, regions, running
 * header and footer, back page), which builds on `default.typ` (the block styles: notices,
 * steps, tables, …). It reads only the compiler's `tokens.typ` and default logo besides, so a
 * copy in `templates/<id>/` renders exactly what the classic preset renders.
 */
export const EXAMPLE_TEMPLATE: Readonly<Record<string, string>> = {
  [DESIGN_TEMPLATE_ENTRY]: [
    '// An own page design template (#396): the starting point, laid out as the classic preset.',
    '// The generated document imports this file and calls the functions the contract names',
    '// (manual, safety, admonition, procedure, …): design.typ and default.typ define them, and',
    '// anything defined here replaces theirs. Change what you need; keep what you do not.',
    '#import "design.typ": *',
    '',
    '// The title page: the title, the data fields, the cover image and the regions of the',
    '// classic preset, the logo at the top.',
    PRESET_TITLE_PAGES['classic'] as string,
    '',
    '#let manual = design-manual.with(title-page: title-page)',
    '',
  ].join('\n'),
  'design.typ': exampleFile(
    DESIGN_LAYER,
    `#import "/${DEFAULT_TEMPLATE_PATH}"`,
    '#import "default.typ"',
  ),
  'default.typ': DEFAULT_TEMPLATE,
};

/** `text` with every `from` replaced by `to`; fails when there is none, so a rename is noticed. */
function exampleFile(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`the example template no longer finds ${from}`);
  }
  return text.split(from).join(to);
}

// Nothing of the compiler's own layer is left to import: the example stands on its own.
if (EXAMPLE_TEMPLATE['design.typ']?.includes(DESIGN_LAYER_PATH)) {
  throw new Error('the example template still imports the design layer');
}

/**
 * The sample content's templates (`api:setup-local`, the editor's browser flows): `example`, the
 * example template, and `broken`, the example with an error on its last line
 * (`SAMPLE_BROKEN_LINE`), to see how a template that does not compile is shown.
 */
export const SAMPLE_TEMPLATES: Readonly<
  Record<'example' | 'broken', Readonly<Record<string, string>>>
> = {
  example: EXAMPLE_TEMPLATE,
  broken: {
    ...EXAMPLE_TEMPLATE,
    [DESIGN_TEMPLATE_ENTRY]: `${EXAMPLE_TEMPLATE[DESIGN_TEMPLATE_ENTRY]}#let broken = (1).nope()\n`,
  },
};
/** The line of `SAMPLE_TEMPLATES.broken`'s error, 1-based. */
export const SAMPLE_BROKEN_LINE = (
  EXAMPLE_TEMPLATE[DESIGN_TEMPLATE_ENTRY] ?? ''
).split('\n').length;

/** The example template's files as bytes, for `repositoryTemplate`. */
export function exampleTemplateFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(EXAMPLE_TEMPLATE).map(([path, text]) => [
      path,
      new TextEncoder().encode(text),
    ]),
  );
}

/** The probe's own configuration: only what its one module needs. */
const PROBE_CONFIG = ProjectConfig.parse({
  languages: { source: 'en', targets: [] },
  moduleTypes: [{ id: 'probe', label: 'Probe' }],
  audiences: [{ id: 'all', label: 'All' }],
  safetySymbols: [{ id: 'probe-sign', label: 'Warning sign' }],
});

const PROBE_MODULE = `= Checking the template
:schema-version: 1
:module-type: probe
:lang: en
:audience: all

[#intro]
A paragraph with **strong**, __emphasised__ and \`\`code\`\` text, a [.ui]##Start## button, the keys kbd:[Ctrl+S], a link:https://example.com[link] and a reference to xref:probe.adoc#steps[].

[safety#danger,severity=danger,symbols=probe-sign]
.A hazard
====
[#danger-text]
What happens, and how to avoid it.
====

[safety#warning,severity=warning]
.A hazard
====
[#warning-text]
What happens.
====

[safety#caution,severity=caution]
.A hazard
====
[#caution-text]
What happens.
====

[safety#notice,severity=notice]
.Property damage
====
[#notice-text]
What happens.
====

[NOTE#note]
====
[#note-text]
A note.
====

[TIP#tip]
====
[#tip-text]
A tip.
====

[IMPORTANT#important]
====
[#important-text]
Something important.
====

[procedure#steps]
.Steps
. [[step-1]]The first step.
. [[step-2]]The second step.

[#list]
* [[item-1]]An item
* [[item-2]]Another item

[#table,cols="1,2",options=header]
.A table
|===
|[[h1]]Name |[[h2]]Value
|[[c1]]One |[[c2]]1
|===

[#section]
== A section

[#section-text]
Text in a section.

[faq#question]
.A question?
====
[#answer]
The answer.
====
`;

/**
 * A small manual in `lang` (its labels; the text is English) that uses every function of the
 * template contract: running text with each inline mark and a cross-reference, every safety
 * severity, every admonition, steps, a list, a table with a header row, a section and an FAQ
 * entry. Laid out with a design, it checks a template without a manual of the project's.
 */
export function templateProbe(lang = 'en'): ResolvedManual {
  const module = parseModule(PROBE_MODULE, { id: 'probe' });
  const { manual } = resolveManual({
    manifest: Manifest.parse({
      schemaVersion: 1,
      id: 'template-check',
      title: 'Template check',
      variants: [{}],
      entries: [{ module: 'probe' }],
    }),
    variant: {},
    lang,
    config: {
      ...PROBE_CONFIG,
      languages: { source: lang, targets: [] },
    },
    loadModule: (id, l) =>
      id === 'probe'
        ? { ...module, meta: { ...module.meta, lang: l } }
        : undefined,
  });
  return manual;
}
