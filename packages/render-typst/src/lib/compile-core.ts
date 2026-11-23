/**
 * The compilation itself, run in a child process (`sandboxEnv`): a pool
 * worker or a one-off compilation. Self-contained on purpose: it imports
 * only Node built-ins, the compiler and the rasteriser, so Node can run
 * this file directly as the child.
 */
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import { Resvg } from '@resvg/resvg-js';

export interface CoreInput {
  source: string;
  template: string;
  files: Record<string, Uint8Array>;
  fonts: FontFile[];
  /** Directories of font files to load (the theme's TTF fonts). */
  fontDirs: string[];
  /** `tokens.typ`, the theme's values, importable by the document and template. */
  tokens: string;
  /** Set: the output is this page (1-based) as PNG, `width` pixels wide, instead of the PDF. */
  page?: { number: number; width: number };
  /** The PDF standard: `ua-1` (PDF/UA-1) or `none` (a plain PDF). */
  standard: 'ua-1' | 'none';
  /** The time the PDF says it was made, in whole seconds since the epoch; undefined: now. */
  creationTimestamp?: number;
  /** `sys.inputs`: strings the document and template read (a page design's settings, #391). */
  inputs?: Record<string, string>;
}

/** Why the document cannot meet its PDF standard: Typst's message and hints. */
export interface AccessibilityProblem {
  message: string;
  hints: string[];
}

export type CoreResult =
  /** `warnings`: the values of the document's `<openfolia-warning>` metadata (PDF only), unchecked. */
  | { ok: true; data: Uint8Array; warnings?: unknown[] }
  /** The document has no such page; `pages` is how many it has. */
  | { ok: false; pages: number }
  /** The document or template is wrong; safe to show to the author. */
  | { ok: false; diagnostics: unknown[] }
  /**
   * The document cannot meet its PDF standard (PDF/UA-1); safe to show to the author.
   * `warnings` as for a PDF: the layout was made before the export refused it (#554).
   */
  | { ok: false; accessibility: AccessibilityProblem[]; warnings?: unknown[] }
  /** Something is wrong with the server, not the document; log it, do not show it. */
  | { ok: false; internal: string; brokenRoot?: boolean };

/**
 * A new private (0700) empty directory to use as a Typst project root.
 * `mkdtemp` picks an unpredictable name and creates it atomically, so it
 * is safe even in a shared parent like the system temp directory. A
 * non-default `parent` must already be private (`assertPrivateDirectory`);
 * it is never created here, since a path someone else created could
 * stand in for it.
 */
export function createWorkspace(parent?: string): string {
  if (parent !== undefined) assertPrivateDirectory(parent);
  return mkdtempSync(join(parent ?? tmpdir(), 'openfolia-typst-'));
}

/**
 * Checks that the project root is safe to use: a real directory (not a
 * symlink), owned by this process's user, closed to group and others, and
 * empty. Typst falls back to reading real files under its root, so a root
 * someone else could write to would let a template read their files.
 */
export function assertSafeWorkspace(workspace: string): void {
  assertPrivateDirectory(workspace);
  if (readdirSync(workspace).length > 0) {
    throw new Error(`refusing to compile: ${workspace} is not empty`);
  }
}

/** A real directory (not a symlink), owned by this process's user, closed to group and others. */
export function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  const problem = !stat.isDirectory()
    ? 'is not a directory'
    : process.getuid && stat.uid !== process.getuid()
      ? 'is owned by another user'
      : process.platform !== 'win32' && (stat.mode & 0o077) !== 0
        ? 'is accessible to other users'
        : undefined;
  if (problem) throw new Error(`refusing to compile: ${path} ${problem}`);
}

/**
 * Compiles with `workspace` as the project root, after checking it with
 * `assertSafeWorkspace` (throws if unsafe), on a compiler of its own. Typst
 * errors in the document or template come back as diagnostics, with paths
 * relative to the workspace; anything else throws. All files are mapped in
 * memory and nothing is written to the root; Typst cannot read outside it,
 * so neither the document nor the template can read files from the host.
 * Typst packages (`@preview/…`, `@local/…`) are a host read too: run this
 * only in a process with `sandboxEnv`'s environment, which gives Typst an
 * empty package directory and no network.
 */
export function compileToPdf(input: CoreInput, workspace: string): CoreResult {
  assertSafeWorkspace(workspace);
  return new CompilerCache().compile(input, workspace);
}

/**
 * One compiler kept from job to job in a long-lived process (#436): `NodeCompiler.create` keeps
 * about 1–7 MB of every compiler until the process ends, a reused compiler a small part of
 * that a job (README, "Memory"). It is kept for one font set and workspace (the fonts are the compiler's
 * own, given when it is made): a job with others gets a new one, and the old one is dropped.
 *
 * **Nothing of a job reaches the next.** A job sees only what it maps itself: every file and
 * source is unmapped (`resetShadow`) before it and after it, and its `sys.inputs` are passed
 * with the compilation, never left on the compiler. A compiler is kept only after a job that
 * ended well (a PDF, a page image, a page that does not exist); after a Typst error, a refused
 * export or anything thrown it is dropped, and a timed-out job or one over its memory limit
 * ends the whole process. Typst's own memoization (`evictCache`) is keyed by what it read, so
 * it never hands one job's results to another with other inputs.
 */
export class CompilerCache {
  private kept: { key: string; compiler: NodeCompiler } | undefined;
  private made = 0;

  /** How many compilers this cache has made (each `NodeCompiler.create`). */
  get created(): number {
    return this.made;
  }

  /** Compiles `input` in `workspace` (checked by the caller), on the kept compiler when it fits. */
  compile(input: CoreInput, workspace: string): CoreResult {
    const key = compilerKey(input, workspace);
    const reused = this.kept?.key === key ? this.kept.compiler : undefined;
    // Taken: kept again only once this job has ended well.
    this.kept = undefined;
    const compiler = reused ?? this.create(input, workspace);
    let keep = false;
    try {
      // Nothing from before: unmapped after the last job too, so this only makes sure.
      compiler.resetShadow();
      const result = compileWith(compiler, input, workspace);
      keep = result.ok || 'pages' in result;
      return result;
    } finally {
      try {
        compiler.resetShadow();
        compiler.evictCache(10);
      } catch {
        keep = false;
      }
      if (keep) this.kept = { key, compiler };
    }
  }

  private create(input: CoreInput, workspace: string): NodeCompiler {
    // WOFF and WOFF2 decoded here, in the child (#555); one that does not decode is left out.
    // The blobs go first: typst-ts 0.7.0 panics (aborting the child) on memory fonts added
    // after a font directory ("dirty font search state"), and leaves them out when both are in
    // one entry.
    const blobs = fontBlobs(input.fonts);
    const fontArgs: ({ fontBlobs: Buffer[] } | { fontPaths: string[] })[] = [
      ...(blobs.length > 0 ? [{ fontBlobs: blobs }] : []),
      ...(input.fontDirs.length > 0 ? [{ fontPaths: input.fontDirs }] : []),
    ];
    const compiler = NodeCompiler.create({
      workspace,
      ...(fontArgs.length > 0 ? { fontArgs } : {}),
      // A job's own are passed with its compilation (`compileWith`).
      inputs: {},
    });
    this.made++;
    return compiler;
  }
}

/**
 * What a compiler is made for: the workspace and the font set (each font's bytes and family,
 * the font directories), as a digest. Two inputs with the same key can share a compiler.
 */
export function compilerKey(input: CoreInput, workspace: string): string {
  const hash = createHash('sha256');
  const part = (bytes: Uint8Array | string) => {
    const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    // Length first, so no two lists of parts make the same stream.
    hash.update(`${data.byteLength}:`);
    hash.update(data);
  };
  part(workspace);
  part(String(input.fontDirs.length));
  for (const dir of input.fontDirs) part(dir);
  part(String(input.fonts.length));
  for (const font of input.fonts) {
    if (font instanceof Uint8Array) {
      part('bytes');
      part(font);
    } else {
      part('family');
      part(font.family);
      part(font.data);
    }
  }
  return hash.digest('hex');
}

/** One compilation on `compiler`, whose shadow files the caller has just reset. */
function compileWith(
  compiler: NodeCompiler,
  input: CoreInput,
  workspace: string,
): CoreResult {
  compiler.addSource(join(workspace, 'main.typ'), input.source);
  compiler.addSource(join(workspace, 'template.typ'), input.template);
  compiler.addSource(join(workspace, 'tokens.typ'), input.tokens);
  for (const [path, content] of Object.entries(input.files)) {
    compiler.mapShadow(
      join(workspace, safeRelativePath(path)),
      Buffer.from(content),
    );
  }
  const result = compiler.compile({
    mainFilePath: join(workspace, 'main.typ'),
    // Always given, empty too: a job never reads another's.
    inputs: input.inputs ?? {},
  });
  const error = result.takeError();
  if (error || !result.result) {
    return {
      ok: false,
      diagnostics: error
        ? withoutHostPaths(
            compiler.fetchDiagnostics(error).map(explainPackage),
            workspace,
          )
        : ['no document produced'],
    };
  }
  if (input.page === undefined) {
    // What the layout reported (a page design's region or running head that did not fit;
    // a callout legend beside its image cut off, #548: `CALLOUT_MIN_SIZE_INPUT` is given
    // only to a document with such a legend). Read before the export, which may refuse the
    // document: the warnings go with the refusal then (#554).
    const warnings =
      input.inputs?.['openfolia-design'] ||
      input.inputs?.['openfolia-callout-min-size']
        ? layoutQuery(compiler, result.result)
        : [];
    try {
      const data = compiler.pdf(result.result, {
        ...(input.standard === 'ua-1' && { pdfStandard: 'ua-1' }),
        // Without it, the compiler writes the time of rendering
        // into the PDF (its dates and document ID): the same input
        // would give other bytes a second later (#328).
        ...(input.creationTimestamp !== undefined && {
          creationTimestamp: input.creationTimestamp,
        }),
      });
      return {
        ok: true,
        data,
        ...(warnings.length > 0 && { warnings }),
      };
    } catch (e) {
      const accessibility = standardProblems(e);
      if (accessibility) {
        return {
          ok: false,
          accessibility: withoutHostPaths(accessibility, workspace),
          ...(warnings.length > 0 && { warnings }),
        };
      }
      throw e;
    }
  }
  const pages = result.result.numOfPages;
  if (input.page.number > pages) return { ok: false, pages };
  const svg = pageSvg(compiler.plainSvg(result.result), input.page.number);
  if (svg === undefined) {
    return {
      ok: false,
      internal: 'the page could not be cut out of the SVG',
    };
  }
  const png = new Resvg(svg, {
    fitTo: fitWithin(svg, input.page.width),
    background: '#ffffff',
    // Text is drawn as outlines and images are embedded: nothing to load.
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  return { ok: true, data: png };
}

/** Typst's messages for a package import that found no package. */
const PACKAGE_ERROR = /^(failed to download package|package not found)\b/;

/** What an author reads instead of the sandbox's failed download or empty package directory. */
export const PACKAGE_REFUSED =
  "Typst packages cannot be imported: a template can use only its own files and the compiler's (tokens.typ, openfolia/…)";

/** A diagnostic of a package import, with `PACKAGE_REFUSED` as its message; any other as it is. */
function explainPackage(diagnostic: unknown): unknown {
  if (
    typeof diagnostic === 'object' &&
    diagnostic !== null &&
    'message' in diagnostic &&
    typeof diagnostic.message === 'string' &&
    PACKAGE_ERROR.test(diagnostic.message)
  ) {
    return { ...diagnostic, message: PACKAGE_REFUSED };
  }
  return diagnostic;
}

/**
 * `value` with every mention of the workspace's absolute path dropped from
 * its strings, so paths read as Typst's own, from the project root
 * (`/main.typ`, `/assets/x.png`): the server's directories never reach
 * the author. Both the path as given and its real path (`/var` is
 * `/private/var` on macOS) are dropped.
 */
export function withoutHostPaths<T>(value: T, workspace: string): T {
  const prefixes = [workspace];
  try {
    const real = realpathSync(workspace);
    if (real !== workspace) prefixes.push(real);
  } catch {
    // Gone already: the path as given is all there is to drop.
  }
  // Longest first, so a prefix of another never leaves part of it behind.
  prefixes.sort((a, b) => b.length - a.length);
  const strip = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const prefix of prefixes) out = out.split(prefix).join('');
      return out;
    }
    if (Array.isArray(v)) return v.map(strip);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(
        Object.entries(v).map(([key, entry]) => [key, strip(entry)]),
      );
    }
    return v;
  };
  return strip(value) as T;
}

/** What a standard's refusal names (`PDF/UA-1 error: missing alt text`). */
const STANDARD_ERROR = /^PDF\/UA-1 error: /;
/** One diagnostic in the compiler's text of a PDF export error (Rust's debug format). */
const DIAGNOSTIC =
  /message: "((?:[^"\\]|\\.)*)"[^]*?hints: \[((?:"(?:[^"\\]|\\.)*"(?:, )?)*)\]/g;
const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

/**
 * The problems of a PDF export that the standard refused, from the
 * compiler's error (it gives the export's diagnostics only as text);
 * undefined for any other error, which stays the server's to log, and for
 * one whose text cannot be read as such a refusal (decided on the parsed
 * messages only, so content quoted in another error never passes for one).
 * The raw text is never passed on, only what was read from it.
 */
export function standardProblems(
  error: unknown,
): AccessibilityProblem[] | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const problems: AccessibilityProblem[] = [];
  for (const [, message = '', hints = ''] of text.matchAll(DIAGNOSTIC)) {
    const read = unescapeDebug(message);
    if (!STANDARD_ERROR.test(read)) continue;
    problems.push({
      message: read,
      hints: [...hints.matchAll(QUOTED)].map(([, h = '']) => unescapeDebug(h)),
    });
  }
  return problems.length > 0 ? problems : undefined;
}

/** A string as Rust's debug format quotes it, unquoted. */
function unescapeDebug(value: string): string {
  return value.replace(
    /\\(u\{([0-9a-fA-F]{1,6})\}|.)/g,
    (_, escape: string, code?: string) => {
      if (code !== undefined) {
        const point = Number.parseInt(code, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : '';
      }
      return escape === 'n'
        ? '\n'
        : escape === 't'
          ? '\t'
          : escape === 'r'
            ? '\r'
            : escape === '0'
              ? ''
              : escape;
    },
  );
}

/** The most pixels a page image may have (a portrait A4 page 2400 pixels wide). */
export const MAX_PAGE_PIXELS = 2400 * 3400;

/** `width` pixels wide, unless that makes more than `MAX_PAGE_PIXELS` (a very tall page): then fewer. */
function fitWithin(
  svg: string,
  width: number,
): { mode: 'width'; value: number } | { mode: 'height'; value: number } {
  const [, w, h] = / width="([\d.]+)pt" height="([\d.]+)pt"/.exec(svg) ?? [];
  const ratio = Number(h) / Number(w);
  if (!(ratio > 0) || width * width * ratio <= MAX_PAGE_PIXELS) {
    return { mode: 'width', value: width };
  }
  // The rasteriser rounds the width up: a height whose rounded-up width keeps within the cap.
  let height = Math.floor(Math.sqrt(MAX_PAGE_PIXELS * ratio));
  while (height > 1 && height * Math.ceil(height / ratio) > MAX_PAGE_PIXELS) {
    height--;
  }
  return { mode: 'height', value: height };
}

/** A page's group in the compiler's plain SVG: at the top level, the first one untranslated. */
const PAGE_START = /^ {4}<g(?: transform="matrix\(1 0 0 1 0 ([\d.]+)\)")?>$/;
/** The page's own size and fill: the shape the compiler writes just before its group. */
const PAGE_BACKGROUND =
  /^ {4}<path class="typst-shape" [^>]*?\bd="M 0 0v ([\d.]+) h ([\d.]+) v -[\d.]+ Z "\/>$/;
const TOP_LEVEL_END = /^ {4}<\/g>$/;
const TOP_LEVEL_DEFS = /^ {4}<defs[ >][\s\S]*?^ {4}<\/defs>$/gm;
/** The only references a page may keep: its own definitions and embedded images. */
const SAFE_HREF = /^(#|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,)/;

/**
 * One page (1-based) of the compiler's plain SVG (all pages stacked) as an
 * SVG of its own that a strict SVG reader (the rasteriser) accepts: the
 * root with the view box on that page, the page's background (its fill,
 * white when it has none), its group and the shared definitions. Links are
 * dropped, keeping their content: their targets are the only text from the
 * document the compiler writes unescaped (`&`, `<`), and an image has no
 * use for them. Colours the rasteriser cannot read are converted to sRGB.
 * Undefined when there is no such page or the SVG is not as expected;
 * throws when it references anything but its definitions and embedded
 * images (the rasteriser would read local files).
 */
export function pageSvg(plain: string, page: number): string | undefined {
  if (!Number.isInteger(page) || page < 1) return undefined;
  if (plain.includes('<!'))
    throw new Error('unexpected markup declaration in the SVG');
  // Attribute values never contain `"` (the compiler writes it as `&quot;`),
  // so a tag is matched attribute by attribute, whatever `>` or `<` they hold.
  const svg = convertColours(
    plain
      .replace(/<a((?:\s+[\w:-]+="[^"]*")*)\s*>/g, (_, attributes: string) => {
        const transform = /\stransform="[^"]*"/.exec(attributes)?.[0] ?? '';
        return `<g${transform}>`;
      })
      .replace(/<\/a>/g, '</g>'),
  );
  for (const [, href] of svg.matchAll(/\bhref="([^"]*)"/g)) {
    if (!SAFE_HREF.test(href ?? '')) {
      throw new Error('unexpected reference in the SVG');
    }
  }
  const root = /^<svg[^>]*?\sviewBox="0 0 ([\d.]+) ([\d.]+)"[^>]*>/.exec(svg);
  if (!root) return undefined;
  const lines = svg.split('\n');
  const pages: {
    y: number;
    start: number;
    end: number;
    background?: { line: string; width: number; height: number };
  }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = PAGE_START.exec(lines[i] ?? '');
    if (!start) continue;
    const before = PAGE_BACKGROUND.exec(lines[i - 1] ?? '');
    let end = i + 1;
    while (end < lines.length && !TOP_LEVEL_END.test(lines[end] ?? '')) end++;
    pages.push({
      y: Number(start[1] ?? 0),
      start: i,
      end,
      ...(before && {
        background: {
          line: lines[i - 1] ?? '',
          height: Number(before[1]),
          width: Number(before[2]),
        },
      }),
    });
    i = end;
  }
  const found = pages[page - 1];
  if (!found) return undefined;
  const width = found.background?.width ?? Number(root[1]);
  const height =
    found.background?.height ?? (pages[page]?.y ?? Number(root[2])) - found.y;
  const group = lines.slice(found.start, found.end + 1).join('\n');
  const defs = svg.match(TOP_LEVEL_DEFS)?.join('\n') ?? '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 ${found.y} ${width} ${height}" width="${width}pt" height="${height}pt">`,
    `<rect x="0" y="${found.y}" width="${width}" height="${height}" fill="#ffffff"/>`,
    found.background
      ? `<g transform="matrix(1 0 0 1 0 ${found.y})">${found.background.line.trim()}</g>`
      : '',
    group,
    defs,
    '</svg>',
  ].join('\n');
}

/** Colours in spaces the rasteriser does not read, as sRGB. */
function convertColours(svg: string): string {
  return svg
    .replace(
      OKLAB,
      (
        _,
        space: 'oklch' | 'oklab',
        l: string,
        x: string,
        y: string,
        a?: string,
      ) => oklabToRgb(space, Number(l), Number(x), Number(y), a),
    )
    .replace(LINEAR_RGB, (_, r: string, g: string, b: string, a?: string) =>
      rgbString(
        [r, g, b].map((c) => Number(c)),
        a,
      ),
    )
    .replace(HSL, (_, h: string, sat: string, l: string, a?: string) =>
      rgbString(hslToLinear(Number(h), Number(sat) / 100, Number(l) / 100), a),
    );
}

/** `color(srgb-linear r g b [/ a])`, channels 0–1. */
const LINEAR_RGB =
  /color\(srgb-linear\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)/g;
/** Space-separated `hsl(Hdeg S% L% [/ a])`, which the rasteriser does not read. */
const HSL =
  /hsl\(\s*(-?[\d.]+|NaN)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%\s*(?:\/\s*([\d.]+%?)\s*)?\)/g;

/** HSL as linear-light sRGB channels (0–1), for `rgbString`. */
function hslToLinear(hue: number, s: number, l: number): number[] {
  const h = (((Number.isNaN(hue) ? 0 : hue) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  // HSL is gamma-encoded sRGB: back to linear light, as rgbString expects.
  return [r + m, g + m, b + m].map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
}

/** Linear-light sRGB channels (0–1) and a CSS alpha as CSS `rgb()`/`rgba()`, clamped. */
function rgbString(linear: number[], alpha?: string): string {
  const channel = (v: number) => {
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
  };
  const rgb = linear.map(channel).join(',');
  if (alpha === undefined) return `rgb(${rgb})`;
  const value = alpha.endsWith('%')
    ? Number(alpha.slice(0, -1)) / 100
    : Number(alpha);
  return `rgba(${rgb},${Math.min(1, Math.max(0, value))})`;
}

/**
 * The compiler writes colours in those spaces (the theme's, and mixes of
 * them) as CSS `oklch()` and `oklab()`, which the rasteriser does not read.
 */
const OKLAB =
  /(oklch|oklab)\(\s*(-?[\d.]+)%\s+(-?[\d.]+)\s+(-?[\d.]+|NaN)(?:deg)?\s*(?:\/\s*([\d.]+%?)\s*)?\)/g;

/** A CSS `oklch()` or `oklab()` colour, by its parts, as CSS `rgb()`/`rgba()` (sRGB, clamped). */
export function oklabToRgb(
  space: 'oklch' | 'oklab',
  lightness: number,
  x: number,
  y: number,
  alpha?: string,
): string {
  const L = lightness / 100;
  const radians = ((Number.isNaN(y) ? 0 : y) * Math.PI) / 180;
  const [a, b] =
    space === 'oklch' ? [x * Math.cos(radians), x * Math.sin(radians)] : [x, y];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return rgbString(
    [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ],
    alpha,
  );
}

export function safeRelativePath(path: string): string {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (
    segments.length === 0 ||
    segments.some((s) => s === '..' || s.includes('\\'))
  ) {
    throw new Error(`invalid file path "${path}"`);
  }
  return segments.join('/');
}

// --- Font files (#555): WOFF and WOFF2 decoded to TrueType/OpenType for Typst ---
//
// Typst reads only sfnt fonts (TrueType, OpenType) and leaves out any other blob without a
// word, so a design's WOFF and WOFF2 files are decoded here, in the compiling child, never in
// the API's process. A file that does not decode, or would decode to more than the bounds, is
// left out the same way: the document falls back to the default font, and nothing is thrown.

/** The most bytes one font decodes to. */
export const MAX_FONT_BYTES = 64 * 1024 * 1024;
/** The most bytes a compilation's fonts decode to together. */
export const MAX_FONTS_BYTES = 256 * 1024 * 1024;

/**
 * A font file to load: its bytes, or its bytes and the family it is loaded as. Typst knows a
 * font by its own name (name ID 1, style words such as "Condensed" or "Black" cut off), which
 * is often not the family it states: a design's font is loaded under a family of the
 * renderer's own, so the document finds it whatever the file calls itself.
 */
export type FontFile = Uint8Array | { data: Uint8Array; family: string };

/** The fonts as Typst takes them: each an sfnt; one that does not decode left out. */
export function fontBlobs(fonts: readonly FontFile[]): Buffer[] {
  const out: Buffer[] = [];
  let total = 0;
  for (const font of fonts) {
    const room = Math.min(MAX_FONT_BYTES, MAX_FONTS_BYTES - total);
    const { data, family } =
      font instanceof Uint8Array ? { data: font, family: undefined } : font;
    const decoded = sfntFromFontFile(data, room);
    const sfnt =
      decoded && family !== undefined
        ? sfntWithFamily(decoded, family, room)
        : decoded;
    if (!sfnt) continue;
    total += sfnt.byteLength;
    out.push(Buffer.from(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength));
  }
  return out;
}

/**
 * `bytes` as an sfnt: a TrueType or OpenType font as it is, a WOFF (zlib) or WOFF2 (brotli,
 * with its glyf, loca and hmtx transforms undone) decoded; `undefined` for anything else (a
 * collection, a file that does not decode, one larger than `maxBytes` decoded). Never throws.
 */
export function sfntFromFontFile(
  bytes: Uint8Array,
  maxBytes = MAX_FONT_BYTES,
): Uint8Array | undefined {
  try {
    if (bytes.byteLength < 4) return undefined;
    switch (new FontBytes(bytes).u32()) {
      case 0x00010000:
      case 0x74727565: // 'true'
      case 0x4f54544f: // 'OTTO'
        return bytes.byteLength <= maxBytes ? bytes : undefined;
      case 0x774f4646: // 'wOFF'
        return decodeWoff(bytes, maxBytes);
      case 0x774f4632: // 'wOF2'
        return decodeWoff2(bytes, maxBytes);
      default:
        return undefined;
    }
  } catch {
    // Broken or too large: left out, the fallback font is used.
    return undefined;
  }
}

class FontDecodeError extends Error {}

const broken = (what: string): never => {
  throw new FontDecodeError(what);
};

/** A bounds-checked big-endian reader over part of a font file. */
class FontBytes {
  private readonly b: Uint8Array;
  at: number;
  constructor(b: Uint8Array, at = 0) {
    this.b = b;
    this.at = at;
  }
  get left(): number {
    return this.b.byteLength - this.at;
  }
  private need(n: number): void {
    if (n < 0 || this.at + n > this.b.byteLength) broken('past the end');
  }
  u8(): number {
    this.need(1);
    return this.b[this.at++] as number;
  }
  u16(): number {
    this.need(2);
    const v =
      ((this.b[this.at] as number) << 8) | (this.b[this.at + 1] as number);
    this.at += 2;
    return v;
  }
  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  u32(): number {
    return this.u16() * 0x10000 + this.u16();
  }
  tag(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** WOFF2's 255UInt16. */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return 253 + this.u8();
    if (code === 254) return 506 + this.u8();
    return code;
  }
  /** WOFF2's UIntBase128: at most 5 bytes, no leading zero, within 32 bits. */
  base128(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      if (i === 0 && byte === 0x80) broken('base128 leading zero');
      if (value > 0x01ffffff) broken('base128 overflow');
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    return broken('base128 too long');
  }
}

interface FontTable {
  readonly tag: string;
  readonly data: Uint8Array;
}

/** The most tables a decoded font may have. */
const MAX_FONT_TABLES = 256;

const pad4 = (n: number): number => (n + 3) & ~3;

function checksum(data: Uint8Array): number {
  let sum = 0;
  const words = data.byteLength >> 2;
  for (let i = 0; i < words; i++) {
    const at = i * 4;
    const word =
      (((data[at] as number) << 24) >>> 0) +
      (((data[at + 1] as number) << 16) |
        ((data[at + 2] as number) << 8) |
        (data[at + 3] as number));
    sum = (sum + word) >>> 0;
  }
  let tail = 0;
  for (let i = words * 4; i < data.byteLength; i++) {
    tail += (data[i] as number) * 2 ** (8 * (3 - (i - words * 4)));
  }
  return (sum + tail) >>> 0;
}

/** An sfnt of `tables`: sorted by tag, 4-byte aligned, with checksums. */
function writeSfnt(
  flavor: number,
  tables: readonly FontTable[],
  maxBytes: number,
): Uint8Array {
  const sorted = [...tables].sort((a, b) =>
    a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0,
  );
  const n = sorted.length;
  const directory = 12 + 16 * n;
  const total = sorted.reduce((s, t) => s + pad4(t.data.byteLength), directory);
  if (total > maxBytes) broken('too large');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let power = 1;
  let log = 0;
  while (power * 2 <= n) {
    power *= 2;
    log++;
  }
  view.setUint32(0, flavor);
  view.setUint16(4, n);
  view.setUint16(6, power * 16);
  view.setUint16(8, log);
  view.setUint16(10, n * 16 - power * 16);
  let offset = directory;
  let headAt = -1;
  for (const [i, { tag, data }] of sorted.entries()) {
    out.set(data, offset);
    if (tag === 'head' && data.byteLength >= 12) {
      view.setUint32(offset + 8, 0);
      headAt = offset;
    }
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[at + c] = tag.charCodeAt(c);
    view.setUint32(
      at + 4,
      checksum(out.subarray(offset, offset + data.byteLength)),
    );
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, data.byteLength);
    offset += pad4(data.byteLength);
  }
  if (headAt >= 0) {
    view.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}

/** The family name IDs: family, typographic family, WWS family; replaced when a font is renamed. */
const FAMILY_NAME_IDS = new Set([1, 16, 21]);

/**
 * The sfnt `sfnt` with `family` as its family (name IDs 1 and 16, Windows Unicode, the font's
 * own records of them, WWS's too, left out); its other names, the PostScript name among them,
 * and its weight and slope (`OS/2`, `head`) kept. `undefined` for a font whose table directory
 * or `name` table does not read, or one past `maxBytes` renamed. Never throws.
 */
export function sfntWithFamily(
  sfnt: Uint8Array,
  family: string,
  maxBytes = MAX_FONT_BYTES,
): Uint8Array | undefined {
  try {
    const r = new FontBytes(sfnt);
    const flavor = r.u32();
    if (!SFNT_FLAVORS.has(flavor)) broken('flavour');
    const count = r.u16();
    if (count < 1 || count > MAX_FONT_TABLES) broken('tables');
    r.bytes(6);
    const tables: FontTable[] = [];
    let name: Uint8Array | undefined;
    for (let i = 0; i < count; i++) {
      const tag = r.tag();
      r.u32();
      const offset = r.u32();
      const length = r.u32();
      const data = new FontBytes(sfnt, offset).bytes(length);
      if (tag === 'name') name = data;
      else tables.push({ tag, data });
    }
    if (!name) return undefined;
    tables.push({ tag: 'name', data: renamedNameTable(name, family) });
    return writeSfnt(flavor, tables, maxBytes);
  } catch {
    return undefined;
  }
}

/** `name` (format 0 or 1) as a format 0 table with `family` for the family names. */
function renamedNameTable(name: Uint8Array, family: string): Uint8Array {
  const r = new FontBytes(name);
  r.u16();
  const count = r.u16();
  const storage = r.u16();
  // A string several records share (a licence in many languages) is written once.
  const records: { key: number[]; text: Uint8Array; shared: string }[] = [];
  for (let i = 0; i < count; i++) {
    const platform = r.u16();
    const encoding = r.u16();
    const language = r.u16();
    const id = r.u16();
    const length = r.u16();
    const offset = r.u16();
    // A format 1 table's language tags are left out with the records that use them.
    if (FAMILY_NAME_IDS.has(id) || language >= 0x8000) continue;
    records.push({
      key: [platform, encoding, language, id],
      text: new FontBytes(name, storage + offset).bytes(length),
      shared: `${offset}:${length}`,
    });
  }
  const utf16 = new Uint8Array(family.length * 2);
  for (let i = 0; i < family.length; i++) {
    utf16[i * 2] = family.charCodeAt(i) >> 8;
    utf16[i * 2 + 1] = family.charCodeAt(i) & 0xff;
  }
  for (const id of [1, 16]) {
    records.push({ key: [3, 1, 0x0409, id], text: utf16, shared: 'family' });
  }
  records.sort((a, b) => {
    for (let k = 0; k < 4; k++) {
      const d = (a.key[k] as number) - (b.key[k] as number);
      if (d !== 0) return d;
    }
    return 0;
  });
  const header = 6 + records.length * 12;
  const strings = new Map<string, Uint8Array>();
  for (const { text, shared } of records) strings.set(shared, text);
  const size = [...strings.values()].reduce(
    (n, text) => n + text.byteLength,
    header,
  );
  if (header > 0xffff || size - header > 0xffff) broken('names');
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint16(2, records.length);
  view.setUint16(4, header);
  const placed = new Map<string, number>();
  let at = 0;
  for (const [i, { key, text, shared }] of records.entries()) {
    const record = 6 + i * 12;
    for (let k = 0; k < 4; k++)
      view.setUint16(record + k * 2, key[k] as number);
    view.setUint16(record + 8, text.byteLength);
    let offset = placed.get(shared);
    if (offset === undefined) {
      offset = at;
      placed.set(shared, at);
      out.set(text, header + at);
      at += text.byteLength;
    }
    view.setUint16(record + 10, offset);
  }
  return out;
}

const SFNT_FLAVORS = new Set([0x00010000, 0x74727565, 0x4f54544f]);

function decodeWoff(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const r = new FontBytes(bytes, 4);
  const flavor = r.u32();
  if (!SFNT_FLAVORS.has(flavor)) broken('flavour');
  if (r.u32() !== bytes.byteLength) broken('length');
  const count = r.u16();
  if (count < 1 || count > MAX_FONT_TABLES) broken('table count');
  r.at = 44;
  const tables: FontTable[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const tag = r.tag();
    const offset = r.u32();
    const compLength = r.u32();
    const origLength = r.u32();
    r.u32(); // the checksum, made again
    total += origLength;
    if (total > maxBytes || compLength > origLength) broken('lengths');
    const data = new FontBytes(bytes, offset).bytes(compLength);
    const table =
      compLength === origLength
        ? data
        : new Uint8Array(inflateSync(data, { maxOutputLength: origLength }));
    if (table.byteLength !== origLength) broken('inflated length');
    tables.push({ tag, data: table });
  }
  return writeSfnt(flavor, tables, maxBytes);
}

/** WOFF2's known tags, by their index in a table directory entry's flags. */
const WOFF2_KNOWN_TAGS: readonly string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf',
  'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT',
  'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT',
  'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar',
  'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd',
  'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
]; // prettier-ignore

function decodeWoff2(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const r = new FontBytes(bytes, 4);
  const flavor = r.u32();
  if (!SFNT_FLAVORS.has(flavor)) broken('flavour'); // a collection too
  if (r.u32() !== bytes.byteLength) broken('length');
  const count = r.u16();
  if (count < 1 || count > MAX_FONT_TABLES) broken('table count');
  r.at = 20;
  const compressed = r.u32();
  r.at = 48;
  const entries: { tag: string; length: number; transformed: boolean }[] = [];
  let streamLength = 0;
  for (let i = 0; i < count; i++) {
    const flags = r.u8();
    const index = flags & 0x3f;
    const version = flags >> 6;
    const tag =
      index === 63 ? r.tag() : (WOFF2_KNOWN_TAGS[index] ?? broken('tag'));
    const origLength = r.base128();
    const glyfOrLoca = tag === 'glyf' || tag === 'loca';
    const transformed = glyfOrLoca ? version !== 3 : version !== 0;
    if (glyfOrLoca ? version !== 0 && version !== 3 : version > 1) {
      broken('transform');
    }
    if (transformed && !glyfOrLoca && tag !== 'hmtx') broken('transform');
    const length = transformed ? r.base128() : origLength;
    if (entries.some((e) => e.tag === tag)) broken('duplicate table');
    entries.push({ tag, length, transformed });
    streamLength += length;
    if (streamLength > maxBytes) broken('too large');
  }
  const stream = brotliDecompressSync(r.bytes(compressed), {
    maxOutputLength: Math.max(streamLength, 1),
  });
  if (stream.byteLength !== streamLength) broken('stream length');
  const data = new Map<string, Uint8Array>();
  const transformed = new Set<string>();
  let at = 0;
  for (const entry of entries) {
    data.set(entry.tag, stream.subarray(at, at + entry.length));
    if (entry.transformed) transformed.add(entry.tag);
    at += entry.length;
  }
  if (transformed.has('glyf') !== transformed.has('loca')) broken('glyf/loca');
  const tables: FontTable[] = [];
  let xMins: Int16Array | undefined;
  let glyphs = 0;
  if (transformed.has('glyf')) {
    const rebuilt = reconstructGlyf(data.get('glyf') as Uint8Array, maxBytes);
    tables.push({ tag: 'glyf', data: rebuilt.glyf });
    tables.push({ tag: 'loca', data: rebuilt.loca });
    xMins = rebuilt.xMins;
    glyphs = rebuilt.xMins.length;
    // head.indexToLocFormat as the rebuilt loca has it.
    const head = data.get('head') ?? broken('no head');
    if (head.byteLength < 54) broken('head');
    const copy = new Uint8Array(head);
    copy[50] = 0;
    copy[51] = rebuilt.indexFormat;
    data.set('head', copy);
  }
  if (transformed.has('hmtx')) {
    if (!xMins) broken('hmtx without glyf');
    const hhea = new FontBytes(data.get('hhea') ?? broken('no hhea'), 34);
    tables.push({
      tag: 'hmtx',
      data: reconstructHmtx(
        data.get('hmtx') as Uint8Array,
        hhea.u16(),
        glyphs,
        xMins as Int16Array,
      ),
    });
  }
  for (const [tag, table] of data) {
    if (!transformed.has(tag)) tables.push({ tag, data: table });
  }
  return writeSfnt(flavor, tables, maxBytes);
}

/** A point's delta in WOFF2's triplet encoding (the spec's table, as its decoder computes it). */
function triplet(flag: number, glyph: FontBytes): [number, number] {
  const sign = (f: number, value: number) => (f & 1 ? value : -value);
  if (flag < 10) return [0, sign(flag, ((flag & 14) << 7) + glyph.u8())];
  if (flag < 20) return [sign(flag, (((flag - 10) & 14) << 7) + glyph.u8()), 0];
  if (flag < 84) {
    const b0 = flag - 20;
    const b1 = glyph.u8();
    return [
      sign(flag, 1 + (b0 & 0x30) + (b1 >> 4)),
      sign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)),
    ];
  }
  if (flag < 120) {
    const b0 = flag - 84;
    const x = glyph.u8();
    const y = glyph.u8();
    return [
      sign(flag, 1 + (Math.floor(b0 / 12) << 8) + x),
      sign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + y),
    ];
  }
  if (flag < 124) {
    const a = glyph.u8();
    const b = glyph.u8();
    const c = glyph.u8();
    return [
      sign(flag, (a << 4) + (b >> 4)),
      sign(flag >> 1, ((b & 0x0f) << 8) + c),
    ];
  }
  const x = glyph.u16();
  const y = glyph.u16();
  return [sign(flag, x), sign(flag >> 1, y)];
}

const inInt16 = (v: number) => v >= -0x8000 && v <= 0x7fff;

/** WOFF2's transformed glyf table, back to glyf and loca (W3C WOFF2, 5.1 and 5.2). */
function reconstructGlyf(
  table: Uint8Array,
  maxBytes: number,
): {
  glyf: Uint8Array;
  loca: Uint8Array;
  xMins: Int16Array;
  indexFormat: number;
} {
  const header = new FontBytes(table);
  header.u16(); // reserved
  const options = header.u16();
  const numGlyphs = header.u16();
  const indexFormat = header.u16();
  if (indexFormat > 1) broken('index format');
  const sizes = Array.from({ length: 7 }, () => header.u32());
  const streams = sizes.map((size) => new FontBytes(header.bytes(size)));
  const [nContours, nPoints, flags, glyph, composite, bbox, instructions] =
    streams as [
      FontBytes,
      FontBytes,
      FontBytes,
      FontBytes,
      FontBytes,
      FontBytes,
      FontBytes,
    ];
  const overlap = options & 1 ? header.bytes((numGlyphs + 7) >> 3) : undefined;
  const bboxBitmap = bbox.bytes(((numGlyphs + 31) >> 5) << 2);
  const hasBbox = (i: number) =>
    ((bboxBitmap[i >> 3] as number) & (0x80 >> (i & 7))) !== 0;
  const out: Uint8Array[] = [];
  const xMins = new Int16Array(numGlyphs);
  const offsets = new Array<number>(numGlyphs + 1);
  let total = 0;
  for (let i = 0; i < numGlyphs; i++) {
    offsets[i] = total;
    const contours = nContours.i16();
    let encoded: Uint8Array;
    if (contours === 0) {
      if (hasBbox(i)) broken('bbox of an empty glyph');
      continue;
    } else if (contours === -1) {
      if (!hasBbox(i)) broken('composite without bbox');
      const box = [bbox.i16(), bbox.i16(), bbox.i16(), bbox.i16()];
      const start = composite.at;
      let more = true;
      let instructed = false;
      while (more) {
        const f = composite.u16();
        composite.u16(); // the glyph index
        composite.bytes(f & 0x0001 ? 4 : 2);
        if (f & 0x0008) composite.bytes(2);
        else if (f & 0x0040) composite.bytes(4);
        else if (f & 0x0080) composite.bytes(8);
        if (f & 0x0100) instructed = true;
        more = (f & 0x0020) !== 0;
      }
      const length = composite.at - start;
      composite.at = start;
      const components = composite.bytes(length);
      const program = instructed ? instructions.bytes(glyph.u255()) : undefined;
      encoded = new Uint8Array(
        10 + length + (program ? 2 + program.byteLength : 0),
      );
      const view = new DataView(encoded.buffer);
      view.setInt16(0, -1);
      box.forEach((v, k) => view.setInt16(2 + k * 2, v));
      encoded.set(components, 10);
      if (program) {
        view.setUint16(10 + length, program.byteLength);
        encoded.set(program, 12 + length);
      }
      xMins[i] = box[0] as number;
    } else if (contours > 0) {
      const ends: number[] = [];
      let points = 0;
      for (let c = 0; c < contours; c++) {
        points += nPoints.u255();
        if (points > 0xffff) broken('too many points');
        ends.push(points - 1);
      }
      if (points > flags.left) broken('flags');
      const xs = new Int32Array(points);
      const ys = new Int32Array(points);
      const on = new Uint8Array(points);
      let x = 0;
      let y = 0;
      for (let p = 0; p < points; p++) {
        const f = flags.u8();
        on[p] = f & 0x80 ? 0 : 1;
        const [dx, dy] = triplet(f & 0x7f, glyph);
        x += dx;
        y += dy;
        if (!inInt16(x) || !inInt16(y)) broken('coordinate');
        xs[p] = x;
        ys[p] = y;
      }
      const program = instructions.bytes(glyph.u255());
      let box: number[];
      if (hasBbox(i)) {
        box = [bbox.i16(), bbox.i16(), bbox.i16(), bbox.i16()];
      } else if (points === 0) {
        box = [0, 0, 0, 0];
      } else {
        box = [Infinity, Infinity, -Infinity, -Infinity];
        for (let p = 0; p < points; p++) {
          box = [
            Math.min(box[0] as number, xs[p] as number),
            Math.min(box[1] as number, ys[p] as number),
            Math.max(box[2] as number, xs[p] as number),
            Math.max(box[3] as number, ys[p] as number),
          ];
        }
      }
      const fixed = 10 + 2 * contours + 2 + program.byteLength;
      encoded = new Uint8Array(fixed + points * 5);
      const view = new DataView(encoded.buffer);
      view.setInt16(0, contours);
      box.forEach((v, k) => view.setInt16(2 + k * 2, v));
      ends.forEach((end, c) => view.setUint16(10 + c * 2, end));
      view.setUint16(10 + 2 * contours, program.byteLength);
      encoded.set(program, 12 + 2 * contours);
      const overlapped =
        overlap !== undefined &&
        ((overlap[i >> 3] as number) & (0x80 >> (i & 7))) !== 0;
      let px = 0;
      let py = 0;
      for (let p = 0; p < points; p++) {
        encoded[fixed + p] =
          (on[p] as number) | (p === 0 && overlapped ? 0x40 : 0);
        const dx = (xs[p] as number) - px;
        const dy = (ys[p] as number) - py;
        if (!inInt16(dx) || !inInt16(dy)) broken('delta');
        view.setInt16(fixed + points + p * 2, dx);
        view.setInt16(fixed + points * 3 + p * 2, dy);
        px = xs[p] as number;
        py = ys[p] as number;
      }
      xMins[i] = box[0] as number;
    } else {
      return broken('contour count');
    }
    out.push(encoded);
    total += pad4(encoded.byteLength);
    if (total > maxBytes) broken('too large');
  }
  offsets[numGlyphs] = total;
  if (indexFormat === 0 && total > 0x1fffe) broken('short loca overflow');
  const glyf = new Uint8Array(total);
  let at = 0;
  for (const encoded of out) {
    glyf.set(encoded, at);
    at += pad4(encoded.byteLength);
  }
  const loca = new Uint8Array((numGlyphs + 1) * (indexFormat === 0 ? 2 : 4));
  const view = new DataView(loca.buffer);
  for (let i = 0; i <= numGlyphs; i++) {
    const offset = offsets[i] as number;
    if (indexFormat === 0) view.setUint16(i * 2, offset / 2);
    else view.setUint32(i * 4, offset);
  }
  return { glyf, loca, xMins, indexFormat };
}

/** WOFF2's transformed hmtx table, back to hmtx: the left side bearings left out are the glyphs' xMin. */
function reconstructHmtx(
  table: Uint8Array,
  numberOfHMetrics: number,
  numGlyphs: number,
  xMins: Int16Array,
): Uint8Array {
  if (numberOfHMetrics < 1 || numberOfHMetrics > numGlyphs)
    broken('hmtx counts');
  const r = new FontBytes(table);
  const flags = r.u8();
  if (flags & 0xfc) broken('hmtx flags');
  const advances = Array.from({ length: numberOfHMetrics }, () => r.u16());
  const lsbs = Array.from({ length: numberOfHMetrics }, (_, i) =>
    flags & 1 ? (xMins[i] as number) : r.i16(),
  );
  const rest = Array.from({ length: numGlyphs - numberOfHMetrics }, (_, i) =>
    flags & 2 ? (xMins[numberOfHMetrics + i] as number) : r.i16(),
  );
  const out = new Uint8Array(4 * numberOfHMetrics + 2 * rest.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < numberOfHMetrics; i++) {
    view.setUint16(i * 4, advances[i] as number);
    view.setInt16(i * 4 + 2, lsbs[i] as number);
  }
  rest.forEach((v, i) => view.setInt16(4 * numberOfHMetrics + i * 2, v));
  return out;
}

/** This file's URL; the pool starts it as a child process (works for the .ts source and the built .js). */
export const WORKER_URL = import.meta.url;

/**
 * The child's first argument: a pool worker (`root`, `workspace` and the memory limit in bytes
 * follow; 0: none).
 */
export const WORKER_ARG = 'openfolia-typst-worker';
/** The child's first argument: one compilation (`root`, `workspace` follow), for `compilePdf`. */
export const ONCE_ARG = 'openfolia-typst-once';
/** In a one-off compilation's root: the `CoreInput` in, the `CoreResult` out (V8 serialised). */
export const ONCE_INPUT = 'input';
export const ONCE_RESULT = 'result';

/**
 * Worker protocol. The pool starts a worker as a child process (IPC with
 * V8 serialisation, `sandboxEnv`'s environment), arguments `WORKER_ARG`,
 * its pool's private directory and a workspace the pool already created
 * inside it (so the pool always knows the path to delete). Jobs:
 * `{ id, input }` in, `{ type: 'result', id, result }` out. If the
 * workspace stops being safe, the worker replaces it and reports the new
 * path with `{ type: 'workspace', path }`; if the pool directory itself
 * stops being private, it fails the job with `brokenRoot` so the pool can
 * start over with a new directory.
 */
export interface WorkerRequest {
  id: number;
  input: CoreInput;
}
export type WorkerResponse =
  | { type: 'workspace'; path: string }
  /** `compilers`: how many compilers the worker has made so far (`CompilerCache.created`). */
  | { type: 'result'; id: number; result: CoreResult; compilers: number };

/** Whether Node runs this very file (as the child), not a file that imports it. */
function isEntry(): boolean {
  const main = process.argv[1];
  if (main === undefined) return false;
  try {
    return realpathSync(main) === realpathSync(fileURLToPath(WORKER_URL));
  } catch {
    return false;
  }
}

/**
 * Where a compiling process whose memory ran over its limit says so before it ends
 * (`watchMemory`): `memory-<pid>` in its pool's private directory, which the pool reads when the
 * process has exited (`TypstMemoryError`) and removes.
 */
export function memoryMarker(root: string, pid: number): string {
  return join(root, `memory-${pid}`);
}

/** How often a compiling process looks at its memory, in ms (`watchMemory`). */
export const MEMORY_POLL_MS = 20;

/**
 * Ends this process once its resident memory passes `limitBytes` (#396), whatever it is doing.
 * A compilation runs synchronously in native code, so the main thread cannot look: a worker
 * thread does, on its own event loop, every `MEMORY_POLL_MS`. Over the limit, it writes
 * `memoryMarker` and kills the process (SIGKILL: the compiler cannot be interrupted), so a
 * template that exhausts memory is stopped, never the server. The thread holds nothing open.
 */
function watchMemory(root: string, limitBytes: number): void {
  if (!(limitBytes > 0)) return;
  const watcher = new Worker(
    `const { workerData } = require('node:worker_threads');
const { writeFileSync } = require('node:fs');
setInterval(() => {
  if (process.memoryUsage.rss() <= workerData.limit) return;
  try { writeFileSync(workerData.marker, String(process.memoryUsage.rss()), { mode: 0o600 }); } catch {}
  process.kill(process.pid, 'SIGKILL');
}, workerData.every);`,
    {
      eval: true,
      workerData: {
        limit: limitBytes,
        marker: memoryMarker(root, process.pid),
        every: MEMORY_POLL_MS,
      },
      // Its own heap stays small; the limit is the process's.
      resourceLimits: {
        maxOldGenerationSizeMb: 16,
        maxYoungGenerationSizeMb: 4,
      },
      stdout: false,
      stderr: false,
    },
  );
  watcher.unref();
}

const [, , role, root = '', firstWorkspace = '', memoryLimit = '0'] =
  process.argv;
if ((role === WORKER_ARG || role === ONCE_ARG) && isEntry()) {
  watchMemory(root, Number(memoryLimit));
  if (role === ONCE_ARG) runOnce(root, firstWorkspace);
  else runWorker(root, firstWorkspace);
}

/** One compilation: the input from the root's `ONCE_INPUT`, the result to its `ONCE_RESULT`. */
function runOnce(root: string, workspace: string): void {
  let result: CoreResult;
  try {
    assertPrivateDirectory(root);
    const input = deserialize(
      readFileSync(join(root, ONCE_INPUT)),
    ) as CoreInput;
    result = compileToPdf(input, workspace);
  } catch (e) {
    // Not a document problem: the server's to log, never the author's to see.
    result = {
      ok: false,
      internal: `PDF compilation failed: ${(e as Error).message}`,
    };
  }
  writeFileSync(join(root, ONCE_RESULT), serialize(result), { mode: 0o600 });
}

function runWorker(root: string, first: string): void {
  const send = (message: WorkerResponse) => process.send?.(message);
  let workspace = first;
  // One compiler for the worker's jobs (#436), kept while their font set and workspace stay.
  const compilers = new CompilerCache();
  const internal = (id: number, message: string, brokenRoot = false) =>
    send({
      type: 'result',
      id,
      result: { ok: false, internal: message, brokenRoot },
      // Counted for every answer, a failed one too: a job that throws may have made a compiler
      // (which `CompilerCache` then dropped), and the pool bounds them per worker.
      compilers: compilers.created,
    });
  // The pool is gone (its process ended): nothing will ever ask again.
  process.on('disconnect', () => process.exit(0));
  // Ctrl-C in a terminal reaches the whole process group: the pool alone ends a worker.
  process.on('SIGINT', () => undefined);
  process.on('message', ({ id, input }: WorkerRequest) => {
    try {
      assertPrivateDirectory(root);
    } catch (e) {
      internal(id, `unsafe PDF pool directory: ${(e as Error).message}`, true);
      return;
    }
    try {
      try {
        assertSafeWorkspace(workspace);
      } catch {
        workspace = createWorkspace(root);
        send({ type: 'workspace', path: workspace });
      }
      const result = compilers.compile(input, workspace);
      send({ type: 'result', id, result, compilers: compilers.created });
    } catch (e) {
      // Not a document problem: the server's to log, never the author's to see.
      internal(id, `PDF compilation failed: ${(e as Error).message}`);
    }
  });
}

/**
 * The layout's warnings (`<openfolia-warning>` metadata) of a compiled document: only asked of a
 * designed manual, or of one with a callout legend beside its image. A query that fails gives none; the PDF stands without them.
 */
function layoutQuery(
  compiler: NodeCompiler,
  doc: Parameters<NodeCompiler['query']>[0],
): unknown[] {
  try {
    const values: unknown = compiler.query(doc, {
      selector: '<openfolia-warning>',
      field: 'value',
    });
    return Array.isArray(values) ? values : [];
  } catch {
    return [];
  }
}
