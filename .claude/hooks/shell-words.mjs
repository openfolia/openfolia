// A small shell reader for the PreToolUse guard (.claude/hooks/guard-rules.mjs): splits a Bash
// command into simple commands (at ; && || | & and newlines, and inside $( ) and backticks)
// and each into words, with quotes removed and redirections kept apart. A string handed to a
// shell to run (`sh|bash|zsh|… -c '<string>'`, `fish --command`, `eval <words>`, `npx -c`,
// `su -c`, `watch '<string>'`, …: wrappedScripts) is read the same way, again and again for a
// nested one, so every rule sees the commands inside it too; past MAX_DEPTH the command is
// marked `tooDeep` and the guard blocks it. It is not a shell: it only has to see what a command
// names well enough to block a clear match, and when unsure it reads a word as a command.
// A pipeline into a shell reading its stdin (`echo '…' | sh`, `printf '…\n' | bash`, `… |
// source /dev/stdin`) has the producer's literal text read as commands (echo, printf, a
// here-document or here-string fed to cat); any other producer (curl, a file, a program) can't
// be read, so the command is marked `pipedShell` and the guard blocks it.
import { withHeredocData } from './heredocs.mjs';

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n'];

/** Shells that run a `-c` string. */
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'fish',
  'csh',
  'tcsh',
]);
/** How deep `-c` / `eval` strings are unwrapped (deeper is blocked: tooDeep). */
const MAX_DEPTH = 8;
/** A shell's options that take the next word as their value. */
const SHELL_VALUE_OPTIONS = new Set([
  '-o',
  '+o',
  '-O',
  '+O',
  '--rcfile',
  '--init-file',
]);
/** Package runners and their options that run the next word as a shell string. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun']);
const RUNNER_STRING_OPTIONS = new Set(['-c', '--call', '--shell-mode']);
/** Other commands whose option hands the next word (or its `=value`) to a shell. */
const STRING_OPTIONS = {
  su: ['-c', '--command'],
  runuser: ['-c', '--command'],
  flock: ['-c', '--command'],
  script: ['-c', '--command'],
  env: ['-S', '--split-string'],
};
/** `watch`'s options that take a value: the rest of its words are one shell string. */
const WATCH_VALUE_OPTIONS = new Set(['-n', '--interval', '-q', '--equexit']);

/**
 * The simple commands in `command`, each `{ words: string[], redirects: { op, target }[] }`,
 * plus `inner` (the simple commands of the strings it hands a shell: `wrappedScripts`) when it
 * has any. A command substitution's content is read as commands of its own as well, and so is
 * every here-document body, except one that is surely data (heredocs.mjs: a quoted delimiter,
 * fed to `cat`/`tee` or an interpreter as the last command on its line).
 * @param {string} command
 * @returns {SimpleCommand[]}
 */
export function simpleCommands(command) {
  return readCommands(command, 0);
}

/**
 * @typedef {object} SimpleCommand
 * @property {string[]} words
 * @property {{ op: string, target: string }[]} redirects
 * @property {SimpleCommand[]} [inner]
 * @property {boolean} [tooDeep] It hands a shell a string nested deeper than MAX_DEPTH.
 * @property {'open' | 'close'} [subshell] No command: a `(` subshell starts or ends here (its
 *   words are empty), so a `cd` inside it stays inside. A `{ …; }` group is the same shell and
 *   gets no mark.
 */

/**
 * @param {string} command
 * @param {number} depth
 * @returns {SimpleCommand[]}
 */
function readCommands(command, depth) {
  const out = [];
  const text = withHeredocData(command);
  for (const source of [text, ...substitutions(text)]) {
    const segments = splitSegments(source);
    for (const [k, segment] of segments.entries()) {
      if (segment.subshell) {
        out.push({ words: [], redirects: [], subshell: segment.subshell });
        continue;
      }
      const parsed = parseSegment(segment.text);
      if (parsed.words.length === 0 && parsed.redirects.length === 0) continue;
      const scripts = wrappedScripts(parsed.words, parsed.redirects);
      if (
        k > 0 &&
        ['|', '|&'].includes(segments[k - 1].op) &&
        readsStdinAsShell(parsed.words)
      ) {
        const fed = producerText(parseSegment(segments[k - 1].text));
        if (fed === null) {
          out.push({ ...parsed, pipedShell: true });
          continue;
        }
        scripts.push(fed);
      }
      if (scripts.length > 0 && depth >= MAX_DEPTH) {
        out.push({ ...parsed, tooDeep: true });
        continue;
      }
      const inner = scripts.flatMap((script) =>
        readCommands(script, depth + 1),
      );
      out.push(inner.length > 0 ? { ...parsed, inner } : parsed);
    }
  }
  return out;
}

/**
 * The strings a command's words hand a shell to run, found at any word, not only the first
 * (`xargs -I{} sh -c …`, `timeout 5 bash -c …`, `find . -exec sh -c …`): reading too much only
 * adds commands for the rules to check.
 * - `eval`'s words joined;
 * - a shell's `-c` (`-lc`, `-ec`, …) or fish's `--command` string: the first word after it that
 *   isn't an option (or an option's value), wherever it stands among the shell's options
 *   (`bash --rcfile f -O x -c '…'`); a here-string fed to a shell (`bash <<< '…'`);
 * - a package runner's `-c` / `--call` / `--shell-mode` before its package (`npx -c '…'`,
 *   `npm exec --call=…`, `pnpm dlx -c …`);
 * - `su`/`runuser`/`flock`/`script` `-c`/`--command`, `env -S`/`--split-string`;
 * - `watch`'s words after its options, joined; each operand of `concurrently`.
 * @param {string[]} words
 * @param {{ op: string, target: string }[]} [redirects]
 */
function wrappedScripts(words, redirects = []) {
  const scripts = [];
  words.forEach((word, i) => {
    const name = word.split('/').pop();
    if (name === 'eval' && i + 1 < words.length)
      scripts.push(words.slice(i + 1).join(' '));
    if (SHELLS.has(name)) scripts.push(...shellStrings(words, i));
    if (RUNNERS.has(name)) scripts.push(...runnerStrings(words, i));
    if (name in STRING_OPTIONS)
      scripts.push(...optionStrings(words, i, STRING_OPTIONS[name]));
    if (name === 'watch') scripts.push(...watchString(words, i));
    // concurrently runs each operand as a command line (option values read too: harmless).
    if (name === 'concurrently')
      scripts.push(...words.slice(i + 1).filter((w) => !/^-/.test(w)));
  });
  if (words.some((word) => SHELLS.has(word.split('/').pop()))) {
    scripts.push(
      ...redirects.filter(({ op }) => op === '<<<').map(({ target }) => target),
    );
  }
  return scripts;
}

/** Wrappers that may stand before a shell reading a pipe (`… | sudo -u x bash`). */
const PIPE_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
]);

/**
 * Whether a pipeline's consumer is a shell that runs what it reads on stdin: a shell with no
 * `-c` string and no script file (or `-s`, `-`, `/dev/stdin`), or `source`/`.` of /dev/stdin.
 */
function readsStdinAsShell(words) {
  let i = 0;
  while (
    i < words.length &&
    (PIPE_WRAPPERS.has(words[i].split('/').pop()) ||
      /^[A-Za-z_]\w*=/.test(words[i]) ||
      (words[i].startsWith('-') && words[i].length > 1))
  ) {
    i++;
  }
  const name = (words[i] ?? '').split('/').pop();
  const rest = words.slice(i + 1);
  const stdin = (word) => word === '-' || /^\/dev\/(stdin|fd\/0)$/.test(word);
  if (name === 'source' || name === '.')
    return rest.length === 0 || stdin(rest[0]);
  if (!SHELLS.has(name)) return false;
  for (let j = 0; j < rest.length; j++) {
    const word = rest[j];
    if (word === '-s' || stdin(word)) return true;
    if (
      word === '--command' ||
      word.startsWith('--command=') ||
      /^-[A-Za-z]*c[A-Za-z]*$/.test(word)
    ) {
      return false;
    }
    if (SHELL_VALUE_OPTIONS.has(word)) j++;
    else if (!/^[-+]/.test(word)) return false; // a script file
  }
  return true;
}

/**
 * The text a pipeline's producer feeds a shell, when the guard can read it: echo's or printf's
 * words (`\n` as a line break), a here-string, or '' for a here-document fed to `cat` (its body
 * is read as commands already). Null for anything else (curl, `cat file`, a program).
 */
function producerText({ words, redirects }) {
  const name = (words[0] ?? '').split('/').pop();
  const lines = (parts) => parts.join(' ').replace(/\\n/g, '\n');
  if (name === 'echo') {
    let i = 1;
    while (/^-[neE]+$/.test(words[i] ?? '')) i++;
    return lines(words.slice(i));
  }
  if (name === 'printf') return lines(words.slice(1));
  if (name === 'cat' && words.length === 1) {
    const fed = redirects.filter(({ op }) => op === '<<' || op === '<<<');
    if (fed.length > 0 && fed.length === redirects.length) {
      return fed
        .map(({ op, target }) => (op === '<<<' ? target : ''))
        .join('\n');
    }
  }
  return null;
}

/** The `-c` / `--command` string of the shell at `words[at]`, wherever it stands. */
function shellStrings(words, at) {
  let runsString = false;
  for (let j = at + 1; j < words.length; j++) {
    const word = words[j];
    if (word.startsWith('--command=')) return [word.slice('--command='.length)];
    if (word === '--')
      return runsString && j + 1 < words.length ? [words[j + 1]] : [];
    if (word === '--command' || /^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      runsString = true;
      continue;
    }
    if (SHELL_VALUE_OPTIONS.has(word) || /^-[A-Za-z]*[oO]$/.test(word)) {
      j++;
      continue;
    }
    if (/^[-+]/.test(word) && word.length > 1) continue;
    if (runsString) return [word];
  }
  return [];
}

/** A package runner's shell string (`-c`, `--call`, `--shell-mode`), before its package. */
function runnerStrings(words, at) {
  const scripts = [];
  let j = at + 1;
  // npm/pnpm/yarn/bun run one through `exec`, `x` or `dlx`.
  if (!/^(npx|pnpx|bunx)$/.test(words[at].split('/').pop())) {
    if (!['exec', 'x', 'dlx'].includes(words[j] ?? '')) return [];
    j++;
  }
  for (; j < words.length && words[j].startsWith('-'); j++) {
    const word = words[j];
    const eq = word.indexOf('=');
    if (eq > 0 && RUNNER_STRING_OPTIONS.has(word.slice(0, eq)))
      scripts.push(word.slice(eq + 1));
    else if (RUNNER_STRING_OPTIONS.has(word) && j + 1 < words.length)
      scripts.push(words[++j]);
    else if (word === '-p' || word === '--package') j++;
  }
  return scripts;
}

/** The strings `options` (`-c`, `--command`, …) of the command at `words[at]` hand a shell. */
function optionStrings(words, at, options) {
  const scripts = [];
  for (let j = at + 1; j < words.length; j++) {
    const word = words[j];
    const eq = word.indexOf('=');
    if (eq > 0 && options.includes(word.slice(0, eq)))
      scripts.push(word.slice(eq + 1));
    else if (options.includes(word) && j + 1 < words.length)
      scripts.push(words[++j]);
  }
  return scripts;
}

/** `watch [options] <words>`: its words joined, as `watch` runs them (`sh -c`). */
function watchString(words, at) {
  let j = at + 1;
  while (j < words.length && words[j].startsWith('-'))
    j += WATCH_VALUE_OPTIONS.has(words[j]) ? 2 : 1;
  return j < words.length ? [words.slice(j).join(' ')] : [];
}

/** The text inside every `$( … )` and backtick pair (outside single quotes). */
function substitutions(command) {
  const found = [];
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')') depth--;
      }
      const inner = command.slice(i + 2, j - 1);
      found.push(inner, ...substitutions(inner));
      i = j - 1;
    } else if (ch === '`') {
      const end = command.indexOf('`', i + 1);
      if (end === -1) break;
      const inner = command.slice(i + 1, end);
      found.push(inner);
      i = end;
    }
  }
  return found;
}

/**
 * The command split at its operators, outside quotes: each part and the operator after it, and
 * a `{ subshell: 'open' | 'close' }` part at each `(` and `)` of a subshell.
 */
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let lastGt = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    // `afterGt`: the character before was an unquoted, unescaped `>` (set by this loop only).
    const afterGt = lastGt;
    lastGt = false;
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += command[++i] ?? '';
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\\') {
      current += ch + (command[++i] ?? '');
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    // `>&` and `&>` are redirections, not the background operator; `>|` is one, not a pipe.
    if (ch === '&' && (afterGt || command[i + 1] === '>')) {
      current += ch;
      continue;
    }
    if (ch === '|' && afterGt) {
      current += ch;
      continue;
    }
    const op = OPERATORS.find((candidate) => command.startsWith(candidate, i));
    if (op) {
      segments.push({ text: current, op });
      current = '';
      i += op.length - 1;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      // A command substitution stays one word here (simpleCommands reads its inside too).
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')' && --depth === 0) break;
      }
      current += command.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      // Subshells and groups: their content is read as commands of the same line.
      if (ch === '{' || ch === '}') {
        const prev = command[i - 1];
        const next = command[i + 1];
        const standalone =
          (prev === undefined || /\s/.test(prev)) &&
          (next === undefined || /\s|;/.test(next));
        if (!standalone) {
          current += ch;
          continue;
        }
      } else if (command[i - 1] === '$') {
        current += ch;
        continue;
      }
      segments.push({ text: current, op: '' });
      current = '';
      if (ch === '(') segments.push({ text: '', op: '', subshell: 'open' });
      if (ch === ')') segments.push({ text: '', op: '', subshell: 'close' });
      continue;
    }
    if (ch === '>') lastGt = true;
    current += ch;
  }
  segments.push({ text: current, op: '' });
  return segments;
}

const REDIRECT = /^(\d*|&)(>>|>\||>&|>|<<<|<<|<&|<>|<)(.*)$/;

/** One simple command's words (quotes removed) and redirections. */
function parseSegment(segment) {
  const raw = rawWords(segment);
  const words = [];
  const redirects = [];
  for (let i = 0; i < raw.length; i++) {
    const { text } = raw[i];
    // The operator must stand unquoted at the word's start; its target may be quoted
    // (`<<'EOF'`, `>"out file"`). A word that starts with a quote is never a redirection.
    const match = REDIRECT.exec(text);
    if (match) {
      const op = match[2];
      // The target's unquoted value (`<".env"'.local'` is `.env.local`): the operator stands
      // unquoted at the start, so the value starts with it too.
      let target;
      if (match[3] === '' && i + 1 < raw.length) target = raw[++i].value;
      else target = raw[i].value.slice(match[1].length + op.length);
      // `2>&1`, `>&2`: a descriptor, not a file.
      if (!/^\d+$|^-$/.test(target) || !op.includes('&'))
        redirects.push({ op, target });
      continue;
    }
    words.push(raw[i].value);
  }
  return { words, redirects };
}

/** Words as written (`text`) and with quotes removed (`value`). */
function rawWords(segment) {
  const words = [];
  let text = '';
  let value = '';
  let quote = null;
  let started = false;
  const push = () => {
    if (started) words.push({ text, value });
    text = '';
    value = '';
    started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      text += ch;
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        text += segment[i + 1];
        value += segment[++i];
      } else {
        value += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    // An unquoted `<`, `>` or `&>` ends the word before it (`x<.env` is `x` and `<.env`, as the
    // shell reads it), unless the word so far is the redirection's descriptor (`2>`, `&>`) or
    // its operator (`>>`, `<<`, `>&`).
    const redirectStart =
      ch === '<' || ch === '>' || (ch === '&' && segment[i + 1] === '>');
    if (redirectStart && started && !/^(\d+|&)?([<>][<>&|]?)?$/.test(text))
      push();
    started = true;
    if (ch === "'" || ch === '"') {
      quote = ch;
      text += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      text += ch + segment[i + 1];
      value += segment[++i];
      continue;
    }
    text += ch;
    value += ch;
  }
  push();
  return words;
}
