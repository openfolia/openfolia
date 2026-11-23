// What the PreToolUse guard (.claude/hooks/pre-tool-use.mjs) blocks, as a pure function so
// scripts/__tests__/claude-hooks.test.ts can pin every case. Each rule is a project rule a
// session could break by accident; the reason tells Claude what to do instead.
//
// Threat model: the guard prevents mistakes agents make in good faith, and catches the obvious
// tricks (a wrapper in front, a string handed to a shell, a glob for a file name). It is not a
// sandbox against a determined adversary: a script file that runs another, or a name built at
// run time, gets around it, and the real layers are auto mode's classifier (or the person's
// prompts) and the review loop. Within that, when it can't tell what a command does, its default
// is to read more (every word that could be a command is checked as one) or to block, never to
// allow. The pre-tool-use.mjs wrapper itself fails open on an error of its own, so a broken
// hook never stops a session.
//
// Known limits (deliberately not covered, so a review can skip them): a name built at run time
// (`node "scripts/$X.mjs"`, `pnpm "$S"`); code that assembles a command from fragments
// (`['sync', 'main'].join(':')`, a string decoded or concatenated before it runs); a script or
// file written now and run in a later tool call (each call is read on its own); anything that
// takes deliberate obfuscation to get past a rule (an alias, a function, a copy of a script
// under another name, a symlink to a blocked file). Fixing one of these needs a sandbox, not
// another pattern here.
//
// Long on purpose (one file, one decision function): the rules share the command parsing and
// the ctx, and the tests pin each by its case; splitting it is its own change.
import path from 'node:path';

import { simpleCommands } from './shell-words.mjs';
import { subagentFileReason, subagentReason } from './subagent-rules.mjs';

/**
 * @typedef {object} GuardContext
 * @property {string} cwd The directory the tool runs in.
 * @property {(dir: string) => boolean} isMainCheckout Whether `dir` is inside the main checkout
 *   (not a linked worktree) of a repository.
 * @property {(dir: string) => boolean} agentWorktreesActive Whether the repository at `dir`
 *   has agent worktrees under .claude/worktrees/ (parallel agents are working).
 * @property {() => boolean | null} [projectWorktreesActive] Whether the hook's own repository
 *   (resolved from the hook's project root, not from the command's directory) has agent
 *   worktrees; null or missing when that can't be told.
 * @property {(worktree: string) => string | null} [worktreeBranch] The branch checked out in a
 *   worktree (`git branch --show-current`), or null (detached, or unknown): the one branch a
 *   subagent working there may push.
 * @property {string} [home] For `~` in paths.
 */

/** Env files that never hold secrets: the templates that list the variable names. */
const SAFE_ENV_FILES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
]);

/** `.env`, `.env.local`, `.env.production.local`, …: the person's own secrets. */
export function isSecretEnvFile(file) {
  const base = path.basename(String(file));
  return /^\.env(\.[\w.-]+)?$/.test(base) && !SAFE_ENV_FILES.has(base);
}

const WORKTREE = /^(.*\/\.claude\/worktrees\/[^/]+)(\/|$)/;

/** The agent worktree (`…/.claude/worktrees/<name>`) a path is in, or null. */
export function worktreeOf(file) {
  return WORKTREE.exec(file)?.[1] ?? null;
}

const REASONS = {
  secretEnv:
    'Blocked: never read or print .env / .env.local (secrets). Use .env.example for the variable names.',
  printEnv:
    'Blocked: printing the whole environment can show secrets. Print the one non-secret variable you need (echo "$NAME").',
  slotEnv:
    "Blocked: a worktree's .env / .env.local is the slot's own, written by the slot tool (`pnpm slot create <name>`, scripts/agent-slot.mjs), never by hand. If a value in it is wrong, say so to the coordinator; a new variable goes into .env.example.",
  pkill:
    "Blocked: never `pkill -f` (it kills other sessions' servers, and the person's own). Stop your own server by its port: kill $(lsof -tiTCP:<port> -sTCP:LISTEN).",
  unknownDir:
    "Blocked: can't tell which checkout this runs in (a cd, pushd, env -C, git -C or --git-dir to a path built from a variable, `~`, `-` or a command substitution), and agents are working in .claude/worktrees/, so a git checkout/switch/merge/pull may hit the person's main checkout. Use a literal path.",
  mainCheckoutGit:
    "Blocked: agents are working in .claude/worktrees/, so the main checkout is the person's own: no git checkout/switch/merge/pull there. To bring it up to origin/main, run `pnpm sync:main` (a fast-forward only, refusing local changes, then `pnpm check:changed` on what it brought in; `--base <branch>` for another base). Otherwise work in your worktree (`pnpm slot create <name>`); to check a base branch, use a worktree of it.",
  heredocBody:
    'Blocked: a PR or issue text never goes through a here-document. Write it with the Write tool to <your worktree>/.factory-tmp/<name>.md (git-ignored), then pass `--body-file <that file>`.',
  pipedShell:
    "Blocked: piping into a shell: the guard can't read what it runs (only an echo/printf of literal text, or a here-document, is read). Write the commands out instead.",
  tooDeep:
    'Blocked: strings handed to a shell are nested too deep to read (bash -c inside bash -c, …, past 8 levels). Run the inner command directly.',
};

/** Words that read a file's content (or copy it somewhere else). */
const READERS = new Set(
  (
    'cat less more head tail grep egrep fgrep rg ag ack awk gawk sed cut sort uniq bat batcat ' +
    'strings xxd od hexdump diff cmp base64 jq yq nl tac paste column fold fmt pr view vi vim ' +
    'nvim nano emacs code open tr dotenv cp scp rsync source .'
  ).split(' '),
);
/** Interpreters: a path inside their script text counts too (`python3 -c "open('.env')"`). */
const INTERPRETERS = new Set(
  'python python3 node ruby perl php deno bun sh bash zsh'.split(' '),
);
/**
 * Words that run the rest of the command as a command, with the options that take a value (the
 * next word, unless given as `--opt=value`). Their other options, and numbers or durations
 * (`timeout 600`, `nice -n 5`, `taskset 0x3`, `chrt 10`), are skipped too (stripPrefix).
 */
const WRAPPERS = new Map(
  Object.entries({
    sudo: '-u -g -h -p -C -D -r -t -U -T --user --group --host --prompt --chdir --role --type --other-user --close-from',
    doas: '-u -C',
    command: '',
    exec: '-a',
    builtin: '',
    time: '-f -o --format --output',
    nohup: '',
    nice: '-n --adjustment',
    ionice: '-c -n -p -P -u --class --classdata --pid --pgid --uid',
    chrt: '-T -P -D --sched-runtime --sched-period --sched-deadline',
    taskset: '-c --cpu-list',
    stdbuf: '-i -o -e --input --output --error',
    caffeinate: '-t -w',
    timeout: '-s -k --signal --kill-after',
    setsid: '',
    unbuffer: '',
    env: '-u -C -S --unset --chdir --split-string',
  }).map(([name, options]) => [
    name,
    new Set(options.split(' ').filter(Boolean)),
  ]),
);

/** A wrapper's numeric argument: a number, a duration, a CPU mask or list (never a command). */
const NUMERIC_ARG =
  /^(\+|-)?(\d+(\.\d+)?[smhd]?|0x[0-9a-f]+|\d+(-\d+)?(,\d+(-\d+)?)*)$/i;

/**
 * Command names the rules below read themselves (whose later words are their own arguments),
 * and plain commands that never run a word they're given. A command named by anything else
 * (`xargs`, `parallel`, a wrapper with an option the table doesn't know, a script) has every
 * later word that names a GUARDED command read as a command from there too (fail closed).
 */
const PLAIN_COMMANDS = new Set(
  (
    'git gh node deno python python3 ruby perl php echo printf cat head tail less ' +
    'more grep egrep fgrep rg ag ack ls wc diff cmp sed awk jq yq sort uniq cut tr mkdir rmdir ' +
    'touch rm cp mv ln chmod chown test [ true false pwd which type file stat basename dirname ' +
    'realpath readlink date sleep kill lsof ps tee cd export unset set read printenv base64 ' +
    'shasum md5 sha256sum open code curl'
  ).split(' '),
);
/** Commands a rule here guards: a word naming one, past an unknown first word, is read too. */
const GUARDED = new Set(
  'git gh npm npx pnpm pnpx yarn bun bunx node nodejs deno tsx ts-node vite-node pkill'.split(
    ' ',
  ),
);

/**
 * The guard's decision for one tool call: `{ block: false }` or `{ block: true, reason }`.
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown>, agent_id?: string }} input
 * @param {GuardContext} ctx
 */
export function decide(input, ctx) {
  const tool = input?.tool_name ?? '';
  const args = input?.tool_input ?? {};
  // A subagent (the hook input names it): subagent-rules.mjs on top.
  const subagent = typeof input?.agent_id === 'string' && input.agent_id !== '';
  const reason =
    tool === 'Bash'
      ? bashReason(String(args.command ?? ''), ctx, subagent)
      : fileToolReason(tool, args, ctx, subagent);
  return reason ? { block: true, reason } : { block: false };
}

/** `file` resolved against `dir`, with `~/` expanded. */
export function resolvePath(dir, file, ctx) {
  const expanded =
    file.startsWith('~/') && ctx.home
      ? path.join(ctx.home, file.slice(2))
      : file;
  return path.resolve(dir, expanded);
}

/** The tools that write the file they name. */
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function fileToolReason(tool, args, ctx, subagent) {
  const rawPath = String(
    args.file_path ?? args.notebook_path ?? args.path ?? '',
  );
  const file = rawPath ? resolvePath(ctx.cwd, rawPath, ctx) : '';
  if (tool === 'Read' && file && isSecretEnvFile(file))
    return REASONS.secretEnv;
  if (tool === 'Grep') {
    if (file && isSecretEnvFile(file)) return REASONS.secretEnv;
    const glob = String(args.glob ?? '');
    if (
      glob &&
      /^(\*\*\/)?\.env(\.\*|\*)?$|^(\*\*\/)?\.env\.[\w.-]+$/.test(glob) &&
      isSecretGlob(glob)
    ) {
      return REASONS.secretEnv;
    }
  }
  if (WRITE_TOOLS.includes(tool) && file) {
    return (
      envWriteReason([file]) ??
      (subagent ? subagentFileReason(file, ctx) : null)
    );
  }
  return null;
}

/** A glob that names a secret env file (`.env`, `.env*`, `.env.local`), not only safe ones. */
function isSecretGlob(glob) {
  const base = glob.replace(/^\*\*\//, '');
  if (base === '.env' || base === '.env*' || base === '.env.*') return true;
  return isSecretEnvFile(base);
}

/**
 * Writing a secret env file in a worktree (absolute paths): the slot tool writes the slot's own,
 * never a hand. (A subagent writes none anywhere: subagent-rules.mjs.)
 */
function envWriteReason(files) {
  return files.some((file) => isSecretEnvFile(file) && worktreeOf(file))
    ? REASONS.slotEnv
    : null;
}

/**
 * Every simple command in `commands`, with the ones nested in strings handed to a shell.
 * @param {import('./shell-words.mjs').SimpleCommand[]} commands
 * @returns {import('./shell-words.mjs').SimpleCommand[]}
 */
function allCommands(commands) {
  return commands.flatMap((c) => [c, ...allCommands(c.inner ?? [])]);
}

/**
 * A subagent's push line holds nothing but directory changes and the push itself
 * (`cd <worktree> && git push …`), decided on the parsed commands: anything else on it (an
 * `export`, `declare`, `set -a`, `source`, `eval`, `read`, `printf -v`, a bare `NAME=value`, a
 * wrapper or a nested shell) could set GIT_CONFIG_*, GIT_SSH_COMMAND, HOME or
 * XDG_CONFIG_HOME and redirect the push. A line naming git and push in any other shape fails
 * closed.
 */
function subagentPushLineReason(commands) {
  const all = allCommands(commands).filter((c) => !c.subshell);
  const pushes = all.filter((c) => {
    const names = c.words.map((w) => path.basename(w));
    // `echo … git push …` only prints words.
    if (names[0] === 'echo') return false;
    const at = names.indexOf('git');
    return at !== -1 && names.slice(at + 1).includes('push');
  });
  if (pushes.length === 0) return null;
  const plain = all.every((c) => {
    if (c.inner?.length || c.tooDeep || c.pipedShell) return false;
    const first = c.words[0] ?? '';
    if (['cd', 'pushd', 'popd'].includes(first)) return true;
    return first === 'git' && gitSubcommand(c.words.slice(1)).sub === 'push';
  });
  return plain && pushes.length === 1
    ? null
    : 'Blocked (subagent): a push runs alone after a cd: cd <your worktree> && git push [-u] origin <its branch>, with nothing else on the line (no variables, wrappers, eval or other commands).';
}

function bashReason(command, ctx, subagent = false) {
  const commands = simpleCommands(command);
  // The other rules first, so their more specific messages win; then the push-line rule.
  return (
    commandsReason(commands, ctx.cwd, command, ctx, subagent) ??
    (subagent ? subagentPushLineReason(commands) : null)
  );
}

/**
 * Where a command runs: `dir`, and whether it is `known`. A cd/pushd/popd (or env -C, git -C)
 * to a path built at run time (`$X`, a substitution, a backtick, `~` the hook can't expand,
 * `cd -`) makes it unknown: `dir` stays the last known one for the rules that only need a
 * base for relative paths, and the rules that depend on the checkout (the main-checkout git
 * rule, a subagent's push) block. `stack`: pushd's directory stack.
 * @typedef {{ dir: string, known: boolean, stack: { dir: string, known: boolean }[] }} Where
 */

/**
 * `target` resolved against `base`, or null when it can't be told: a `$`, backtick or `-`, a
 * `~` the hook can't expand (`~user`, no ctx.home), or a relative path from an unknown base.
 */
function dirTarget(base, known, target, ctx) {
  if (/[$`]/.test(target) || target === '-') return null;
  if (
    target.startsWith('~') &&
    (!ctx.home || !(target === '~' || target.startsWith('~/')))
  ) {
    return null;
  }
  const expanded = target === '~' ? ctx.home : target;
  if (!known && !path.isAbsolute(expanded) && !expanded.startsWith('~/'))
    return null;
  return resolvePath(base, expanded, ctx);
}

/** `where` moved to `target` (null: unknown from here on). */
function moved(where, target, ctx) {
  const dir = dirTarget(where.dir, where.known, target, ctx);
  return dir === null
    ? { ...where, known: false }
    : { ...where, dir, known: true };
}

/** Where a cd, pushd or popd (its words past the name) leaves the commands after it. */
function changeDir(where, name, args, ctx) {
  const operands = args.filter(
    (word) => !/^-[A-Za-z]+$/.test(word) || word === '-',
  );
  if (name === 'cd') {
    if (operands.length === 0) {
      return ctx.home
        ? { ...where, dir: ctx.home, known: true }
        : { ...where, known: false };
    }
    return moved(where, operands[0], ctx);
  }
  if (name === 'pushd') {
    // No operand swaps the top two; `+N`/`-N` rotate: the hook doesn't follow either.
    if (operands.length === 0 || /^[+-]\d+$/.test(operands[0]))
      return { ...where, known: false };
    const next = moved(where, operands[0], ctx);
    return {
      ...next,
      stack: [...where.stack, { dir: where.dir, known: where.known }],
    };
  }
  // popd
  const top = where.stack.at(-1);
  if (operands.length > 0 || !top) return { ...where, known: false };
  return { dir: top.dir, known: top.known, stack: where.stack.slice(0, -1) };
}

/**
 * The directory a command runs in when `env -C <dir>` / `--chdir` or `sudo -D <dir>` /
 * `--chdir` stand among its prefix words (as `where`, possibly unknown).
 */
function prefixDir(where, prefix, ctx) {
  let at = where;
  let wrapper = '';
  for (let i = 0; i < prefix.length; i++) {
    const word = prefix[i];
    if (word === 'env' || word === 'sudo') wrapper = word;
    const short = wrapper === 'env' ? '-C' : wrapper === 'sudo' ? '-D' : null;
    if (!short) continue;
    let target = null;
    if (word === short || word === '--chdir') target = prefix[++i] ?? '';
    else if (word.startsWith('--chdir='))
      target = word.slice('--chdir='.length);
    else if (word.startsWith(short) && word.length > 2) target = word.slice(2);
    if (target !== null) at = moved(at, target, ctx);
  }
  return at;
}

/**
 * The first rule a list of simple commands breaks, read from `start` (a cd/pushd/popd carries
 * to the commands after it). A command that hands a shell a string (`bash -c '…'`, `eval …`:
 * shell-words.mjs, `inner`) is checked itself, then its inner commands are, from the directory
 * it runs in; a `cd` inside them stays inside, as in the shell, and so does one inside a `( … )`
 * subshell (its directory and pushd stack come back at the `)`; a `{ …; }` group keeps them).
 * @param {Where | string} start
 */
function commandsReason(commands, start, command, ctx, subagent) {
  let where =
    typeof start === 'string' ? { dir: start, known: true, stack: [] } : start;
  /** Where each open subshell started. */
  const outer = [];
  for (const {
    words: allWords,
    redirects,
    inner,
    tooDeep,
    pipedShell,
    subshell,
  } of commands) {
    if (subshell === 'open') outer.push(where);
    // A `)` without its `(` (a `case` pattern) changes nothing.
    if (subshell === 'close' && outer.length > 0) where = outer.pop();
    if (subshell) continue;
    if (tooDeep) return REASONS.tooDeep;
    if (pipedShell) return REASONS.pipedShell;
    const stripped = stripPrefix(allWords);
    const first = stripped.length ? path.basename(stripped[0]) : '';
    const here = prefixDir(
      where,
      allWords.slice(0, allWords.length - stripped.length),
      ctx,
    );
    if (first === 'cd' || first === 'pushd' || first === 'popd') {
      where = changeDir(here, first, stripped.slice(1), ctx);
      continue;
    }
    for (const words of candidates(stripped)) {
      // What came before them (`FOO=bar`, `env`, `sudo`, an unknown command): the subagent
      // rules read it too.
      const prefix = allWords.slice(0, allWords.length - words.length);
      const later = words !== stripped;
      const reason = wordsReason(
        words,
        prefix,
        redirects,
        here,
        command,
        ctx,
        subagent,
        later,
      );
      if (reason) return reason;
    }
    const reason = inner
      ? commandsReason(inner, here, command, ctx, subagent)
      : null;
    if (reason) return reason;
  }
  return null;
}

/**
 * The first rule one simple command's words (its prefix stripped) break, or null. `later`: the
 * words start at a later word of an unknown command (candidates), not where the command runs.
 */
function wordsReason(
  words,
  prefix,
  redirects,
  where,
  command,
  ctx,
  subagent,
  later = false,
) {
  const name = words.length ? path.basename(words[0]) : '';
  const rest = words.slice(1);
  const { dir } = where;
  const written = writtenPaths(name, rest, redirects).map((file) =>
    resolvePath(dir, file, ctx),
  );
  return (
    secretEnvReason(name, rest, redirects, dir, ctx) ??
    envWriteReason(written) ??
    pkillReason(name, rest) ??
    gitReason(name, rest, where, prefix, ctx) ??
    heredocBodyReason(name, rest, command) ??
    (subagent
      ? subagentReason(words, where, ctx, prefix, later, written)
      : null)
  );
}

/**
 * Drops `FOO=bar` assignments and wrappers (`sudo -u x`, `env -i -u X FOO=bar`, `timeout -s KILL
 * 600`, `nice -n 5`, `stdbuf -oL`, `caffeinate -i`, …) in front, with their options and
 * numeric arguments. A wrapper with nothing after it stays (`env` alone prints the environment).
 */
function stripPrefix(words) {
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const valueOptions = WRAPPERS.get(words[i] ?? '');
    if (!valueOptions) return words.slice(i);
    let j = i + 1;
    while (j < words.length) {
      const word = words[j];
      if (word === '--') {
        j++;
        break;
      }
      if (word.startsWith('-') && word.length > 1 && !NUMERIC_ARG.test(word)) {
        j += valueOptions.has(word) ? 2 : 1;
      } else if (
        NUMERIC_ARG.test(word) ||
        (words[i] === 'env' && /^[A-Za-z_]\w*=/.test(word))
      ) {
        j++;
      } else {
        break;
      }
    }
    if (j >= words.length) return words.slice(i);
    i = j;
  }
}

/**
 * Every word list the rules read for one simple command: the command past its prefix, and,
 * when its first word isn't one the rules know (PLAIN_COMMANDS), the words from each later
 * word that names a GUARDED command (`foo --x git push …`, `xargs git push …`).
 */
function candidates(words) {
  const name = words.length ? path.basename(words[0]) : '';
  if (!words.length || PLAIN_COMMANDS.has(name)) return [words];
  const runner = name === 'npx' || name === 'bunx' || name === 'pnpx';
  const managerExec =
    ['npm', 'pnpm', 'yarn', 'bun'].includes(name) &&
    ['exec', 'x', 'dlx'].includes(words[1]);
  if (GUARDED.has(name) && !runner && !managerExec) return [words];
  const out = [words];
  for (let k = 1; k < words.length; k++) {
    const word = words[k];
    if (!word.endsWith('/') && GUARDED.has(path.basename(word))) {
      out.push(stripPrefix(words.slice(k)));
    }
  }
  return out;
}

function secretEnvReason(name, rest, redirects, dir, ctx) {
  if (
    name === 'printenv' ||
    (name === 'env' && rest.every((word) => word.startsWith('-')))
  ) {
    return REASONS.printEnv;
  }
  const isSecret = (word) => isSecretEnvFile(resolvePath(dir, word, ctx));
  if (
    redirects.some(
      ({ op, target }) =>
        op.startsWith('<') && op !== '<<' && op !== '<<<' && isSecret(target),
    )
  ) {
    return REASONS.secretEnv;
  }
  if (READERS.has(name)) {
    // cp/rsync/scp: only a source counts here (writing one is envWriteReason's).
    const operands = ['cp', 'scp', 'rsync'].includes(name)
      ? rest.filter((word) => !word.startsWith('-')).slice(0, -1)
      : rest;
    if (operands.some((word) => pathWords(word).some(isSecret)))
      return REASONS.secretEnv;
  }
  if (
    INTERPRETERS.has(name) &&
    rest.some((word) => scriptPaths(word).some(isSecret))
  ) {
    return REASONS.secretEnv;
  }
  return null;
}

/** A word as paths: itself, or the value of `--opt=value`. */
function pathWords(word) {
  const eq = word.indexOf('=');
  return eq > 0 && word.startsWith('-') ? [word.slice(eq + 1)] : [word];
}

/** Path-like pieces inside a script text. */
function scriptPaths(word) {
  return word.match(/[^\s'"`=:(),;[\]{}]+/g) ?? [];
}

/** Paths a command writes, moves or deletes (as written: relative ones are the caller's). */
export function writtenPaths(name, rest, redirects) {
  const files = redirects
    .filter(({ op }) => op.startsWith('>') || op === '<>')
    .map(({ target }) => target);
  const operands = rest.filter((word) => !word.startsWith('-'));
  if (name === 'sed' || name === 'perl') {
    if (
      rest.some(
        (word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'),
      )
    ) {
      files.push(
        ...operands.slice(
          name === 'sed' && !rest.some((w) => w === '-e' || w === '-f') ? 1 : 0,
        ),
      );
    }
  } else if (['rm', 'unlink', 'truncate', 'tee', 'shred'].includes(name)) {
    files.push(...operands);
  } else if (['mv', 'cp', 'install', 'ln'].includes(name)) {
    // mv moves its sources too; cp/install/ln write only their destination.
    files.push(...(name === 'mv' ? operands : operands.slice(-1)));
  } else if (name === 'git' && ['mv', 'rm'].includes(gitSubcommand(rest).sub)) {
    files.push(
      ...gitSubcommand(rest).args.filter((word) => !word.startsWith('-')),
    );
  }
  return files;
}

function pkillReason(name, rest) {
  if (name !== 'pkill') return null;
  return rest.some((word) => word === '--full' || /^-[a-zA-Z0-9]*f/.test(word))
    ? REASONS.pkill
    : null;
}

/**
 * A git command's subcommand and its arguments, past global options: every `-C dir` in order
 * (`dirArgs`, each relative to the one before), and whether `--git-dir`/`--work-tree` aim it
 * at another repository (`otherRepo`).
 */
export function gitSubcommand(rest) {
  const dirArgs = [];
  let otherRepo = false;
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) {
    if (rest[i] === '-C') dirArgs.push(rest[++i] ?? '');
    else if (/^-C./.test(rest[i])) dirArgs.push(rest[i].slice(2));
    else if (
      ['-c', '--git-dir', '--work-tree', '--namespace'].includes(rest[i])
    ) {
      otherRepo ||= rest[i] !== '-c' && rest[i] !== '--namespace';
      i++;
    } else if (/^--(git-dir|work-tree)=/.test(rest[i])) otherRepo = true;
    i++;
  }
  return { sub: rest[i] ?? '', args: rest.slice(i + 1), dirArgs, otherRepo };
}

/**
 * The directory a git command acts on, or null when it can't be told: its `-C` paths from
 * `where`, unknown with an unknown `where` or a path built at run time, and with
 * `--git-dir`/`--work-tree` (or GIT_DIR / GIT_WORK_TREE among its prefix words).
 * @param {string[]} rest git's words past its name
 * @param {Where} where
 * @param {string[]} prefix
 */
export function gitDir(rest, where, prefix, ctx) {
  const { dirArgs, otherRepo } = gitSubcommand(rest);
  if (otherRepo || prefix.some((word) => /^GIT_(DIR|WORK_TREE)=/.test(word)))
    return null;
  let at = where;
  for (const arg of dirArgs) at = moved(at, arg, ctx);
  return at.known ? at.dir : null;
}

function gitReason(name, rest, where, prefix, ctx) {
  if (name !== 'git') return null;
  const { sub } = gitSubcommand(rest);
  if (!['checkout', 'switch', 'merge', 'pull'].includes(sub)) return null;
  const dir = gitDir(rest, where, prefix, ctx);
  if (dir === null) {
    // Unknown: as if in the main checkout, while agents are working.
    const active =
      ctx.agentWorktreesActive(where.dir) ||
      ctx.projectWorktreesActive?.() === true;
    return active ? REASONS.unknownDir : null;
  }
  if (worktreeOf(dir)) return null;
  if (ctx.isMainCheckout(dir) && ctx.agentWorktreesActive(dir))
    return REASONS.mainCheckoutGit;
  return null;
}

/** A here-document operator (`<<EOF`, `<<-'EOF'`, `<< "EOF"`, `<<\EOF`), not a here-string. */
const HEREDOC = /(^|[^<])<<-?[ \t]*(?:'[^'\n]+'|"[^"\n]+"|\\?[A-Za-z_][\w.-]*)/;

/** `gh [-R <repo>] pr|issue create|edit|comment|review …`: a command that posts a text. */
export function postsGhText(rest) {
  const plain = [];
  for (let i = 0; i < rest.length && plain.length < 2; i++) {
    if (rest[i] === '-R' || rest[i] === '--repo') i++;
    else if (!rest[i].startsWith('-')) plain.push(rest[i]);
  }
  return (
    ['pr', 'issue'].includes(plain[0]) &&
    /^(create|edit|comment|review)$/.test(plain[1] ?? '')
  );
}

/**
 * A PR or issue text posted in a command that holds a here-document (`--body "$(cat <<'EOF'
 * …)"`, `--body-file - <<'EOF'`, or a file a `cat <<'EOF'` writes in the same call): bodies go
 * through a file written with the Write tool. Read on the whole command, so a here-document
 * anywhere in it beside such a post counts (fail closed); a commit message may still use one.
 */
function heredocBodyReason(name, rest, command) {
  if (name !== 'gh' || !postsGhText(rest)) return null;
  return HEREDOC.test(command) ? REASONS.heredocBody : null;
}
