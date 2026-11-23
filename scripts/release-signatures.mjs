// A release's images signed (#745), optionally: with the repository variable SIGN_IMAGES=true, the
// images workflow (.github/workflows/images.yml, job `release-sign`) signs each image of a release
// tag by its digest with cosign, keyless (the workflow's GitHub OIDC identity), and attaches to the
// release, beside the files of #739:
//
// - `<image>.sigstore.json` for every image: the Sigstore bundle cosign writes (`cosign sign
//   --bundle`), a DSSE envelope over an in-toto statement whose subject is the image's digest, with
//   the certificate and the transparency log's inclusion proof, so it verifies without a server;
// - `trusted_root.json`: the Sigstore trust root the bundles verify against;
// - `signatures.sha256`: the SHA-256 of each of those files (`sha256sum`'s format).
//
// The docs of the release are built with DOCS_RELEASE_SIGNATURES set to that last file's text: the
// install guide then names each file's SHA-256 and verifies the signatures offline, with
// `cosign verify-blob-attestation --trusted-root`, never asking a Sigstore server
// (frontend/docs/scripts/lib/agent-guide.mjs). Nothing here runs in the signing job, which runs no
// code of the repository: these are the names and rules the docs build and the tests share.
import { IMAGES } from './images-plan.mjs';

/** The predicate type of cosign's image signature (cosign v3, `cosign sign`'s in-toto statement). */
export const SIGNATURE_PREDICATE = 'https://sigstore.dev/cosign/sign/v1';

/** The OIDC issuer of GitHub Actions' tokens: the issuer in a keyless signature made by a workflow. */
export const GITHUB_ACTIONS_ISSUER =
  'https://token.actions.githubusercontent.com';

/** The workflow that signs, as its certificate names it: its path in the repository. */
export const SIGNING_WORKFLOW = '.github/workflows/images.yml';

/** The trust root's file among the release's files. */
export const TRUSTED_ROOT = 'trusted_root.json';

/** The bundle of an image among the release's files. */
export const bundleName = (image) => `${image}.sigstore.json`;

/**
 * The identity a release's signatures carry when its own workflow signed them on GitHub: the
 * workflow's path at the release's tag, as Fulcio writes it into the certificate
 * (`https://github.com/<owner>/<repository>/.github/workflows/images.yml@refs/tags/vX.Y.Z`).
 * `null` for a repository that is not on github.com: its identity must be given.
 */
export function githubSignerIdentity(repositoryUrl, tag) {
  const { hostname, pathname } = new URL(repositoryUrl);
  const parts = pathname.split('/').filter(Boolean);
  if (hostname !== 'github.com' || parts.length !== 2) return null;
  return `https://github.com/${parts[0]}/${parts[1]}/${SIGNING_WORKFLOW}@refs/tags/${tag}`;
}

/**
 * `signatures.sha256`'s text read back: `{ trustedRoot, bundles: { image: sha256 } }`. It must name
 * the trust root and a bundle for every image of a release (IMAGES), each once, and nothing else.
 * Lines may be separated by any white space between entries (an environment variable): each entry
 * is `<64 hex>` then a file name, as `sha256sum` writes it (`  ` or ` *` between them).
 */
export function parseSignatureSums(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length % 2 !== 0)
    throw new Error('each entry is a SHA-256 and a file name');
  const sums = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const sum = tokens[i];
    const file = tokens[i + 1].replace(/^\*/, '');
    if (!/^[0-9a-f]{64}$/.test(sum))
      throw new Error(`"${sum}" is no SHA-256 (64 hex digits)`);
    const known =
      file === TRUSTED_ROOT ||
      IMAGES.some((image) => file === bundleName(image));
    if (!known)
      throw new Error(
        `"${file}" is no file of a release's signatures (${TRUSTED_ROOT}, <image>.sigstore.json)`,
      );
    if (sums[file]) throw new Error(`the file ${file} is named twice`);
    sums[file] = sum;
  }
  if (!sums[TRUSTED_ROOT]) throw new Error(`no SHA-256 for ${TRUSTED_ROOT}`);
  const bundles = {};
  for (const image of IMAGES) {
    if (!sums[bundleName(image)])
      throw new Error(`no SHA-256 for ${bundleName(image)}`);
    bundles[image] = sums[bundleName(image)];
  }
  return { trustedRoot: sums[TRUSTED_ROOT], bundles };
}

/**
 * The images whose signatures the install guide verifies: each image compose.yaml runs, once, in
 * its order, with the digest the release pins for it (hex, as `--digest` takes it): `<image> <hex>`
 * per line.
 */
export function signedImageLines({ digests, services }) {
  const images = [...new Set(services.map(({ image }) => image))];
  return images
    .map((image) => {
      const digest = digests[image];
      if (!digest) throw new Error(`no digest for ${image}`);
      return `${image} ${digest.replace(/^sha256:/, '')}`;
    })
    .join('\n');
}
