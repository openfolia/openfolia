// The one way scripts/setup-board.mjs and scripts/create-backlog.mjs talk to GitHub: through
// the `gh` CLI, as an injected caller `gh(args, input?) => stdout`, so the planners and the
// appliers run in a test against a fake. Request bodies go in on stdin (`--input -`), so a
// list or an object (a field's options) needs no flag encoding.
import { spawnSync } from 'node:child_process';

/** Runs `gh <args>` once with `input` on stdin; throws with gh's own message. */
function ghOnce(args, input) {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

/** How often a call that hit the secondary rate limit is tried again. */
export const RATE_LIMIT_RETRIES = 4;

/**
 * How long to wait before trying a failed call again, in ms, or null when it is no rate limit
 * to wait out. GitHub's secondary rate limit (too many writes or calls at once) answers HTTP
 * 403 or 429 and goes away: wait its `retry-after` seconds when the answer names them, else a
 * minute, doubling per retry (GitHub's advice). The primary limit (the hourly quota) is not
 * retried: it resets only at its hour, and gh's message says when.
 * @param {string} message the error gh printed
 * @param {number} retry 0 for the first retry
 */
export function rateLimitWait(message, retry) {
  const secondary = /secondary rate limit/i.test(message);
  const status = /HTTP (403|429)\b/.exec(message);
  const after = /retry-after:?\s*(\d+)/i.exec(message);
  if (!secondary && !(status && (after || status[1] === '429'))) return null;
  if (after) return Number(after[1]) * 1000;
  return 60_000 * 2 ** retry;
}

/** Blocks this thread for `ms` (the callers are synchronous, like spawnSync). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `gh` that waits out GitHub's secondary rate limit and tries again (rateLimitWait), up to
 * RATE_LIMIT_RETRIES times; every other failure, and the last one, is thrown as it came.
 * @param {(args: string[], input?: string) => string} gh
 * @param {{ sleep?: (ms: number) => void, log?: (line: string) => void }} [options]
 */
export function retryingGh(
  gh,
  { sleep = sleepSync, log = (line) => console.error(line) } = {},
) {
  return (args, input) => {
    for (let retry = 0; ; retry++) {
      try {
        return gh(args, input);
      } catch (error) {
        const wait =
          retry < RATE_LIMIT_RETRIES
            ? rateLimitWait(String(error?.message), retry)
            : null;
        if (wait === null) throw error;
        log(`GitHub's rate limit: trying again in ${Math.ceil(wait / 1000)} s`);
        sleep(wait);
      }
    }
  };
}

/** The real caller: `gh <args>` with `input` on stdin, waiting out the secondary rate limit. */
export const ghCli = retryingGh(ghOnce);

/** A GraphQL query or mutation; returns `data`, throws on any error GitHub reports. */
export function graphql(gh, query, variables = {}) {
  const out = JSON.parse(
    gh(
      ['api', 'graphql', '--input', '-'],
      JSON.stringify({ query, variables }),
    ),
  );
  if (out.errors?.length) {
    throw new Error(
      `GitHub GraphQL: ${out.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return out.data;
}

/** A REST call (`path` like `repos/o/r/milestones`); returns the parsed answer. */
export function rest(gh, method, path, body) {
  const args = ['api', '-X', method, path];
  if (body === undefined) return JSON.parse(gh(args) || 'null');
  return JSON.parse(
    gh([...args, '--input', '-'], JSON.stringify(body)) || 'null',
  );
}

/** Every node of a paginated connection: `pick(data)` returns `{ nodes, pageInfo }`. */
export function allNodes(gh, query, variables, pick) {
  const nodes = [];
  let after = null;
  for (;;) {
    const page = pick(graphql(gh, query, { ...variables, after }));
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    after = page.pageInfo.endCursor;
  }
}

/** The current repository (`gh repo view`): its node id, owner login and name. */
export function currentRepo(gh) {
  const repo = JSON.parse(gh(['repo', 'view', '--json', 'id,name,owner']));
  return { id: repo.id, name: repo.name, owner: repo.owner.login };
}
