#!/usr/bin/env node
// Builds the public docs site and its container image, and with --push publishes the image
// (#798; deploy/README.md, "The docs site"):
//
//   pnpm docs:publish [--release vX.Y.Z] [--push] [--tag <tag>] [--platform <os/arch,...>]
//
// 1. Checks the arguments, the settings and the working tree (scripts/docs-publish-plan.mjs):
//    the development docs need DOCS_SITE_URL; a release's docs also
//    DOCS_RELEASE_DIGESTS; a push needs a clean working tree, and a release's push HEAD at the
//    release's tag or after it with only the changelog differing.
// 2. Builds the site (`nx run docs:build`) with the DOCS_* settings of the environment, and
//    DOCS_RELEASE from --release.
// 3. Builds the image (deploy/docker/docs/Dockerfile) with `docker buildx build`, tagged
//    `latest` (or --tag), the release's tag and `sha-<commit>`. Without --push it is loaded into
//    the local image store, for the machine's own platform unless --platform names one; with
//    --push it is built for linux/arm64 and linux/amd64 (or --platform) and pushed, with an
//    SBOM and provenance. Signing in to the registry is the maintainer's (`docker login`).
// 4. Prints the image's references and its digest.
//
// Nothing here needs CI: a workflow can run the same command once it has `docker login`.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, planPublish } from './docs-publish-plan.mjs';

/** Runs a command with its output on the terminal; a failure throws. */
function runVisible(command, args, { env, cwd }) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `docs:publish: ${command} ${args.slice(0, 3).join(' ')} … failed (exit ${result.status})`,
    );
}

/** Runs a command and returns its output. */
function read(command, args, { cwd }) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' });
}

/**
 * The whole command, its effects injected (`read`, `run`, `log`) so the order of its steps is
 * tested: nothing is built before every check has passed.
 */
export function publish({
  argv,
  env,
  cwd,
  read: readOutput = read,
  run = runVisible,
  log = console.log,
  readMetadata = (file) => JSON.parse(readFileSync(file, 'utf8')),
}) {
  const args = parseArgs(argv);
  const git = {
    sha: readOutput('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
    dirty:
      readOutput('git', ['status', '--porcelain'], { cwd }).trim().length > 0,
    tags: readOutput('git', ['tag', '--points-at', 'HEAD'], { cwd })
      .split('\n')
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
  // A release's push from a commit after its tag: how that commit relates to the tag.
  if (args.release && args.push && !git.tags.includes(args.release)) {
    try {
      readOutput(
        'git',
        ['merge-base', '--is-ancestor', `refs/tags/${args.release}`, 'HEAD'],
        { cwd },
      );
      git.tagIsAncestor = true;
      git.changedSinceTag = readOutput(
        'git',
        [
          'diff',
          '--name-only',
          '--no-renames',
          `refs/tags/${args.release}`,
          'HEAD',
          '--',
        ],
        { cwd },
      )
        .split('\n')
        .map((file) => file.trim())
        .filter(Boolean);
    } catch {
      // No such tag here, or HEAD does not descend from it: the plan refuses.
      git.tagIsAncestor = false;
    }
  }
  const plan = planPublish({ args, env, git });
  // Docker and buildx before the site's build, which takes minutes.
  readOutput('docker', ['buildx', 'version'], { cwd });

  log(
    `docs:publish: building the ${plan.release ? `docs of ${plan.release}` : 'development docs'} (nx run docs:build)`,
  );
  const buildEnv = { ...env, ...plan.buildEnv };
  for (const [key, value] of Object.entries(buildEnv))
    if (value === undefined) delete buildEnv[key];
  run('pnpm', ['nx', 'run', 'docs:build', '--output-style=static'], {
    env: buildEnv,
    cwd,
  });

  const dir = mkdtempSync(join(tmpdir(), 'docs-publish-'));
  const metadataFile = join(dir, 'metadata.json');
  try {
    log(
      `docs:publish: building the image${plan.push ? ` for ${plan.platforms.join(', ')} and pushing it` : ''}`,
    );
    run('docker', [...plan.docker, '--metadata-file', metadataFile, '.'], {
      env,
      cwd,
    });
    const metadata = readMetadata(metadataFile);
    const digest = metadata['containerimage.digest'] ?? null;
    log('');
    log(plan.push ? 'Pushed:' : 'Built (not pushed):');
    for (const reference of plan.references) log(`  ${reference}`);
    if (digest) {
      log(`Digest: ${digest}`);
      if (plan.push) log(`Pull by digest: ${plan.image}@${digest}`);
    }
    if (!plan.push)
      log(
        `Try it: docker run --rm -p 8080:8080 ${plan.references[0]} (then http://127.0.0.1:8080/)`,
      );
    return { plan, digest };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  try {
    publish({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
