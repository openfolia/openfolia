// What `node scripts/agent-slot.mjs` decides, as plain functions a test can pin: slot names,
// the arguments, which branch and base a new slot starts from, which PORT it gets, the
// worktree's .env.local line and whether the machine looks loaded. The git, pnpm and lsof work
// is in agent-slot-io.mjs and agent-slot-create.mjs; the slot's brief is in agent-slot-brief.mjs.
import { slotFileIn } from './slot-file.mjs';

/** The default base of a new branch. */
export const DEFAULT_BASE = 'origin/main';
/** The API's own port in a person's checkout: a slot never takes it. */
export const OWN_PORT = 3100;
/** The first of the block of ports slots draw from, and how many it holds. */
export const PORT_START = OWN_PORT + 1;
export const PORT_COUNT = 100;

/** A slot name: lower-case letters, digits and dashes, starting with a letter or digit. */
export function slotName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
    throw new Error(
      `"${name ?? ''}" is not a slot name: use 1–31 lower-case letters, digits and dashes.`,
    );
  }
  return name;
}

/** The value of `--key value` or `--key=value` in `args`, or undefined. */
export function optionValue(args, key) {
  const equals = args.find((arg) => arg.startsWith(`${key}=`));
  if (equals) return equals.slice(key.length + 1);
  const at = args.indexOf(key);
  return at >= 0 && args[at + 1] !== undefined && !args[at + 1].startsWith('--')
    ? args[at + 1]
    : undefined;
}

/**
 * The ref a new branch starts from: `--base <ref>` (or `--base=<ref>`), else BASE_BRANCH, else
 * origin/main. `source` says which, so a message can name where a missing base came from.
 */
export function resolveBase(args, env = {}) {
  const arg = optionValue(args, '--base');
  if (arg) return { ref: arg, source: 'arg' };
  if (env.BASE_BRANCH) return { ref: env.BASE_BRANCH, source: 'env' };
  return { ref: DEFAULT_BASE, source: 'default' };
}

/**
 * Whether the slot starts from the branch on GitHub. No local branch: GitHub is asked live
 * (`lsRemote`, the result `{ status, stdout }` of `git ls-remote --heads origin <branch>`), so a
 * stale `refs/remotes/origin/<branch>` of a deleted branch never counts. A failed ls-remote
 * throws, since reading it as "no such branch" would start from the base and lose what was
 * pushed. `offline` (`--offline`, or no origin remote): GitHub isn't asked at all (`lsRemote`
 * is not read) and the slot is made from the local base.
 */
export function remoteBranch({ branch, local, lsRemote, offline = false }) {
  if (local || offline) return false;
  if (lsRemote?.status !== 0) {
    throw new Error(
      `git ls-remote --heads origin ${branch} failed (exit ${lsRemote?.status ?? 'unknown'}), so it is not known whether the branch is on GitHub. Check the network and the origin remote and run create again, or pass --offline to make the slot from the local base.`,
    );
  }
  return String(lsRemote.stdout ?? '')
    .split('\n')
    .some((line) => line.trim().split(/\s+/)[1] === `refs/heads/${branch}`);
}

/**
 * `git worktree add` arguments for a slot: the local branch when it exists; else a new local
 * branch from `origin/<branch>` when GitHub has it (`remote`, from remoteBranch: a slot
 * removed, or made on another machine, goes on from what was pushed, never from the base);
 * else a new branch from the base.
 */
export function worktreeAddArgs({ worktree, branch, base, local, remote }) {
  if (local) return [worktree, branch];
  if (remote) return ['--track', '-b', branch, worktree, `origin/${branch}`];
  return ['-b', branch, worktree, base];
}

/** The slot's paths and names, relative to the main checkout. `stackDir` holds its record. */
export function slotPaths(root, name) {
  return {
    worktree: `${root}/.claude/worktrees/${name}`,
    stackDir: `${root}/.claude/stacks/${name}`,
    slotFile: slotFileIn(`${root}/.claude/stacks/${name}`),
    branch: `agent/${name}`,
  };
}

/**
 * The API PORT for a new slot: the first of 3101–3200 that no other slot has and nothing
 * listens on. Never 3100, the person's own. `busy(port)`: whether something listens there now.
 */
export function pickPort(otherPorts, busy) {
  const taken = new Set([OWN_PORT, ...otherPorts]);
  for (let port = PORT_START; port < PORT_START + PORT_COUNT; port++) {
    if (!taken.has(port) && !busy(port)) return port;
  }
  throw new Error(
    `No free PORT in ${PORT_START}–${PORT_START + PORT_COUNT - 1} for a new slot: remove an unused slot first.`,
  );
}

/** `.env.local`'s text with `<key>=<value>` set: the line replaced, or added when there is none. */
export function withSetting(envText, key, value) {
  const line = `${key}=${value}`;
  const name = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = new RegExp(`^${name}=.*$`, 'm');
  if (existing.test(envText)) return envText.replace(existing, () => line);
  const base =
    envText === '' || envText.endsWith('\n') ? envText : `${envText}\n`;
  return `${base}${line}\n`;
}

/** `.env.local`'s text with `PORT=<port>` set: the line replaced, or added when there is none. */
export function withPort(envText, port) {
  return withSetting(envText, 'PORT', port);
}

/**
 * The Nx settings of a slot's `.env.local`, which Nx reads before it starts (#615). No daemon: in a
 * worktree under the main checkout the daemon's file watcher sees no change to a tracked file,
 * so it hashes every task as the files were when it started. A change then gets the outputs of
 * the old files from the cache (a stale `dist`), and since every worktree of the repository
 * shares Nx's cache (`~/.nx/<repository>/`), it can replay another slot's results stored under
 * that same old hash. Without the daemon each Nx command hashes the files as they are, about a
 * second more per command.
 */
export const SLOT_NX_SETTINGS = { NX_DAEMON: 'false' };

/**
 * Why the machine looks loaded now, as lines for `create` to print (a warning, never a
 * refusal): the 1-minute load average above the core count.
 */
export function machineLoadWarnings({ load1, cores }) {
  const warnings = [];
  if (Number.isFinite(load1) && cores > 0 && load1 > cores) {
    warnings.push(
      `The load average is ${load1.toFixed(1)} on ${cores} cores: another slot's tests will slow every run (timing-sensitive tests may fail). Consider waiting, or removing an idle slot.`,
    );
  }
  return warnings;
}
