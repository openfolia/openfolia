// Whether a subagent's command runs one of the coordinator's scripts (`pnpm merge:pr`, `pnpm
// sync:main`, or their files scripts/merge-pr*.mjs, scripts/sync-main*.mjs: COORDINATOR, a
// ScriptSet); subagent-rules.mjs refuses it. A name counts only where it would RUN, so text, paths and checks that merely name
// the scripts (`git grep merge:pr`, `node --check …`, a commit body, `find -name 'merge-pr*'`,
// `rm -rf test-results/*`) pass:
// - the command's own name (a script run by its shebang);
// - the script operand of a JS runner (node, bun, deno run, tsx, ts-node, vite-node; also behind
//   npx, bunx, pnpx, npm exec, pnpm dlx/exec, yarn dlx/exec, bun x), past the runner's options and
//   their values (`node --check` is no run);
// - a module a runner loads (the value of --import/--require/-r/--loader/--preload, NODE_OPTIONS
//   and `--node-options`: any name inside it counts); JS code it evaluates (-e/-p, `deno eval`, a
//   script from stdin or a here-document) only when the code starts a process (child_process,
//   exec(, spawn(, fork(, Bun.spawn, Deno.Command: then any name in it counts) or imports or
//   requires one of the files (`fs.readFileSync('scripts/merge-pr.mjs')` and
//   `require('./package.json').scripts['merge:pr']` run nothing);
// - the script a package manager runs (package-scripts.mjs: `npm|pnpm|yarn|bun run <name>`,
//   `node --run <name>`, …; an unknown option before the name is UNKNOWN_OPTION), and the names
//   npm-run-all / run-s / run-p run (a glob too);
// - a command line inside a value that is one: a git `-c` value (`core.pager=…`, `alias.x=!…`),
//   an env prefix of a variable that holds a command (`GIT_PAGER=…`, `LESSOPEN=|…`);
// - `find … -exec|-execdir|-ok <command> {} ;|+`: the command, with each -name/-path/-regex value
//   and literal path operand of the find standing in for `{}`;
// - a checker that loads a file as code: eslint/prettier/vitest with an option outside their
//   plain ones, of which only the option's value (a config, plugin, formatter, rules folder,
//   setup file) is searched, never the files it checks; `rg --pre`, `less +!…`, `sed` with its
//   `e` command or flag, `npx -c`; and an interpreter's code that starts a process
//   (`python3 -c "…subprocess…sync:main…"`).
// A glob counts only in a run position, and only when it could match a name of the set (as the
// command's own name, only with a literal piece of one: `merge`, `sync`, `main`). Strings handed
// to a shell (`sh -c`, `eval`, `echo … | sh`, …) are read as commands of their own
// (shell-words.mjs). A guard-rail against mistakes (guard-rules.mjs, "Threat model" and "Known
// limits"): a script that runs another, or a name built at run time, gets around it.
//
// Over ~250 lines on purpose: one decision (where a name runs), most of it the runners' option
// tables it needs; pinned case by case in scripts/__tests__/claude-hooks.test.ts.
import path from 'node:path';

import { gitSubcommand } from './guard-rules.mjs';
import { packageScript } from './package-scripts.mjs';
import { simpleCommands } from './shell-words.mjs';

/** What a command whose script name can't be read runs (package-scripts.mjs, `unknown`). */
export const UNKNOWN_OPTION = 'unknown-option';

/**
 * A set of scripts, and what running one of them counts as (the coordinator's: `merge:pr` or
 * `sync:main`).
 * @typedef {object} ScriptSet
 * @property {(file: string) => string | null} file The result for a file's base name.
 * @property {string[]} names File and npm names a glob in a run position is matched with.
 * @property {RegExp} fragment A literal piece of a name: a glob as the command's own name must
 *   hold one.
 * @property {(script: string) => string | null} npm The result for a package.json script name.
 * @property {(text: string) => string | null} text Any name of the set inside code text.
 */

/** The coordinator's scripts by file name: merge-pr.mjs, its merge-pr-*.mjs parts, sync-main. */
const COORDINATOR_FILE = /^(merge-pr|sync-main)(-[\w.-]*)?\.mjs$/;
const kind = (name) => (/sync/.test(name) ? 'sync:main' : 'merge:pr');
/** The coordinator's names anywhere inside code text. */
const COORDINATOR_TEXT = [
  [/sync-main(-[\w.-]*)?\.mjs|sync:main/, 'sync:main'],
  [/merge-pr(-[\w.-]*)?\.mjs|merge:pr/, 'merge:pr'],
];

/** The coordinator's scripts. */
export const COORDINATOR = {
  file: (file) => (COORDINATOR_FILE.test(file) ? kind(file) : null),
  names: [
    'merge-pr.mjs',
    'merge-pr-flow.mjs',
    'merge-pr-hold.mjs',
    'merge-pr-next.mjs',
    'merge-pr-plan.mjs',
    'merge-pr-report.mjs',
    'sync-main.mjs',
    'sync-main-plan.mjs',
    'merge:pr',
    'sync:main',
  ],
  fragment: /merge|sync|main/i,
  npm: (script) => (['merge:pr', 'sync:main'].includes(script) ? script : null),
  text: (text) =>
    COORDINATOR_TEXT.find(([pattern]) => pattern.test(text))?.[1] ?? null,
};

/** A shell glob (`*`, `?`, `[…]`, `{a,b}`) as an anchored regular expression. */
function globRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) out += '\\[';
      else {
        out += `[${glob
          .slice(i + 1, close)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else if (ch === '{') out += '(';
    else if (ch === '}') out += ')';
    else if (ch === ',') out += '|';
    else out += ch.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * The script of `set` a word in a run position names: one of its files, or a glob that may
 * expand to one. `fragment`: the glob must also hold a literal piece of a name (`merge`, `sync`,
 * `main`), for a word that only runs when it is the command's own name (`* bullet` is no run).
 * @param {string} word
 * @param {ScriptSet} set
 */
function runTarget(word, set, fragment = false) {
  const file = path.basename(word);
  const named = set.file(file);
  if (named) return named;
  if (!/[*?[{]/.test(file)) return null;
  if (fragment && !set.fragment.test(file.replace(/\[[^\]]*\]|[*?{},]/g, '')))
    return null;
  let pattern;
  try {
    pattern = globRegex(file);
  } catch {
    return set.names[0]
      ? (set.file(set.names[0]) ?? set.npm(set.names[0]))
      : null; // fail closed
  }
  const name = set.names.find((candidate) => pattern.test(candidate));
  return name ? (set.file(name) ?? set.npm(name)) : null;
}

const first = (items, find) => {
  for (const item of items) {
    const found = find(item);
    if (found) return found;
  }
  return null;
};

/** A call in JS code that starts a process. */
const JS_STARTS_PROCESS =
  /\bchild_process\b|\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\bBun\.spawn|\bDeno\.(?:Command|run)\b|\bexeca\b|\$`/;
/** The module specifiers JS code imports or requires. */
const JS_MODULES =
  /\b(?:import|require)\s*\(\s*(['"`])([^'"`]*)\1|\bfrom\s*(['"])([^'"]*)\3|\bimport\s*(['"])([^'"]*)\5/g;

/**
 * The script of `set` that JS code runs: any name in it when it starts a process, else a file of
 * the set it imports or requires (reading or writing one, or naming an npm script, runs
 * nothing).
 */
function jsCodeTarget(code, set) {
  if (JS_STARTS_PROCESS.test(code)) return set.text(code);
  for (const match of code.matchAll(JS_MODULES)) {
    const found = runTarget(match[2] ?? match[4] ?? match[6] ?? '', set);
    if (found) return found;
  }
  return null;
}

/** JS runners whose first operand is the script they run. */
const JS_RUNNERS = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'tsx',
  'ts-node',
  'vite-node',
]);
/** Runner options whose value is code they evaluate. */
const EVAL_OPTIONS = new Set(['-e', '--eval', '-p', '--print']);
/** Runner options whose value is a module they load. */
const LOAD_OPTIONS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--preload',
]);
/** Runner options whose value is plain (a file of settings, a name, a folder). */
const PLAIN_VALUE_OPTIONS = new Set([
  '--env-file',
  '--input-type',
  '--conditions',
  '-C',
  '--title',
  '--inspect-port',
  '--stack-size',
  '--cwd',
  '--tsconfig',
  '--project',
  '-P',
  '--compiler',
  '--dir',
  '--config',
]);
/** Runner flags known to take no value (the rest of `--no-…`, `--experimental-…` too). */
const RUNNER_FLAGS = new Set([
  '--test',
  '--watch',
  '--hot',
  '--bun',
  '--inspect',
  '--inspect-brk',
  '--enable-source-maps',
  '--expose-gc',
  '--preserve-symlinks',
  '--pending-deprecation',
  '--throw-deprecation',
  '--abort-on-uncaught-exception',
  '-i',
  '--interactive',
  '-A',
  '--allow-all',
  '-T',
  '--transpile-only',
  '--swc',
  '--esm',
]);
const FLAG_FAMILY =
  /^--(no-|experimental-|trace-|allow-|unstable|max-|harmony|enable-|disable-)/;

/**
 * The coordinator script a JS runner's words run (`node [options] <script>`, `-e <code>`, …), or
 * null. An operand after an option the hook doesn't know may be that option's value, so it reads
 * on to the next one as well (fail closed).
 */
function jsRunnerTarget(name, rest, set) {
  let i = 0;
  if (name === 'deno') {
    if (rest[0] === 'eval') return jsCodeTarget(rest.slice(1).join(' '), set);
    if (rest[0] === 'run') i = 1;
  }
  if (
    (name === 'tsx' && rest[0] === 'watch') ||
    (name === 'bun' && rest[0] === 'run')
  )
    i = 1;
  let check = false;
  let evaluates = false;
  let unknownBefore = false;
  for (; i < rest.length; i++) {
    const word = rest[i];
    if (word === '--')
      return check || evaluates ? null : runTarget(rest[i + 1] ?? '', set);
    if (word.startsWith('-') && word.length > 1) {
      const eq = word.indexOf('=');
      const option = eq > 0 ? word.slice(0, eq) : word;
      unknownBefore = false;
      if (EVAL_OPTIONS.has(option)) {
        const found = jsCodeTarget(
          eq > 0 ? word.slice(eq + 1) : (rest[++i] ?? ''),
          set,
        );
        if (found) return found;
        evaluates = true;
      } else if (LOAD_OPTIONS.has(option)) {
        const found = set.text(eq > 0 ? word.slice(eq + 1) : (rest[++i] ?? ''));
        if (found) return found;
      } else if (
        /^node(js)?$/.test(name) &&
        ['-c', '--check'].includes(option)
      ) {
        check = true;
      } else if (PLAIN_VALUE_OPTIONS.has(option)) {
        if (eq < 0) i++;
      } else if (
        eq < 0 &&
        !RUNNER_FLAGS.has(option) &&
        !FLAG_FAMILY.test(option)
      ) {
        unknownBefore = true;
      }
      continue;
    }
    // Code read from stdin: the here-document's body follows as one word (heredocs.mjs).
    if (word === '-')
      return first(rest.slice(i + 1), (code) => jsCodeTarget(code, set));
    if (evaluates) return null; // the script's own arguments
    // A word that isn't a path is a here-document's body (`node <<'EOF'`): code.
    const found = /[\s()'";]/.test(word)
      ? jsCodeTarget(word, set)
      : check
        ? null
        : runTarget(word, set);
    if (found) return found;
    if (!unknownBefore) return null;
    unknownBefore = false;
  }
  return null;
}

/** Package runners (npx, bunx, pnpx; npm exec|x, pnpm dlx|exec, yarn dlx|exec, bun x). */
function runnerPackageStart(name, rest) {
  if (['npx', 'bunx', 'pnpx'].includes(name)) return 0;
  if (
    ['npm', 'pnpm', 'yarn', 'bun'].includes(name) &&
    ['exec', 'x', 'dlx'].includes(rest[0])
  ) {
    return 1;
  }
  return null;
}

/** What a package runner runs: the package's own words, read as a command. */
function packageTarget(name, rest, depth, set) {
  let i = runnerPackageStart(name, rest);
  if (i === null) return null;
  for (; i < rest.length && rest[i].startsWith('-'); i++) {
    const word = rest[i];
    const eq = word.indexOf('=');
    const option = eq > 0 ? word.slice(0, eq) : word;
    const value = () => (eq > 0 ? word.slice(eq + 1) : (rest[++i] ?? ''));
    if (option === '--node-options') {
      const found = set.text(value());
      if (found) return found;
    } else if (['-c', '--call', '--shell-mode'].includes(option)) {
      // The string runs in a shell (read as commands: shell-words.mjs); what the runner does
      // with the words after it isn't clear, so a coordinator name among them counts.
      return first(rest.slice(i + 1), set.text);
    } else if (['-p', '--package'].includes(option)) {
      value();
    } else if (word === '--') {
      i++;
      break;
    }
  }
  if (i >= rest.length) return null;
  const pkg = rest[i].replace(/(.)@[^/]*$/, '$1');
  return wordsTarget([pkg, ...rest.slice(i + 1)], [], depth + 1, set);
}

/**
 * Checkers that only read the files they're given, each with the options it may take without
 * loading code (an allowlist: a config, plugin, parser, formatter, reporter, rules folder or
 * setup file is code it would load). `values`: options whose next word is theirs.
 */
const CHECKERS = {
  prettier: {
    flags: [
      '--check',
      '-c',
      '--list-different',
      '-l',
      '--write',
      '-w',
      '--no-cache',
      '--cache',
    ],
    values: ['--log-level', '--loglevel', '--ignore-path', '--cache-location'],
  },
  eslint: {
    flags: [
      '--fix',
      '--quiet',
      '--cache',
      '--no-cache',
      '--no-warn-ignored',
      '--color',
    ],
    values: ['--max-warnings', '--cache-location'],
  },
  vitest: {
    flags: [
      '--run',
      '--passWithNoTests',
      '--no-coverage',
      '--coverage',
      '--silent',
      '--changed',
    ],
    values: ['-t', '--testNamePattern', '--bail', '--project'],
  },
};

/** Checker options whose value is code it loads (a config, plugin, formatter, setup file). */
const CHECKER_CODE_OPTIONS = new Set([
  '-c',
  '--config',
  '--plugin',
  '--rulesdir',
  '--resolve-plugins-relative-to',
  '--setupFiles',
  '--globalSetup',
  '--require',
  '--import',
  '--loader',
  '-f',
  '--format',
  '--parser',
  '--plugin-search-dir',
  '--reporter',
  '--environment',
]);

/**
 * The script of `set` a checker's options load: only the value of an option outside the
 * checker's plain ones counts (the next word, or its `=value`: for an option it doesn't know,
 * the next word may be its value), never a file it only checks.
 */
function checkerTarget(checker, rest, set) {
  for (let j = 0; j < rest.length; j++) {
    const word = rest[j];
    if (word === '--') return null;
    if (!word.startsWith('-')) continue;
    const eq = word.indexOf('=');
    const option = eq > 0 ? word.slice(0, eq) : word;
    if (checker.values.includes(option)) {
      if (eq < 0) j++;
      continue;
    }
    if (checker.flags.includes(word)) continue;
    const value = eq > 0 ? word.slice(eq + 1) : (rest[j + 1] ?? '');
    const found = runTarget(value, set) ?? set.text(value);
    if (found) return found;
    if (eq < 0 && CHECKER_CODE_OPTIONS.has(option)) j++;
  }
  return null;
}

/** Readers with an option that runs a program on the files they read. */
const RUNS_PROGRAM = {
  rg: /^--pre(=|$)/,
  less: /^\+/,
  more: /^\+/,
};
/** A sed script with its `e` command (`1e cmd`) or the `e` flag of `s///e`: runs a shell. */
const SED_EXEC =
  /(?:^|[\s;{}\d$/])e(?:\s|;|$)|^s(.).*\1.*\1[a-zA-Z0-9]*e[a-zA-Z0-9]*\s*(?:;|$)/m;
/** Interpreters whose code may start a process naming a coordinator script. */
const INTERPRETERS = new Set(['python', 'python3', 'ruby', 'perl', 'php']);
/** A call that starts a process (`subprocess.run`, `os.system(`, `exec(`), not a word in text. */
const STARTS_PROCESS =
  /\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*)\b|\b(?:system|popen|spawn\w*|exec[a-z]*)\s*\(|\bcheck_(?:call|output)\b/;

/** A checker, reader or interpreter that loads or runs code naming a script of `set`. */
function codeLoaderTarget(name, rest, set) {
  const all = () => first(rest, set.text);
  if (Object.hasOwn(CHECKERS, name))
    return checkerTarget(CHECKERS[name], rest, set);
  if (Object.hasOwn(RUNS_PROGRAM, name)) {
    return rest.some((word) => RUNS_PROGRAM[name].test(word)) ? all() : null;
  }
  if (name === 'sed')
    return rest.some((word) => SED_EXEC.test(word)) ? all() : null;
  if (INTERPRETERS.has(name))
    return rest.some((word) => STARTS_PROCESS.test(word)) ? all() : null;
  return null;
}

/** Env variables whose value is a command line some program runs (a pager, an editor, a diff). */
const COMMAND_VARS =
  /^(GIT_\w+|\w*(PAGER|EDITOR|VISUAL|BROWSER|SHELL|ASKPASS|DIFF|LESSOPEN|LESSCLOSE|COMMAND|CMD|EXEC|PROGRAM|HOOK)\w*)$/;

/** The coordinator script a command line (a value holding one) runs, or null. */
function lineTarget(line, depth, set) {
  if (depth > 4) return null;
  const text = line.replace(/^\s*(\|\||[|!])/, '');
  return first(simpleCommands(text), ({ words }) =>
    wordsTarget(words, [], depth + 1, set),
  );
}

/** What the env assignments in front of a command run (`GIT_PAGER=…`, `NODE_OPTIONS=…`). */
function prefixTarget(prefix, depth, set) {
  return first(prefix, (word) => {
    const match = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(word);
    if (!match) return null;
    if (match[1] === 'NODE_OPTIONS') return set.text(match[2]);
    return COMMAND_VARS.test(match[1])
      ? lineTarget(match[2], depth, set)
      : null;
  });
}

/**
 * git's global `-c` values that hold a command line (`core.pager=…`, `alias.x=!…`), and the env
 * variable in front that a `--config-env=<key>=<VAR>` reads one from.
 */
function gitConfigTarget(rest, prefix, depth, set) {
  const values = [];
  const env = (name) =>
    prefix
      .find((word) => word.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? '';
  for (let i = 0; i < rest.length && rest[i].startsWith('-'); i++) {
    if (rest[i] === '-c') values.push(rest[++i] ?? '');
    else if (rest[i] === '-C') i++;
    else if (/^-c./.test(rest[i])) values.push(rest[i].slice(2));
    else if (rest[i] === '--config-env')
      values.push(`=${env((rest[++i] ?? '').split('=')[1])}`);
    else if (rest[i].startsWith('--config-env='))
      values.push(`=${env(rest[i].split('=')[2])}`);
  }
  return first(values, (value) =>
    lineTarget(value.slice(value.indexOf('=') + 1), depth, set),
  );
}

/** Runners whose operands are package.json script names (globs too). */
const NPM_RUN_ALL = new Set(['npm-run-all', 'run-s', 'run-p']);

/** The scripts npm-run-all / run-s / run-p run: each operand a script name or a glob of them. */
function runAllTarget(rest, set) {
  return first(
    rest.filter((word) => !word.startsWith('-')),
    (word) =>
      set.npm(word) ?? (/[*?[{]/.test(word) ? runTarget(word, set) : null),
  );
}

/** find's tests whose value names the files `{}` stands for. */
const FIND_NAMES = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-regex',
  '-iregex',
  '-lname',
  '-ilname',
]);

/**
 * What `find … -exec|-execdir|-ok|-okdir <command> {} ;|+` runs: the command, with each name
 * test's value (a -regex read as a glob) and literal path operand of the find standing in for
 * `{}`.
 */
function findTarget(rest, depth, set) {
  const standIns = [];
  let operands = true;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (/^-(exec|execdir|ok|okdir)$/.test(word)) break;
    if (word.startsWith('-') || ['(', ')', '!'].includes(word))
      operands = false;
    if (FIND_NAMES.has(word)) {
      standIns.push(
        (rest[++i] ?? '').replace(/\\\./g, '.').replace(/\.\*/g, '*'),
      );
    } else if (operands) standIns.push(word);
  }
  for (let i = 0; i < rest.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(rest[i])) continue;
    let end = i + 1;
    while (end < rest.length && rest[end] !== ';' && rest[end] !== '+') end++;
    const command = rest.slice(i + 1, end);
    const found = first(standIns.length ? standIns : ['{}'], (standIn) =>
      wordsTarget(
        command.map((word) => word.replaceAll('{}', standIn)),
        [],
        depth + 1,
        set,
      ),
    );
    if (found) return found;
    i = end;
  }
  return null;
}

/**
 * The script of `set` one command's words (and prefix) run, by run position, UNKNOWN_OPTION
 * when a package manager's script name can't be read, or null.
 */
function wordsTarget(words, prefix, depth, set) {
  if (words.length === 0 || depth > 4) return null;
  const name = path.basename(words[0]);
  const rest = words.slice(1);
  const run = packageScript(name, rest);
  return (
    prefixTarget(prefix, depth, set) ??
    runTarget(words[0], set, true) ??
    (run?.unknown ? UNKNOWN_OPTION : run ? set.npm(run.script) : null) ??
    (JS_RUNNERS.has(name) ? jsRunnerTarget(name, rest, set) : null) ??
    packageTarget(name, rest, depth, set) ??
    (NPM_RUN_ALL.has(name) ? runAllTarget(rest, set) : null) ??
    (name === 'find' ? findTarget(rest, depth, set) : null) ??
    codeLoaderTarget(name, rest, set) ??
    (name === 'git' ? gitConfigTarget(rest, prefix, depth, set) : null)
  );
}

/** Tools that only read (or check) the files they name, none with an option that runs code. */
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'diff',
  'ls',
  'grep',
  'nl',
  'jq',
  'echo',
]);
/** git subcommands that only read or record files, never run them. */
const GIT_READS = new Set([
  'diff',
  'log',
  'show',
  'blame',
  'status',
  'add',
  'commit',
  'restore',
]);
/** gh subcommands that only write text to GitHub (a title or body naming merge:pr runs nothing). */
const GH_TEXT = /^(pr|issue) (create|edit|comment|view|list|review)$/;

/**
 * A quick pass for what surely runs nothing: a reader, a git subcommand that reads or records,
 * `gh pr|issue create|edit|comment|view|list|review`, never with a prefix (an assignment such
 * as `GIT_PAGER=…` can make a reader run a program) nor a git global option (`-c core.pager=…`).
 * Not exhaustive: everything else is read by run position (wordsTarget).
 */
function readsOnly(name, rest, prefix) {
  if (prefix.length > 0) return false;
  if (READERS.has(name)) return true;
  if (name === 'git')
    return !rest[0]?.startsWith('-') && GIT_READS.has(gitSubcommand(rest).sub);
  if (name === 'gh') return GH_TEXT.test(rest.slice(0, 2).join(' '));
  return false;
}

/**
 * The script of `set` (default: the coordinator's, `merge:pr` or `sync:main`) a subagent's
 * command runs, UNKNOWN_OPTION when a package manager's script name can't be read, or null.
 * @param {string[]} words The command's words, prefixes stripped.
 * @param {string[]} prefix The words stripped before them (`GIT_PAGER=…`, `env`, `sudo`).
 * @param {ScriptSet} [set]
 */
export function coordinatorScript(words, prefix, set = COORDINATOR) {
  const name = words.length ? path.basename(words[0]) : '';
  if (readsOnly(name, words.slice(1), prefix)) return null;
  // An assignment alone (`FILES='a b'`) runs nothing; in front of a command it may.
  return wordsTarget(words, words.length > 0 ? prefix : [], 0, set);
}
