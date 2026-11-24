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
 * Every image the workflow builds and pushes, with the Nx projects it is built from: it is affected
 * when any of them is. `backup` is the API image plus the Postgres client (the Dockerfile, target
 * `backup`), so whatever rebuilds the API rebuilds it; its own part of the build lives in the
 * Dockerfile and deploy/, which REBUILD_ALL covers. `embedder` is the local embedding worker
 * (deploy/compose.embedder.yaml, #532); `portal` the reader portal (#819), which also renders
 * with render-html and content-model, so Nx rebuilds it with them; `sandbox` the public sandbox
 * (#827): the API, the editor and the embedded database in one image, with the demo's state baked
 * in (scripts/demo/, IMAGE_FILES); `sandbox-launcher` the public demo's launcher and agent (#828);
 * `demo-portal` the demo's shared portal, built from the baked state with the portal (#828).
 */
export const IMAGE_PROJECTS = Object.freeze({
  api: ['api'],
  backup: ['api'],
  editor: ['editor'],
  embedder: ['embedder'],
  mcp: ['mcp'],
  portal: ['portal'],
  sandbox: ['api', 'editor', 'sandbox'],
  'sandbox-launcher': ['sandbox-launcher'],
  'demo-portal': ['api', 'sandbox', 'portal'],
});

/**
 * Files of no image's Nx project that one image is built from: a change to one rebuilds that
 * image. The sandbox bakes the demo's state with scripts/demo/ (the workflow project, which no
 * other image needs), and the demo portal is built from it (scripts/demo/portal.mjs).
 */
export const IMAGE_FILES = Object.freeze({
  sandbox: /^scripts\/demo\//,
  'demo-portal': /^scripts\/demo\//,
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
    const byFiles = (image) =>
      IMAGE_FILES[image] !== undefined &&
      changedFiles.some((f) => IMAGE_FILES[image].test(f));
    let projects;
    images = IMAGES.filter((image) => {
      if (byFiles(image)) return true;
      projects ??= new Set(affectedProjects());
      return IMAGE_PROJECTS[image].some((project) => projects.has(project));
    });
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
