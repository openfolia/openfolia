// Which package.json script a command runs, for every rule that checks a script name
// (coordinator-scripts.mjs: merge:pr and sync:main, which subagent-rules.mjs refuses). One
// reader, so `node --run sync:main` and `pnpm --reporter silent sync:main` count wherever
// `pnpm sync:main` does:
// - `npm|pnpm|yarn|bun run|run-script <script>` (npm's aliases `rum`, `urn` too), npm's own
//   script commands (`npm test|t|tst|start|stop|restart`), a bare `pnpm|yarn|bun <script>`,
//   `yarn workspace <name> <script>`;
// - `node --run <script>` / `--run=<script>` (Node 22+);
// - never `npm exec|x`, `pnpm|yarn dlx|exec`, `bun x`: those run a package's bin
//   (coordinator-scripts.mjs reads them as commands).
// The package manager's own options before the script name are read from two tables (options
// that take the next word as their value, and flags); an option in neither may take the next
// word or not, so the script is UNKNOWN, and every rule that would block a script blocks it
// ("put options after the script or use --opt=value"): the guard doesn't guess.

const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** The subcommands that run a script named next. */
const RUN = new Set(['run', 'run-script', 'rum', 'urn']);
/** npm's commands that run the script of the same name (`npm t` runs `test`). */
const NPM_SCRIPT_COMMANDS = {
  test: 'test',
  t: 'test',
  tst: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};
/** Subcommands that run a package's bin, never a script. */
const EXEC = new Set(['exec', 'x', 'dlx']);

/** Global options of every manager that take the next word as their value. */
const COMMON_VALUES = [
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '--workspace',
  '--filter',
  '-F',
  '--loglevel',
  '--userconfig',
  '--globalconfig',
  '--reporter',
  '--registry',
  '--cache',
  '--cache-folder',
  '--modules-folder',
  '--config',
  '--script-shell',
  '--node-options',
  '--include',
  '--omit',
  '--tag',
  '--otp',
  '--scope',
  '--env-file',
  '--mutex',
  '--network-timeout',
  '--workspace-concurrency',
];
/** Global flags of every manager (`--no-…` too). */
const COMMON_FLAGS = [
  '--silent',
  '-s',
  '-q',
  '--quiet',
  '-d',
  '-dd',
  '-ddd',
  '--verbose',
  '--if-present',
  '--ignore-scripts',
  '--workspaces',
  '-ws',
  '--include-workspace-root',
  '-y',
  '--yes',
  '--foreground-scripts',
  '--offline',
  '--prefer-offline',
  '--prefer-online',
  '--json',
  '--global',
  '-g',
  '-r',
  '--recursive',
  '--parallel',
  '--stream',
  '--aggregate-output',
  '--sequential',
  '--use-stderr',
  '--workspace-root',
  '--frozen-lockfile',
  '--bun',
  '-b',
  '--smol',
  '--watch',
  '--hot',
];
/** Where one manager reads an option differently (`-w`: npm's workspace, pnpm's root flag). */
const OWN = {
  npm: { values: ['-w'], flags: [] },
  pnpm: { values: [], flags: ['-w'] },
  yarn: { values: [], flags: [] },
  bun: { values: ['-c'], flags: [] },
};
const TABLES = Object.fromEntries(
  Object.entries(OWN).map(([name, own]) => [
    name,
    {
      values: new Set([...COMMON_VALUES, ...own.values]),
      flags: new Set([...COMMON_FLAGS, ...own.flags]),
    },
  ]),
);

/** Whether `option` of a manager takes the next word as its value (false: a flag or unknown). */
export function managerOptionTakesValue(manager, option) {
  return TABLES[manager]?.values.has(option) ?? false;
}

/**
 * The index of the first word from `start` that isn't one of the manager's options (or an
 * option's value), or -1 when an option is in neither table (or a `--` stands before the name).
 */
function pastOptions(manager, rest, start) {
  const { values, flags } = TABLES[manager];
  let i = start;
  while (i < rest.length && rest[i].startsWith('-') && rest[i].length > 1) {
    const word = rest[i];
    if (word === '--') return -1;
    if (word.includes('=') || flags.has(word) || /^--no-/.test(word)) i++;
    else if (values.has(word)) i += 2;
    else return -1;
  }
  return i;
}

/**
 * @typedef {{ script: string, args: string[], unknown?: false }
 *   | { script: null, args: string[], unknown: true }} ScriptRun
 *   `args`: the words after the script name (all of them when it is unknown).
 */

/**
 * The package.json script a command runs (its name and the words after it), `{ unknown: true }`
 * when an option the tables don't know stands before the script name, or null when it runs
 * none.
 * @param {string} name The command's name (basename).
 * @param {string[]} rest Its words after the name.
 * @returns {ScriptRun | null}
 */
export function packageScript(name, rest) {
  if (name === 'node' || name === 'nodejs') return nodeRun(rest);
  if (!MANAGERS.has(name)) return null;
  const unknown = { script: null, args: rest, unknown: true };
  let i = pastOptions(name, rest, 0);
  if (i === -1) return unknown;
  if (name === 'yarn' && rest[i] === 'workspace') {
    i = pastOptions(name, rest, i + 2);
    if (i === -1) return unknown;
  }
  const sub = rest[i];
  if (sub === undefined || EXEC.has(sub)) return null;
  if (RUN.has(sub)) {
    const at = pastOptions(name, rest, i + 1);
    if (at === -1) return unknown;
    return rest[at] === undefined
      ? null
      : { script: rest[at], args: rest.slice(at + 1) };
  }
  if (name === 'npm') {
    const script = NPM_SCRIPT_COMMANDS[sub];
    return script ? { script, args: rest.slice(i + 1) } : null;
  }
  return { script: sub, args: rest.slice(i + 1) };
}

/** `node [options] --run <script> [args]` / `--run=<script>` (before a `--`). */
function nodeRun(rest) {
  for (let i = 0; i < rest.length && rest[i] !== '--'; i++) {
    if (rest[i] === '--run' && rest[i + 1] !== undefined) {
      return { script: rest[i + 1], args: rest.slice(i + 2) };
    }
    if (rest[i].startsWith('--run=')) {
      return {
        script: rest[i].slice('--run='.length),
        args: rest.slice(i + 1),
      };
    }
  }
  return null;
}
