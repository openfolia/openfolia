// The docs site's own settings, read from the environment of its build (`.env.example`, "Docs
// site"). Each is a URL; an invalid one fails the build rather than publishing broken links.
import { parseLock } from '../../../../scripts/release-digests.mjs';
import {
  GITHUB_ACTIONS_ISSUER,
  githubSignerIdentity,
  parseSignatureSums,
} from '../../../../scripts/release-signatures.mjs';

/** The project's own repository, where the site links unless DOCS_REPOSITORY_URL names another. */
export const DEFAULT_REPOSITORY_URL = 'https://github.com/openfolia/openfolia';

/** A URL without a trailing slash, or the fallback when unset; an invalid URL throws. */
function url(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, not "${raw}"`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error(`${name} must be an http(s) URL, not "${raw}"`);
  const href = parsed.href.replace(/\/+$/, '');
  // The URLs go into the agent guide's shell commands and into MDX (#423): only the characters
  // an address needs, never a quote, `$`, a backtick or braces, and no query or fragment.
  if (!SAFE_URL.test(href))
    throw new Error(
      `${name} may hold only letters, digits and . _ ~ : / % - (no query or fragment), not "${raw}"`,
    );
  return href;
}

const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/%-]+$/;

/** Plain HTTP only to this machine, as a test: a release's guide is fetched and run by agents. */
function requireHttps(name, value) {
  const { protocol, hostname } = new URL(value);
  if (protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(hostname))
    throw new Error(
      `${name} must be an https:// URL for a release's docs (DOCS_RELEASE), not "${value}"`,
    );
}

/**
 * A release's version, as its tag names it: `v1.2.3`. Not a pre-release: the release workflow
 * attaches the files the guide downloads to a release's tag only.
 */
export const RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** An image repository without a tag: `registry[:port]/path`, lowercase, as Docker names one. */
const IMAGE_REPOSITORY =
  /^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;

/** Where the images are published by default: the registry of the repository's GitHub owner. */
function defaultImages(repositoryUrl) {
  const { hostname, pathname } = new URL(repositoryUrl);
  const owner = pathname.split('/')[1]?.toLowerCase();
  return hostname === 'github.com' && owner && /^[a-z0-9-]+$/.test(owner)
    ? `ghcr.io/${owner}/openfolia`
    : 'ghcr.io/openfolia/openfolia';
}

/**
 * The release these docs belong to (#423): its version, its images and where its files are
 * downloaded. Unset DOCS_RELEASE: the development docs, which pin no release (`release: null`).
 */
function release(env, repositoryUrl) {
  const version = env.DOCS_RELEASE?.trim() || null;
  if (version === null && env.DOCS_RELEASE_URL?.trim())
    throw new Error(
      'DOCS_RELEASE_URL is set without DOCS_RELEASE, which it belongs to',
    );
  if (version !== null && !RELEASE_VERSION.test(version))
    throw new Error(
      `DOCS_RELEASE must be a release's tag such as v1.2.3, not "${version}"`,
    );
  const images = env.DOCS_IMAGES?.trim() || defaultImages(repositoryUrl);
  if (!IMAGE_REPOSITORY.test(images))
    throw new Error(
      `DOCS_IMAGES must be an image repository without a tag, such as ghcr.io/openfolia/openfolia, not "${images}"`,
    );
  // The release's images.lock (#739), what the release workflow attached: each image by its digest.
  const lock = env.DOCS_RELEASE_DIGESTS?.trim() || null;
  if (version === null && lock !== null)
    throw new Error(
      'DOCS_RELEASE_DIGESTS is set without DOCS_RELEASE, which it belongs to',
    );
  let digests = null;
  if (lock !== null) {
    try {
      digests = parseLock(lock, { images, tag: version });
    } catch (error) {
      throw new Error(`DOCS_RELEASE_DIGESTS: ${error.message}`, {
        cause: error,
      });
    }
  }
  return {
    release: version,
    images,
    digests,
    signatures: signatures(env, version, repositoryUrl),
    releaseUrl:
      version === null
        ? null
        : url(
            env,
            'DOCS_RELEASE_URL',
            `${repositoryUrl}/releases/download/${version}`,
          ),
  };
}

/** A signature's identity goes into the guide's shell commands: an address or an email, no quote. */
const SAFE_IDENTITY = /^[A-Za-z0-9._~:/%@+-]+$/;

/**
 * The release's signatures (#745), when its images are signed: the SHA-256 of each file the
 * release attaches for them (DOCS_RELEASE_SIGNATURES, the text of its signatures.sha256), and the
 * identity and issuer the signatures must carry. The identity is the release workflow's on the
 * GitHub repository of DOCS_REPOSITORY_URL at the release's tag, unless
 * DOCS_RELEASE_SIGNER_IDENTITY names another (a fork that signs elsewhere); the issuer GitHub
 * Actions', unless DOCS_RELEASE_SIGNER_ISSUER names another. Unset: the release is not signed.
 */
function signatures(env, version, repositoryUrl) {
  const sums = env.DOCS_RELEASE_SIGNATURES?.trim() || null;
  const identitySetting = env.DOCS_RELEASE_SIGNER_IDENTITY?.trim() || null;
  const issuerSetting = env.DOCS_RELEASE_SIGNER_ISSUER?.trim() || null;
  if (sums === null) {
    for (const [name, value] of [
      ['DOCS_RELEASE_SIGNER_IDENTITY', identitySetting],
      ['DOCS_RELEASE_SIGNER_ISSUER', issuerSetting],
    ])
      if (value !== null)
        throw new Error(
          `${name} is set without DOCS_RELEASE_SIGNATURES, which it belongs to`,
        );
    return null;
  }
  if (version === null)
    throw new Error(
      'DOCS_RELEASE_SIGNATURES is set without DOCS_RELEASE, which it belongs to',
    );
  let parsed;
  try {
    parsed = parseSignatureSums(sums);
  } catch (error) {
    throw new Error(`DOCS_RELEASE_SIGNATURES: ${error.message}`, {
      cause: error,
    });
  }
  const identity =
    identitySetting ?? githubSignerIdentity(repositoryUrl, version);
  if (identity === null)
    throw new Error(
      'DOCS_RELEASE_SIGNER_IDENTITY must be set when DOCS_REPOSITORY_URL is not a repository on github.com: the identity the signatures carry',
    );
  if (!SAFE_IDENTITY.test(identity))
    throw new Error(
      `DOCS_RELEASE_SIGNER_IDENTITY may hold only letters, digits and . _ ~ : / % @ + -, not "${identity}"`,
    );
  const issuer = url(env, 'DOCS_RELEASE_SIGNER_ISSUER', GITHUB_ACTIONS_ISSUER);
  requireHttps('DOCS_RELEASE_SIGNER_ISSUER', issuer);
  // cosign compares the issuer with the certificate's exactly: a value the check above rewrote
  // (a trailing /, an upper-case host) would never verify.
  if (issuerSetting !== null && issuer !== issuerSetting)
    throw new Error(
      `DOCS_RELEASE_SIGNER_ISSUER must be written as the certificate names it (${issuer}), not "${issuerSetting}"`,
    );
  return { ...parsed, identity, issuer };
}

/**
 * @returns {{ siteUrl: string, repositoryUrl: string, release: string | null, images: string, digests: Record<string, string> | null, signatures: { trustedRoot: string, bundles: Record<string, string>, identity: string, issuer: string } | null, releaseUrl: string | null }}
 */
export function docsSettings(env) {
  const repositoryUrl = url(env, 'DOCS_REPOSITORY_URL', DEFAULT_REPOSITORY_URL);
  const settings = {
    siteUrl: url(env, 'DOCS_SITE_URL', 'http://localhost:3000'),
    repositoryUrl,
    ...release(env, repositoryUrl),
  };
  if (settings.release !== null) {
    // A release's guide names its own address: never the default, which is this machine.
    if (!env.DOCS_SITE_URL?.trim())
      throw new Error(
        "DOCS_SITE_URL must be set for a release's docs (DOCS_RELEASE)",
      );
    requireHttps('DOCS_SITE_URL', settings.siteUrl);
    requireHttps('DOCS_RELEASE_URL', settings.releaseUrl);
    // A release's guide pins every image by its digest (#739), never by its tag alone.
    if (settings.digests === null)
      throw new Error(
        "DOCS_RELEASE_DIGESTS must be set for a release's docs (DOCS_RELEASE): the text of the release's images.lock",
      );
  }
  return settings;
}
