// What `pnpm pr:assets <PR> <images…>` does, with GitHub and the disk injected so a test
// runs it against fakes (scripts/pr-assets.mjs is the shell): the arguments, which files go and
// under which names, the Markdown, and the run. The upload itself (one commit on the
// `pr-assets` branch through GitHub's API) is scripts/pr-assets-github.mjs.
//
// Why the API and not `git push`: nothing touches a working tree, the index or a local branch,
// and no agent pushes a branch but its own (the guard, docs/agent-rules.md, which names this
// one exception). It writes only the current repository's ASSETS_BRANCH, never force; only
// image files it recognised by their first bytes, so a stray secrets file or a source file
// can't be published by a wrong argument; and only the files (or the folder) named, so old
// shots lying around never reach a PR by default.
import path from 'node:path';

import { ASSETS_BRANCH, upload } from './pr-assets-github.mjs';

/** Bigger than any full-page screenshot; keeps a wrong file (a video, a dump) out. */
export const MAX_BYTES = 10 * 1024 * 1024;

export const USAGE = `Usage: pnpm pr:assets <PR number> <image files…> [--dry-run]
       pnpm pr:assets <PR number> --dir <dir> [--dry-run]

Uploads a PR's screenshots to this repository's \`${ASSETS_BRANCH}\` branch (pr-<N>/, one
commit through GitHub's API: no git push, no local branch) and prints Markdown image links for
the PR body, pinned to that commit.

  --dir <dir>   every image in <dir> (put them in a fresh one)
  --dry-run     check the files and print the plan; writes nothing to GitHub`;

/**
 * The command line, parsed: `{ help: true }` or `{ pr, files, dir, dryRun }` (`dir`: every
 * image in it too, or null). Throws on anything it doesn't understand, and on nothing named.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const files = [];
  let pr = null;
  let dir = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--dir') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('-'))
        throw new Error(`${arg} needs a value.`);
      if (dir !== null) throw new Error('One --dir at a time.');
      dir = value;
    } else if (arg.startsWith('-'))
      throw new Error(`Unknown option ${arg}.\n\n${USAGE}`);
    else if (pr === null) {
      if (!/^[1-9]\d{0,8}$/.test(arg))
        throw new Error(`${arg}: the PR's number comes first.`);
      pr = Number(arg);
    } else files.push(arg);
  }
  if (pr === null) throw new Error(`No PR number given.\n\n${USAGE}`);
  if (files.length === 0 && dir === null) {
    throw new Error(
      `Name the images, or --dir for every image in a folder.\n\n${USAGE}`,
    );
  }
  return { help: false, pr, files, dir, dryRun };
}

/** The image types it uploads, by their first bytes. */
const SIGNATURES = [
  {
    type: 'png',
    test: (b) =>
      b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  {
    type: 'jpeg',
    test: (b) => b.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')),
  },
  {
    type: 'webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    type: 'gif',
    test: (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  },
];
const EXTENSIONS = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  webp: ['.webp'],
  gif: ['.gif'],
};

/** Whether `name` looks like an image by its extension (for picking a folder's files). */
export const isImageName = (name) => /\.(png|jpe?g|webp|gif)$/i.test(name);

/**
 * Why `bytes` (the file `name`) can't be uploaded, or null: not an image its extension says,
 * empty, or too big.
 * @param {string} name
 * @param {Buffer} bytes
 */
export function imageProblem(name, bytes) {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > MAX_BYTES)
    return `bigger than ${MAX_BYTES / 1024 / 1024} MB`;
  const kind = SIGNATURES.find((s) => s.test(bytes))?.type;
  if (!kind) return 'not a PNG, JPEG, WebP or GIF image';
  if (!EXTENSIONS[kind].includes(path.extname(name).toLowerCase())) {
    return `a ${kind.toUpperCase()} image under another extension`;
  }
  return null;
}

/**
 * The name a file gets on the branch: its base name, lower case, anything but letters, digits,
 * `.`, `_` and `-` as `-`.
 * @param {string} file
 */
export function assetName(file) {
  return path
    .basename(file)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '');
}

/**
 * The files to upload, read and checked: `[{ file, name, path, bytes }]` (`path`: on the branch,
 * `pr-<N>/<name>`): the named files, then every image in `dir`. Throws listing every file that
 * can't go, or two that would get one name.
 * @param {{ pr: number, files: string[], dir: string | null }} args
 * @param {{ readFile: (file: string) => Buffer, listDir: (dir: string) => string[] }} io
 */
export function collectImages(args, io) {
  const dir = args.dir;
  const inDir = dir
    ? io
        .listDir(dir)
        .filter(isImageName)
        .sort()
        .map((name) => path.join(dir, name))
    : [];
  if (dir && inDir.length === 0) throw new Error(`No images in ${dir}/.`);
  const problems = [];
  const byName = new Map();
  // A file named and also in the folder goes once, as it was named.
  const seen = new Set();
  const files = [...args.files, ...inDir].filter((f) => {
    const key = path.resolve(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const images = files.map((file) => {
    const bytes = io.readFile(file);
    const problem = imageProblem(file, bytes);
    if (problem) problems.push(`${file}: ${problem}`);
    const name = assetName(file);
    if (byName.has(name))
      problems.push(`${file} and ${byName.get(name)} both become ${name}`);
    byName.set(name, file);
    return { file, name, path: `pr-${args.pr}/${name}`, bytes };
  });
  if (problems.length)
    throw new Error(`Nothing uploaded:\n  ${problems.join('\n  ')}`);
  return images;
}

/**
 * The Markdown for the PR body: one image per line, alt text its name, the link on github.com
 * pinned to `ref` (the commit, so a later upload never changes an older PR's pictures; it
 * shows to whoever may read the repository, a private one too).
 * @param {string} repo owner/name
 * @param {string} ref
 * @param {{ name: string, path: string }[]} images
 */
export function markdownLinks(repo, ref, images) {
  return images
    .map(
      ({ name, path: p }) =>
        `![${name}](https://github.com/${repo}/blob/${ref}/${p}?raw=true)`,
    )
    .join('\n');
}

/**
 * The whole run: checks the images, then (unless `dryRun`) uploads them to the current
 * repository (`io.currentRepo()`, owner/name) and returns the lines to print.
 * @param {{ pr: number, files: string[], dir: string | null, dryRun: boolean }} args
 * @param {{ gh: (args: string[], input?: string) => string, readFile: (f: string) => Buffer,
 *   listDir: (d: string) => string[], currentRepo: () => string }} io
 * @returns {string[]}
 */
export function runPrAssets(args, io) {
  const images = collectImages(args, io);
  const repo = io.currentRepo();
  const list = images.map(
    ({ file, path: p }) => `  ${file} → ${ASSETS_BRANCH}:${p}`,
  );
  if (args.dryRun) {
    return [
      `Dry run: would upload ${images.length} image(s) to ${repo}, branch ${ASSETS_BRANCH}:`,
      ...list,
      '',
      'The PR body would get (the commit in place of <commit>):',
      markdownLinks(repo, '<commit>', images),
    ];
  }
  const commit = upload(io.gh, repo, args.pr, images);
  return [
    `Uploaded ${images.length} image(s) to ${repo}, ${ASSETS_BRANCH} at ${commit.slice(0, 12)}:`,
    ...list,
    '',
    'For the PR body:',
    markdownLinks(repo, commit, images),
  ];
}
