#!/usr/bin/env node
// A release's images pinned by their digests (#739): the release workflow runs this once every
// image of the tag is pushed (.github/workflows/images.yml, job `release-files`), and so can a
// maintainer, against any registry.
//
//   node scripts/release-digests.mjs --images <registry/path> --tag vX.Y.Z --out <dir> \
//     [--compose deploy/compose.yaml] [--expect <file>]
//
// For each image (scripts/images-plan.mjs, IMAGES) it reads the digest the tag names now, with
// `docker buildx imagetools inspect` (a read of that registry and nothing else), checks it against
// the digest the build pushed when given one (`--expect`, lines `<image> <digest>`), and writes:
//
// - `images.lock`: every image of the release, `<registry/path>/<image>:<tag>@sha256:<digest>`,
//   one per line. It is also what the docs of the release are built with (DOCS_RELEASE_DIGESTS).
// - `compose.digests.yaml`: a Compose override that gives every service of compose.yaml that runs
//   an OpenFolia image that image by tag and digest. With
//   `COMPOSE_FILE=compose.yaml:compose.digests.yaml`, Docker pulls and runs exactly those images:
//   a tag moved in the registry later changes nothing.
//
// The docs build (frontend/docs/scripts/lib/agent-guide.mjs) makes the same override from
// images.lock with the functions below, so the install guide names its SHA-256.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMAGES } from './images-plan.mjs';

/** An image repository without a tag: `registry[:port]/path`, lowercase, as Docker names one. */
export const IMAGE_REPOSITORY =
  /^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;

/** A release's tag, `v1.2.3`. */
export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A manifest's digest, as a registry names it. */
export const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** How compose.yaml names an OpenFolia image: by the settings, the image's name between them. */
const COMPOSE_IMAGE =
  /^\$\{OPENFOLIA_IMAGES:-openfolia\}\/([a-z0-9-]+):\$\{OPENFOLIA_VERSION:-local\}$/;

/** `--images`, `--tag`, `--out` and `--compose`, each checked; anything else throws. */
export function parseArgs(argv) {
  const args = {
    images: null,
    tag: null,
    out: null,
    compose: 'deploy/compose.yaml',
    expect: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (
      !['images', 'tag', 'out', 'compose', 'expect'].includes(name ?? '') ||
      !argv[i]?.startsWith('--')
    )
      throw new Error(`release-digests: unexpected argument ${argv[i]}`);
    if (value === undefined || value.startsWith('-'))
      throw new Error(`release-digests: --${name} needs a value`);
    args[name] = value;
  }
  if (!args.images || !IMAGE_REPOSITORY.test(args.images))
    throw new Error(
      'release-digests: --images must be an image repository without a tag, such as ghcr.io/openfolia/openfolia',
    );
  if (!args.tag || !RELEASE_TAG.test(args.tag))
    throw new Error(
      "release-digests: --tag must be a release's tag such as v1.2.3",
    );
  if (!args.out)
    throw new Error('release-digests: --out names the folder to write');
  return args;
}

/**
 * The digests the build pushed (`--expect`: lines `<image> <digest>`, the build job's own record),
 * checked against what the registry names now: a tag moved after the push, or an image the build
 * did not push, throws instead of being recorded as the release's.
 */
export function checkExpected(digests, expectedText) {
  const expected = {};
  for (const line of expectedText.split('\n').filter((l) => l.trim())) {
    const [image, digest, ...rest] = line.trim().split(/\s+/);
    if (!IMAGES.includes(image) || !DIGEST.test(digest ?? '') || rest.length)
      throw new Error(`release-digests: no image and digest in "${line}"`);
    if (expected[image])
      throw new Error(`release-digests: ${image} is expected twice`);
    expected[image] = digest;
  }
  for (const image of IMAGES) {
    if (!expected[image])
      throw new Error(
        `release-digests: the build recorded no digest for ${image}`,
      );
    if (expected[image] !== digests[image])
      throw new Error(
        `release-digests: the registry names ${digests[image]} for ${image}, the build pushed ${expected[image]}: the tag moved`,
      );
  }
}

/** The digest in `imagetools inspect --format '{{json .Manifest}}'`'s output; anything else throws. */
export function manifestDigest(output, ref) {
  let digest;
  try {
    digest = JSON.parse(output)?.digest;
  } catch {
    digest = undefined;
  }
  if (typeof digest !== 'string' || !DIGEST.test(digest))
    throw new Error(`release-digests: no digest for ${ref}`);
  return digest;
}

/**
 * The services of a compose file (parsed, YAML merge keys resolved) that run an OpenFolia image,
 * in the file's order: `{ service, image }`. A service whose image names the settings in any other
 * way throws, so none is ever left unpinned by accident.
 */
export function pinnedServices(compose) {
  const services = [];
  for (const [service, definition] of Object.entries(compose?.services ?? {})) {
    const image = definition?.image;
    if (typeof image !== 'string' || !image.includes('OPENFOLIA_')) continue;
    const match = COMPOSE_IMAGE.exec(image);
    if (!match)
      throw new Error(
        `release-digests: the service ${service} names its image as "${image}", not as \${OPENFOLIA_IMAGES:-openfolia}/<image>:\${OPENFOLIA_VERSION:-local}`,
      );
    services.push({ service, image: match[1] });
  }
  if (services.length === 0)
    throw new Error(
      'release-digests: the compose file runs no OpenFolia image',
    );
  return services;
}

/** An image's full reference, by tag and digest. */
export const pinnedRef = ({ images, tag, image, digest }) =>
  `${images}/${image}:${tag}@${digest}`;

/** `images.lock`: every image of `digests` ({ image: digest }), in IMAGES' order. */
export function lockText({ images, tag, digests }) {
  return (
    IMAGES.map((image) => {
      if (!digests[image])
        throw new Error(`release-digests: no digest for ${image}`);
      return pinnedRef({ images, tag, image, digest: digests[image] });
    }).join('\n') + '\n'
  );
}

/**
 * `images.lock`'s text read back: `{ image: digest }`, each line checked against the repository
 * and tag it must name. Lines may be separated by any white space (an environment variable).
 */
export function parseLock(text, { images, tag }) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(
    `^${escape(images)}/([a-z0-9-]+):${escape(tag)}@(sha256:[0-9a-f]{64})$`,
  );
  const digests = {};
  for (const ref of text.split(/\s+/).filter(Boolean)) {
    const match = line.exec(ref);
    if (!match)
      throw new Error(
        `"${ref}" is no image of ${images} at ${tag} pinned by its digest`,
      );
    if (!IMAGES.includes(match[1]))
      throw new Error(
        `"${ref}" names no image of a release (${IMAGES.join(', ')})`,
      );
    if (digests[match[1]])
      throw new Error(`the image ${match[1]} is named twice`);
    digests[match[1]] = match[2];
  }
  return digests;
}

/** `compose.digests.yaml`: each pinned service's image by tag and digest. */
export function overrideText({ images, tag, digests, services }) {
  const lines = [
    `# OpenFolia ${tag}: every image of compose.yaml pinned by its digest (#739), made by the release`,
    "# (scripts/release-digests.mjs). Use it with that release's compose.yaml, in the same folder:",
    '#   COMPOSE_FILE=compose.yaml:compose.digests.yaml',
    'services:',
  ];
  for (const { service, image } of services) {
    if (!digests[image])
      throw new Error(`release-digests: no digest for ${image}`);
    lines.push(
      `  ${service}:`,
      `    image: ${pinnedRef({ images, tag, image, digest: digests[image] })}`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * What the install guide checks the running containers against, per service: the reference Docker
 * records for the image it pulled by digest (`docker image inspect`, RepoDigests), and the
 * reference the settings must name for it (`docker compose config --images`), by tag and digest.
 */
export function repoDigestLines({ images, tag, digests, services }) {
  return services
    .map(
      ({ service, image }) =>
        `${service} ${images}/${image}@${digests[image]} ${pinnedRef({ images, tag, image, digest: digests[image] })}`,
    )
    .join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { parse } = await import('yaml');
  const services = pinnedServices(
    parse(readFileSync(args.compose, 'utf8'), { merge: true }),
  );
  const digests = {};
  for (const image of IMAGES) {
    const ref = `${args.images}/${image}:${args.tag}`;
    const output = execFileSync(
      'docker',
      [
        'buildx',
        'imagetools',
        'inspect',
        ref,
        '--format',
        '{{json .Manifest}}',
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    digests[image] = manifestDigest(output, ref);
  }
  if (args.expect !== null)
    checkExpected(digests, readFileSync(args.expect, 'utf8'));
  const values = { images: args.images, tag: args.tag, digests, services };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'images.lock'), lockText(values));
  writeFileSync(join(args.out, 'compose.digests.yaml'), overrideText(values));
  process.stdout.write(lockText(values));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
