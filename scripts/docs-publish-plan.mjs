// What `pnpm docs:publish` does, decided from its arguments, the environment and the working tree
// before anything runs (scripts/docs-publish.mjs runs it). Pure, so its checks are tested
// (scripts/__tests__/docs-publish-plan.test.ts).
import { IMAGE_REPOSITORY, RELEASE_TAG } from './release-digests.mjs';

/** The project's own repository, as the docs site's settings default to it. */
export const DEFAULT_REPOSITORY_URL = 'https://github.com/openfolia/openfolia';

/**
 * The platforms a pushed image is built for: arm64 first (the docs server's), amd64 beside it.
 * The image holds no code of its own to compile, so the second platform costs a few seconds.
 */
export const DEFAULT_PLATFORMS = Object.freeze(['linux/arm64', 'linux/amd64']);

/** The moving tag, unless `--tag` names another. */
export const DEFAULT_TAG = 'latest';

/** A Docker tag. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** A platform as buildx names one: `linux/arm64`, `linux/arm/v7`. */
const PLATFORM = /^[a-z0-9]+\/[a-z0-9]+(\/v[0-9]+)?$/;

/** A full commit SHA. */
const COMMIT = /^[0-9a-f]{40}$/;

const USAGE =
  'usage: pnpm docs:publish [--release vX.Y.Z] [--push] [--tag <tag>] [--platform <os/arch,...>]';

/** The settings the command sets itself, and which the environment must not set beside it. */
const RELEASE_ONLY = [
  'DOCS_RELEASE_DIGESTS',
  'DOCS_RELEASE_SIGNATURES',
  'DOCS_RELEASE_URL',
  'DOCS_RELEASE_SIGNER_IDENTITY',
  'DOCS_RELEASE_SIGNER_ISSUER',
];

function fail(message) {
  throw new Error(`docs:publish: ${message}`);
}

/** `--release`, `--push`, `--tag` and `--platform`, each checked; anything else throws. */
export function parseArgs(argv) {
  const args = { release: null, push: false, tag: null, platforms: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') fail(USAGE);
    if (!['--release', '--push', '--tag', '--platform'].includes(arg))
      fail(`unexpected argument ${JSON.stringify(arg)}\n${USAGE}`);
    if (seen.has(arg)) fail(`${arg} is given twice`);
    seen.add(arg);
    if (arg === '--push') {
      args.push = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('-'))
      fail(`${arg} needs a value\n${USAGE}`);
    if (arg === '--release') {
      if (!RELEASE_TAG.test(value))
        fail(
          `--release must be a release's tag such as v1.2.3, not "${value}"`,
        );
      args.release = value;
    } else if (arg === '--tag') {
      if (!TAG.test(value))
        fail(
          `--tag must be a Docker tag (letters, digits, _ . -; at most 128), not "${value}"`,
        );
      if (/^sha-/.test(value) || RELEASE_TAG.test(value))
        fail(
          `--tag names the moving tag instead of "latest"; "${value}" looks like a commit's or a release's tag, which the command sets itself`,
        );
      args.tag = value;
    } else {
      const platforms = value.split(',').map((p) => p.trim());
      if (platforms.some((p) => !PLATFORM.test(p)))
        fail(
          `--platform must be a comma-separated list such as linux/arm64,linux/amd64, not "${value}"`,
        );
      if (new Set(platforms).size !== platforms.length)
        fail(`--platform names a platform twice: "${value}"`);
      args.platforms = platforms;
    }
  }
  return args;
}

/** An absolute http(s) URL from the environment, or a refusal naming the setting. */
function requiredUrl(env, name, why) {
  const raw = env[name]?.trim();
  if (!raw) fail(`${name} must be set ${why} (.env.example, "Docs site")`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${name} must be an absolute http(s) URL, not "${raw}"`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    fail(`${name} must be an http(s) URL, not "${raw}"`);
  return parsed;
}

/** The image repository: DOCS_PUBLISH_IMAGE, or `ghcr.io/<owner>/openfolia-docs`. */
export function imageRepository(env) {
  const set = env.DOCS_PUBLISH_IMAGE?.trim();
  if (set) {
    if (!IMAGE_REPOSITORY.test(set))
      fail(
        `DOCS_PUBLISH_IMAGE must be an image repository without a tag, such as ghcr.io/openfolia/openfolia-docs, not "${set}"`,
      );
    return set;
  }
  // As DOCS_IMAGES' default (frontend/docs/scripts/lib/settings.mjs): the registry of the
  // repository's GitHub owner.
  let owner = 'openfolia';
  try {
    const repository = new URL(
      env.DOCS_REPOSITORY_URL?.trim() || DEFAULT_REPOSITORY_URL,
    );
    const first = repository.pathname.split('/')[1]?.toLowerCase();
    if (
      repository.hostname === 'github.com' &&
      first &&
      /^[a-z0-9-]+$/.test(first)
    )
      owner = first;
  } catch {
    // An invalid DOCS_REPOSITORY_URL fails the site's build with its own message.
  }
  return `ghcr.io/${owner}/openfolia-docs`;
}

/**
 * The plan: the site's build environment, the image's tags, labels and platforms, and the
 * `docker buildx build` arguments. `git` is `{ sha, dirty, tags, tagIsAncestor, changedSinceTag }`
 * of the working tree (`tags`: the tags on HEAD; the last two, for a release's push from an
 * untagged HEAD: whether the release's tag is an ancestor of HEAD, and the files that differ
 * between them). Every refusal throws before anything is built.
 */
export function planPublish({ args, env, git }) {
  if (!COMMIT.test(git.sha ?? '')) fail(`no commit to publish ("${git.sha}")`);
  if (args.push && git.dirty)
    fail(
      'the working tree has changes; commit or remove them first, so the published image matches a commit (git status)',
    );
  if (env.DOCS_RELEASE?.trim())
    fail(
      'DOCS_RELEASE is set in the environment; unset it and pass --release vX.Y.Z instead',
    );
  if (args.release === null) {
    const stray = RELEASE_ONLY.filter((name) => env[name]?.trim());
    if (stray.length > 0)
      fail(
        `${stray.join(', ')} belong to a release's docs: pass --release vX.Y.Z, or unset them for the development docs`,
      );
  } else {
    if (!env.DOCS_RELEASE_DIGESTS?.trim())
      fail(
        `DOCS_RELEASE_DIGESTS must be set for a release's docs: the text of the release's images.lock (CONTRIBUTING.md, "Releases"), DOCS_RELEASE_DIGESTS="$(cat images.lock)"`,
      );
    // A release's docs are its tag's: pushed as vX.Y.Z and latest, they must be built from it, or
    // from a later commit that differs only in the changelog the release workflow adds after it.
    if (args.push && !(git.tags ?? []).includes(args.release)) {
      if (!git.tagIsAncestor)
        fail(
          `the release's docs are built from its tag or from a commit after it: check out ${args.release} (git checkout ${args.release}) or the commit that adds its changelog; HEAD is not tagged ${args.release} and does not descend from it`,
        );
      const other = (git.changedSinceTag ?? []).filter(
        (file) => file !== 'CHANGELOG.md' && !file.startsWith('changelog/'),
      );
      if (other.length > 0)
        fail(
          `HEAD is not tagged ${args.release} and differs from it in more than the changelog (CHANGELOG.md, changelog/): ${other.join(', ')}; check out ${args.release} or the commit that adds its changelog`,
        );
    }
  }
  const why =
    args.release === null
      ? 'for the development docs (no --release)'
      : "for a release's docs";
  const site = requiredUrl(env, 'DOCS_SITE_URL', why);
  // As the site's build requires (frontend/docs/scripts/lib/settings.mjs), checked here first.
  if (args.release !== null && site.protocol !== 'https:')
    fail(`DOCS_SITE_URL must be an https:// URL for a release's docs`);

  const image = imageRepository(env);
  const short = git.sha.slice(0, 7);
  // A local build of a changed tree is not that commit: its tag says so.
  const shaTag = `sha-${short}${git.dirty ? '-dirty' : ''}`;
  const tags = [args.tag ?? DEFAULT_TAG];
  if (args.release !== null) tags.push(args.release);
  tags.push(shaTag);
  const references = tags.map((tag) => `${image}:${tag}`);

  const repositoryUrl =
    env.DOCS_REPOSITORY_URL?.trim().replace(/\/+$/, '') ||
    DEFAULT_REPOSITORY_URL;
  const labels = {
    'org.opencontainers.image.title': 'openfolia-docs',
    'org.opencontainers.image.description':
      'The OpenFolia documentation site, served by Caddy on port 8080.',
    'org.opencontainers.image.source': repositoryUrl,
    'org.opencontainers.image.url': site.href.replace(/\/+$/, ''),
    'org.opencontainers.image.licenses': 'AGPL-3.0-only',
    'org.opencontainers.image.revision': git.sha,
    'org.opencontainers.image.version': args.release ?? shaTag,
  };

  // A push builds every platform; a local build the machine's own unless --platform names one
  // (it then loads that image into the local image store).
  const platforms = args.push
    ? (args.platforms ?? [...DEFAULT_PLATFORMS])
    : args.platforms;

  // Only the environment the checks above saw: Nx would otherwise fill in settings from the
  // git-ignored dotenv files at the root and in the project, which no check reads.
  const buildEnv = {
    DOCS_RELEASE: args.release ?? undefined,
    NX_LOAD_DOT_ENV_FILES: 'false',
  };

  const docker = [
    'buildx',
    'build',
    '--file',
    'deploy/docker/docs/Dockerfile',
    '--build-context',
    'site=frontend/docs/out',
  ];
  for (const [key, value] of Object.entries(labels))
    docker.push('--label', `${key}=${value}`);
  for (const reference of references) docker.push('--tag', reference);
  if (platforms) docker.push('--platform', platforms.join(','));
  if (args.push)
    docker.push('--provenance', 'mode=max', '--sbom', 'true', '--push');
  else docker.push('--load');

  return {
    release: args.release,
    push: args.push,
    image,
    tags,
    references,
    platforms,
    labels,
    buildEnv,
    docker,
  };
}
