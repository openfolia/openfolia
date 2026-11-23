// What a subagent (an Agent-tool agent, which the hook input names with `agent_id`) may not do,
// on top of every rule in guard-rules.mjs. Build agents (a coordinator's, a factory lead's) work
// in their own worktree (`.claude/worktrees/<name>`, branch `agent/<name>`); helper subagents
// (forks, review finders, Explore) may read anywhere.
// - push only from inside a worktree, only its own branch, by name: no force, no `src:dest`,
//   never a base branch (`main`, `sprint-*`);
// - never delete a branch (`git branch -d|-D`, `git push --delete`, a DELETE of a ref through
//   `gh api`): the coordinator cleans up after a merge;
// - never merge a PR: the coordinator (in a factory run, the lead) does, after the review loop
//   (`pnpm merge:pr` included);
// - never `pnpm sync:main`, from anywhere: it fast-forwards the person's main checkout, whatever
//   the directory it starts in. Both scripts are refused where a command would run them
//   (coordinator-scripts.mjs: `pnpm merge:pr`, `node scripts/sync-main.mjs`, `node -e
//   "import('./scripts/sync-main.mjs')"`, `tsx scripts/merge-pr*.mjs`), never for text, paths
//   or checks that only name them;
// - never write a `.env` / `.env.local` (any secrets file), anywhere;
// - outside a worktree (in the main checkout, or where the hook can't tell), only git commands
//   that read (READ_ONLY_GIT: status, log, diff, a branch or tag list, fetch, …), never one that
//   changes the working tree, the index or a ref (commit, add, stash, reset, checkout, …);
// - while agent worktrees exist, no file written in the main checkout (the Edit/Write tools, a
//   redirection, rm, mv, cp, tee, sed -i, …) and no package install there: it is the person's.
// A package manager command whose script name can't be read (an unknown option before it:
// package-scripts.mjs) is refused wherever a coordinator script could be.
// The worktree is the one the command's `cd` (pushd, env -C, git -C) lands in; when that can't be
// told (a path built at run time), a push is refused. Every rule here also reads
// the commands inside a string handed to a shell (`bash -c '…'`, `eval …`, nested:
// shell-words.mjs). A guard-rail against mistakes, not a boundary (guard-rules.mjs, "Threat
// model" and "Known limits"): a script file that runs another, or a name built at run time,
// gets around it; when the rules can't tell, they block. A refused build agent doesn't look for
// another way: it reports what it needed (in a factory run, the status line
// `factory: blocked <what it needed>`).
import path from 'node:path';

import { UNKNOWN_OPTION, coordinatorScript } from './coordinator-scripts.mjs';
import {
  gitDir,
  gitSubcommand,
  isSecretEnvFile,
  worktreeOf,
} from './guard-rules.mjs';
import { managerOptionTakesValue } from './package-scripts.mjs';

const BLOCKED =
  'If you need it, report what you needed (factory: blocked <what it needed>).';

const REASONS = {
  unknownDir:
    "Blocked (subagent): can't tell which checkout this runs in (a cd, pushd, env -C or git -C to a path built from a variable, `~`, `-` or a command substitution); use a literal path: cd <your worktree> && git push [-u] origin <its branch>.",
  config:
    "Blocked (subagent): never change git's configuration or remotes (`git config` writes, `git remote add/set-url/rename/remove`, `git config --file`): they can redirect a push. Read with `git config --get`/`--list`; anything else ends with `factory: blocked <what it needed>`.",
  push: "Blocked (subagent): push only your worktree's own branch, by name, from inside it: cd <your worktree> && git push [-u] origin <its branch>. Never another branch, a base branch (main, sprint-*), a `src:dest` refspec, --force (-f, +ref) or --delete.",
  deleteBranch: `Blocked (subagent): never delete a branch; the coordinator cleans up after the merge. ${BLOCKED}`,
  merge:
    'Blocked (subagent): only the coordinator (in a factory run, the lead) merges, after the review loop. Push your branch, open or update the PR, and report.',
  syncMain:
    "Blocked (subagent): sync:main updates the person's main checkout from any directory; only the coordinator (in a factory run, the lead) runs it, after a merge.",
  unknownOption:
    "Blocked (subagent): unknown option before the script name, so the guard can't tell which script runs; put options after the script or use --opt=value (`pnpm <script> --reporter=silent`).",
  mainCheckoutGit:
    'Blocked (subagent): this git command would change the main checkout. cd into your worktree first (cd <worktree> && …).',
  mainCheckoutWrite:
    "Blocked (subagent): agents are working in .claude/worktrees/, so the main checkout is the person's own: write files and install packages only in your worktree (cd <your worktree> && …, or its absolute path).",
  secretEnv: `Blocked (subagent): never write .env / .env.local (secrets). A new variable's name goes into .env.example; the person sets its value. ${BLOCKED}`,
};

/** The flags a subagent's push may carry: the upstream, and output only. */
const PUSH_FLAGS = new Set([
  '-u',
  '--set-upstream',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--porcelain',
  '--progress',
]);

/**
 * Branches a subagent never pushes, whatever its worktree has checked out (and merge:pr never
 * deletes: scripts/merge-pr-plan.mjs).
 */
export const BASE_BRANCH = /^(main|sprint-.*)$/;

/** GraphQL mutations that merge a PR, or set it to merge itself. */
const MERGE_MUTATION = /mergePullRequest|enablePullRequestAutoMerge/i;
/** GraphQL mutations that delete a ref (a branch). */
const DELETE_REF_MUTATION = /deleteRef\b/i;

/** Package manager subcommands that install or change packages (node_modules, the lockfile). */
const INSTALLS = new Set(
  'install i ci add remove rm uninstall un update up upgrade link unlink prune dedupe'.split(
    ' ',
  ),
);

/**
 * The reason a subagent's command is refused, or null.
 * @param {string[]} words The command's words, prefixes stripped.
 * @param {{ dir: string, known: boolean }} where The directory it runs in, and whether the hook
 *   could tell it (guard-rules.mjs, `Where`).
 * @param {import('./guard-rules.mjs').GuardContext} ctx
 * @param {string[]} [prefix] The words stripped before them (`GIT_PAGER=…`, `env`, `sudo`).
 * @param {boolean} [later] The words start at a later word of a command the guard doesn't know
 *   (`xargs git push …`), not where it runs.
 * @param {string[]} [written] The absolute paths the command writes, moves or deletes
 *   (guard-rules.mjs, writtenPaths).
 */
export function subagentReason(
  words,
  where,
  ctx,
  prefix = [],
  later = false,
  written = [],
) {
  const name = words.length ? path.basename(words[0]) : '';
  const rest = words.slice(1);
  const coordinator = coordinatorScript(words, prefix);
  if (coordinator === UNKNOWN_OPTION) return REASONS.unknownOption;
  if (coordinator === 'merge:pr') return REASONS.merge;
  if (coordinator === 'sync:main') return REASONS.syncMain;
  const own =
    name === 'git'
      ? (branchDeleteReason(rest) ??
        pushReason(rest, where, prefix, ctx) ??
        mainGitReason(rest, where, prefix, ctx) ??
        configWriteReason(rest))
      : name === 'gh'
        ? (ghMergeReason(rest) ?? ghDeleteRefReason(rest))
        : null;
  if (own) return own;
  for (const file of written) {
    const reason = subagentFileReason(file, ctx);
    if (reason) return reason;
  }
  if (!later && installsInMain(name, rest, where, ctx))
    return REASONS.mainCheckoutWrite;
  return null;
}

/**
 * Why a subagent may not write `file` (an absolute path; the Edit/Write tools, or a command's
 * writtenPaths), or null: a secrets file anywhere, or any file in the main checkout while agent
 * worktrees exist.
 * @param {string} file
 * @param {import('./guard-rules.mjs').GuardContext} ctx
 */
export function subagentFileReason(file, ctx) {
  if (isSecretEnvFile(file)) return REASONS.secretEnv;
  if (worktreeOf(file)) return null;
  const dir = path.dirname(file);
  return ctx.isMainCheckout(dir) && ctx.agentWorktreesActive(dir)
    ? REASONS.mainCheckoutWrite
    : null;
}

/** git subcommands that only read (or, `fetch`, update remote-tracking refs only). */
const READ_ONLY_GIT = new Set(
  (
    'status log show diff blame grep ls-files ls-tree ls-remote rev-parse rev-list describe ' +
    'merge-base cat-file for-each-ref shortlog fetch help version show-ref show-branch whatchanged'
  ).split(' '),
);
/** `git branch` / `git tag` options that only list (with `--list`/`-l`, patterns may follow). */
const LIST_VALUE_FLAGS = new Set([
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
]);
const LIST_FLAGS = new Set([
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '-l',
  '--list',
  '--show-current',
  '--no-color',
  '--color',
  '--column',
  '--no-column',
  '-i',
  '--ignore-case',
]);

/** `git branch` / `git tag` that only lists: listing flags, and patterns only after `--list`. */
function listsOnly(args) {
  const list = args.includes('-l') || args.includes('--list');
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (LIST_VALUE_FLAGS.has(word)) i++;
    else if (LIST_VALUE_FLAGS.has(word.split('=')[0]) || /^-n\d*$/.test(word))
      continue;
    else if (word.startsWith('-')) {
      if (!LIST_FLAGS.has(word)) return false;
    } else if (!list) return false;
  }
  return true;
}

/** Whether a git subcommand (and its arguments) only reads. */
function gitReads(sub, args) {
  if (sub === '' || READ_ONLY_GIT.has(sub)) return true;
  if (sub === 'branch' || sub === 'tag') return listsOnly(args);
  if (sub === 'remote')
    return (
      args.every((w) => w === '-v' || w === '--verbose') ||
      ['show', 'get-url'].includes(args[0])
    );
  if (sub === 'worktree') return args[0] === 'list';
  if (sub === 'stash') return args[0] === 'list' || args[0] === 'show';
  if (sub === 'config') {
    if (args[0] === 'get' || args[0] === 'list') return true;
    const reads = [
      '--get',
      '--get-all',
      '--get-regexp',
      '--get-urlmatch',
      '--list',
      '-l',
    ];
    const writes =
      /^(--(unset|unset-all|add|replace-all|edit|rename-section|remove-section)|-e)$/;
    return (
      args.some((w) => reads.includes(w)) && !args.some((w) => writes.test(w))
    );
  }
  return false;
}

/**
 * A git command outside a worktree (the main checkout, or a directory the hook can't tell)
 * that changes the working tree, the index or a ref: only READ_ONLY_GIT and listing forms pass.
 * A directory outside any main checkout (no repository) is no one's checkout.
 */
function mainGitReason(rest, where, prefix, ctx) {
  const { sub, args } = gitSubcommand(rest);
  if (gitReads(sub, args)) return null;
  const dir = gitDir(rest, where, prefix, ctx);
  if (dir !== null && (worktreeOf(dir) !== null || !ctx.isMainCheckout(dir)))
    return null;
  return REASONS.mainCheckoutGit;
}

/** `git branch -d|-D|--delete …` (alone or among other short flags: `-df`), anywhere. */
function branchDeleteReason(rest) {
  const { sub, args } = gitSubcommand(rest);
  if (sub !== 'branch') return null;
  const deletes = args.some(
    (word) =>
      word === '--delete' || (/^-[A-Za-z]+$/.test(word) && /[dD]/.test(word)),
  );
  return deletes ? REASONS.deleteBranch : null;
}

/** `git push`: exactly `[flags] origin <the worktree's branch>`, from inside that worktree. */
/** Read-only `git config` forms; every other use may write (a key and a value, --unset, --add, -e, …). */
const CONFIG_READS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '-l',
  '--list',
  '--show-origin',
  '--show-scope',
  '--name-only',
  '--null',
  '-z',
  '--type',
  '--bool',
  '--int',
  '--path',
  '--default',
  '--includes',
  '--no-includes',
  '--local',
  '--global',
  '--system',
  '--worktree',
]);

/**
 * A change of git's configuration or remotes. Such a change made in one call redirects a push
 * of the subagent's own branch in a later call (`remote.origin.pushurl`, a push refspec,
 * `url.<x>.insteadOf`, `core.sshCommand`), which the push rule alone can't see.
 */
function configWriteReason(rest) {
  const { sub, args } = gitSubcommand(rest);
  if (sub === 'remote') {
    const action = args.find((word) => !word.startsWith('-'));
    return action === undefined || action === 'show' || action === 'get-url'
      ? null
      : REASONS.config;
  }
  if (sub !== 'config') return null;
  const flags = args.filter((word) => word.startsWith('-'));
  // Only options that take no separate value, or carry it after `=`: any other option may
  // swallow the next word, so a word like `get` could be its value, not the subcommand.
  const readOnly = (flag) =>
    CONFIG_READS.has(flag) || /^--(type|default)=/.test(flag);
  if (
    !flags.every(readOnly) ||
    flags.some((f) => f === '--type' || f === '--default')
  )
    return REASONS.config;
  // Git's rule: the subcommand is the word right after `config`.
  if (args[0] === 'get' || args[0] === 'list') return null;
  // Older forms: a --get*/--list option, or a single key (`git config user.name`).
  const plain = args.filter((word) => !word.startsWith('-'));
  const reads = flags.some((flag) =>
    [
      '--get',
      '--get-all',
      '--get-regexp',
      '--get-urlmatch',
      '-l',
      '--list',
    ].includes(flag),
  );
  // A key always has a section (`user.name`); a single word without a dot is a subcommand
  // (`edit`, `set`, `unset`, …), not a read.
  return reads ||
    (flags.length === 0 && plain.length === 1 && plain[0].includes('.'))
    ? null
    : REASONS.config;
}

function pushReason(rest, where, prefix, ctx) {
  const { sub, args } = gitSubcommand(rest);
  if (sub !== 'push') return null;
  const dir = gitDir(rest, where, prefix, ctx);
  if (dir === null) return REASONS.unknownDir;
  const tree = worktreeOf(dir);
  const branch = tree ? ctx.worktreeBranch?.(tree) : null;
  const flags = args.filter((word) => word.startsWith('-'));
  const target = args.filter((word) => !word.startsWith('-'));
  // Git's own options before `push` may only move the directory (-C): `-c` and `--config-env`
  // can redirect the push (`remote.origin.pushurl`, a push refspec), and so can GIT_* variables
  // in front of the command (GIT_CONFIG_COUNT/KEY/VALUE, GIT_SSH_COMMAND, …).
  const globals = rest.slice(0, rest.length - args.length - 1);
  const onlyDirMoves = globals.every(
    (word, i) => word === '-C' || /^-C./.test(word) || globals[i - 1] === '-C',
  );
  const ok =
    onlyDirMoves &&
    !prefix.some((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) &&
    typeof branch === 'string' &&
    branch !== '' &&
    !BASE_BRANCH.test(branch) &&
    flags.every((flag) => PUSH_FLAGS.has(flag)) &&
    target.length === 2 &&
    target[0] === 'origin' &&
    target[1] === branch;
  return ok ? null : REASONS.push;
}

/**
 * A merge through gh: `gh [-R <repo>] pr [-R <repo>] merge`, a `gh api` call on a `/merge` path
 * that isn't surely a GET, or a merge mutation.
 */
function ghMergeReason(rest) {
  const plain = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-R' || rest[i] === '--repo') i++;
    else if (!rest[i].startsWith('-')) plain.push(rest[i]);
  }
  if (plain[0] === 'pr' && plain[1] === 'merge') return REASONS.merge;
  if (
    plain[0] === 'api' &&
    rest.some((word) => word.includes('/merge')) &&
    ghApiWrites(rest)
  ) {
    return REASONS.merge;
  }
  if (rest.some((word) => MERGE_MUTATION.test(word))) return REASONS.merge;
  return null;
}

/** A branch deleted through gh: a writing `gh api` call on a `git/refs` path, or deleteRef. */
function ghDeleteRefReason(rest) {
  if (rest.some((word) => DELETE_REF_MUTATION.test(word)))
    return REASONS.deleteBranch;
  const api = rest.find((word) => !word.startsWith('-')) === 'api';
  return api &&
    rest.some((word) => /\/git\/refs\b/.test(word)) &&
    ghApiWrites(rest)
    ? REASONS.deleteBranch
    : null;
}

/**
 * Whether a `gh api` call may write, failing closed: only no method and no body flag, or every
 * method given an explicit GET (`-XGET`, `-X GET`, `--method=GET`, `--method GET`), reads.
 */
function ghApiWrites(rest) {
  const methods = [];
  let body = false;
  rest.forEach((word, i) => {
    if (word === '-X' || word === '--method') methods.push(rest[i + 1] ?? '');
    else if (word.startsWith('--method='))
      methods.push(word.slice('--method='.length));
    else if (/^-[A-Za-z]*X/.test(word))
      methods.push(word.slice(word.indexOf('X') + 1));
    else if (
      /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(word) ||
      /^-[fF]./.test(word)
    ) {
      body = true;
    }
  });
  if (methods.length > 0)
    return !methods.every((method) => /^get$/i.test(method));
  return body;
}

/**
 * A package install (`pnpm install|add|…`, `npm ci`, …) in the main checkout while agent
 * worktrees exist; where the directory can't be told, it counts as the main checkout.
 */
function installsInMain(name, rest, where, ctx) {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return false;
  let sub;
  let dir = where.known ? where.dir : null;
  for (let i = 0; i < rest.length && sub === undefined; i++) {
    const word = rest[i];
    if (!word.startsWith('-')) sub = word;
    else if (managerOptionTakesValue(name, word)) {
      // A folder option (`-C`, `--dir`, `--prefix`, `--cwd`) moves it; a path built at run
      // time can't be told.
      const value = rest[++i] ?? '';
      if (FOLDER_OPTIONS.has(word)) {
        dir =
          /[$`~]/.test(value) || dir === null ? null : path.resolve(dir, value);
      }
    }
  }
  // A bare `yarn` installs too.
  if (!(sub === undefined ? name === 'yarn' : INSTALLS.has(sub))) return false;
  if (dir === null) return true;
  if (worktreeOf(dir)) return false;
  return ctx.isMainCheckout(dir) && ctx.agentWorktreesActive(dir);
}

/** The package managers' options that name the folder they work in. */
const FOLDER_OPTIONS = new Set(['-C', '--dir', '--prefix', '--cwd']);
