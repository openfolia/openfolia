// The upload half of `pnpm pr:assets` (scripts/pr-assets-plan.mjs): a PR's images as one
// commit on the `pr-assets` branch, made through GitHub's API (blobs, a tree, a commit, then
// that one ref created or fast-forwarded, never forced). `gh` is the injected caller of
// scripts/gh-api.mjs, so a test runs it against a fake.
import { rest } from './gh-api.mjs';

/** The one branch it writes: an orphan holding nothing but PR images. */
export const ASSETS_BRANCH = 'pr-assets';
/** How often a ref update that lost a race with another upload is tried again. */
export const RACE_RETRIES = 3;

const isNotFound = (error) => /HTTP 404\b/.test(String(error?.message));
/**
 * Another upload moved (or made) the branch between reading its head and updating it: GitHub's
 * answers to a non-fast-forward update and to creating a ref that exists. Any other failure,
 * another 422 among them ("Reference cannot be updated" is also a protected branch or a token
 * without the right), is thrown as it came.
 */
const isRace = (error) =>
  /not a fast.forward|Reference already exists/i.test(String(error?.message));

/**
 * The branch's head commit and its tree, or null when the branch doesn't exist yet.
 * @returns {{ commit: string, tree: string } | null}
 */
function branchHead(gh, repo) {
  let ref;
  try {
    ref = rest(gh, 'GET', `repos/${repo}/git/ref/heads/${ASSETS_BRANCH}`);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (ref?.object?.type !== 'commit') {
    throw new Error(
      `${ASSETS_BRANCH} doesn't point at a commit; fix it by hand.`,
    );
  }
  const commit = rest(gh, 'GET', `repos/${repo}/git/commits/${ref.object.sha}`);
  return { commit: ref.object.sha, tree: commit.tree.sha };
}

/**
 * Uploads `images` for `pr` as one commit on ASSETS_BRANCH of `repo` and returns its sha. The
 * blobs go up once; the tree, commit and ref update are made again from the new head when
 * another upload moved the branch meanwhile (up to RACE_RETRIES times).
 * @param {(args: string[], input?: string) => string} gh
 * @param {string} repo owner/name
 * @param {number} pr
 * @param {{ path: string, bytes: Buffer }[]} images
 */
export function upload(gh, repo, pr, images) {
  const blobs = images.map(({ path, bytes }) => ({
    path,
    mode: '100644',
    type: 'blob',
    sha: rest(gh, 'POST', `repos/${repo}/git/blobs`, {
      content: bytes.toString('base64'),
      encoding: 'base64',
    }).sha,
  }));
  for (let attempt = 0; ; attempt++) {
    const head = branchHead(gh, repo);
    const tree = rest(gh, 'POST', `repos/${repo}/git/trees`, {
      ...(head ? { base_tree: head.tree } : {}),
      tree: blobs,
    }).sha;
    const commit = rest(gh, 'POST', `repos/${repo}/git/commits`, {
      message: `PR #${pr}: ${images.length} image${images.length === 1 ? '' : 's'}`,
      tree,
      parents: head ? [head.commit] : [],
    }).sha;
    try {
      if (head) {
        rest(gh, 'PATCH', `repos/${repo}/git/refs/heads/${ASSETS_BRANCH}`, {
          sha: commit,
          force: false,
        });
      } else {
        rest(gh, 'POST', `repos/${repo}/git/refs`, {
          ref: `refs/heads/${ASSETS_BRANCH}`,
          sha: commit,
        });
      }
      return commit;
    } catch (error) {
      if (!isRace(error) || attempt >= RACE_RETRIES) throw error;
    }
  }
}
