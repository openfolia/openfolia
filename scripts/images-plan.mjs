#!/usr/bin/env node
// Which container images a change affects (.github/workflows/images.yml, job `plan`; #714).
//
//   node scripts/images-plan.mjs [--base <commit>]
//
// Prints `images=<JSON list>` and `unaffected=<JSON list>`, the lines the workflow appends to
// $GITHUB_OUTPUT. Without --base (a release tag, or no earlier commit to compare with) every
// image is affected. With one, every image is when a file every image is built from changed
// (REBUILD_ALL); otherwise an image is affected when the Nx project it is built from is: Nx
// follows the dependencies, so a change in packages/content-model rebuilds the API, the backup
// image, the MCP server and the editor.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Every image the workflow builds and pushes, with the Nx project it is built from. `backup` is
 * the API image plus the Postgres client (the Dockerfile, target `backup`), so whatever rebuilds
 * the API rebuilds it; its own part of the build lives in the Dockerfile and deploy/, which
 * REBUILD_ALL covers. `embedder` is the local embedding worker
 * (deploy/compose.embedder.yaml, #532).
 */
export const IMAGE_PROJECTS = Object.freeze({
  api: 'api',
  backup: 'api',
  editor: 'editor',
  embedder: 'embedder',
  mcp: 'mcp',
});

export const IMAGES = Object.freeze(Object.keys(IMAGE_PROJECTS));

/**
 * The files every image is built from (or that decide which are built): a change to one of
 * them rebuilds every image.
 */
export const REBUILD_ALL =
  /^(Dockerfile|\.dockerignore|deploy\/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.github\/workflows\/images\.yml|scripts\/images-plan\.mjs)/;

/**
 * The affected and the unaffected images. `changedFiles` is null when there is nothing to
 * compare with (every image then); `affectedProjects` is called, at most once, only when the
 * files alone don't decide it, and returns the names of the affected Nx projects.
 */
export function planImages({ changedFiles, affectedProjects }) {
  let images;
  if (changedFiles === null || changedFiles.some((f) => REBUILD_ALL.test(f))) {
    images = [...IMAGES];
  } else {
    const projects = new Set(affectedProjects());
    images = IMAGES.filter((image) => projects.has(IMAGE_PROJECTS[image]));
  }
  return {
    images,
    unaffected: IMAGES.filter((image) => !images.includes(image)),
  };
}

/** The workflow's output lines for a plan. */
export function outputLines({ images, unaffected }) {
  return [
    `images=${JSON.stringify(images)}`,
    `unaffected=${JSON.stringify(unaffected)}`,
  ];
}

/** `--base <commit SHA>`, or null. Only a SHA, so it never reaches git or Nx as an option. */
export function parseArgs(argv) {
  let base = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && /^[0-9a-f]{7,64}$/.test(argv[i + 1] ?? '')) {
      base = argv[++i];
    } else {
      throw new Error(`images-plan: unexpected argument ${argv[i]}`);
    }
  }
  return { base };
}

function main() {
  const { base } = parseArgs(process.argv.slice(2));
  const run = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  const changedFiles =
    base === null
      ? null
      : run('git', ['diff', '--name-only', base, 'HEAD'])
          .split('\n')
          .filter(Boolean);
  const plan = planImages({
    changedFiles,
    affectedProjects: () =>
      JSON.parse(
        run('pnpm', [
          'exec',
          'nx',
          'show',
          'projects',
          '--affected',
          `--base=${base}`,
          '--head=HEAD',
          '--json',
        ]),
      ),
  });
  console.log(outputLines(plan).join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
