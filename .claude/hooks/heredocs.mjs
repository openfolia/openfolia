// Here-documents for the shell reader (shell-words.mjs). A here-document body is read as
// commands of its own (a body fed to `bash` runs), so text inside one that only looks like a
// command (a Python edit script holding a `pkill -f` or `git push` string) used to be blocked as
// one. This narrows that, never more: a body counts as data only when the shell surely doesn't
// run it, i.e. ALL of
//   - its delimiter is quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`, `<<E'O'F`): no `$( )` or
//     backtick inside it is expanded. The delimiter is the whole shell word, as bash reads it
//     (quotes removed, the parts kept together: `<<'EOF'x` ends at `EOFx`, not at `EOF`);
//   - it is the only here-document on its line, and the line has no subshell, group, command
//     substitution or process substitution (`(`, `)`, `{`, `}`, backtick) outside quotes;
//   - its simple command stands at the top level of the whole command: nothing before it (the
//     earlier lines included) opens a group, subshell, substitution or compound command (`(`,
//     `{`, backtick, `while`, `for`, `if`, `do`, …), and it is in no pipeline (no `|` before it,
//     and nothing after it on its line);
//   - its command is named plainly (no `sudo`/`env` wrapper), and is a reader that doesn't run
//     its input as shell: `cat` or `tee` writing to at least one named file (the body is
//     dropped: their output target stays a redirection the guard reads; to stdout or `>&2` it
//     stays commands), or an interpreter (`python3`, `node`, …: the body becomes the script's
//     one quoted word, so the secret-file check on an interpreter's script text still reads it,
//     as with `-c`);
//   - for `cat`/`tee` an allowlist, not a list of ways to run a file: every file it writes is
//     named plainly with a data or source extension (DATA_EXTENSIONS), and the rest of the
//     command (the body and the writer itself left out) has no word that runs or moves a file
//     (`sh`, `source`, `.`, `eval`, `xargs`, `env`, `chmod`, `mv`, `cp`, …: EXEC_WORDS), no
//     interpreter or runner (`node`, `python3`, `npx`, `tsx`, …: RUNNERS), no word that names a
//     file it writes (its path or its file name, anywhere in a word: `node x.mjs`,
//     `--import=./x.mjs`), no `$(`, backtick or `<` input redirection, and no command named by
//     a path or a variable (`./s.txt`, `$SHELL`);
//   - its closing delimiter line exists.
// A commit or PR message is data as well (git and gh run none of it): the body of
// `"$(cat <<'X'` … `X` `)"` that is one whole argument of a top-level `git commit|tag` or `gh
// pr|issue create|edit|comment|review` (withMessageBodies), and a quoted-delimiter body on the
// stdin of `git commit -F -` / `gh … --body-file -`; a `cat` writing a message file that only
// such a command names (`-F msg.txt`, `--body-file pr.md`) still counts as data. (Reading it as
// data only keeps its words from counting as commands: a PR or issue text given through a
// here-document is still refused, by guard-rules.mjs; such bodies go into a file written with
// the Write tool and `--body-file`.)
// Anything else is left exactly as written, read the old way (the body as commands).
//
// The point is data an edit script writes, or a script written now and run in a LATER call.
// The cost, accepted: `cat > x.py <<'EOF' … EOF && python3 x.py` in one call has its body read
// as commands again (a line that looks like a blocked command blocks it); write the file in one
// call and run it in the next.
//
// The guard prevents mistakes, not a determined adversary (guard-rules.mjs, "Threat model"). A
// file written here and run in a LATER tool call (`python3 x.py` whose script calls subprocess,
// a `.txt` piped to `sh` next time) can't be seen from this command, and that is accepted: the
// later call is read on its own.

/** Commands whose here-document is data written somewhere: the body is dropped. */
const WRITERS = new Set(['cat', 'tee']);
/** Interpreters: the body is their script, kept as one word for the script-text checks. */
const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'php',
  'deno',
  'bun',
]);

/** Words that open a compound command: a here-document after one is never data. */
const KEYWORDS = new Set(
  'while until for if case select do done then else elif fi esac function coproc { } [['.split(
    ' ',
  ),
);

/**
 * Extensions of the files a writer's body may go to and stay data: what agents write with a
 * here-document (notes, configs, edit scripts, source, SQL). No shell's, none at all, nothing
 * a shell sources (`.env`, `.profile`).
 */
const DATA_EXTENSIONS =
  /\.(md|txt|json|py|js|mjs|ts|tsx|sql|toml|ya?ml|css|html)$/i;
/** Words that run, source, or move/copy/link/make runnable a file: any one makes it commands. */
const EXEC_WORDS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'source',
  '.',
  'eval',
  'exec',
  'command',
  'builtin',
  'xargs',
  'env',
  'sudo',
  'nohup',
  'chmod',
  'mv',
  'cp',
  'ln',
  'install',
]);
/** Interpreters and runners that run a file they're given (a written `.mjs`, `.py`, …). */
const RUNNERS = new Set([
  ...INTERPRETERS,
  'tsx',
  'ts-node',
  'npx',
  'bunx',
  'pnpx',
  'npm',
  'pnpm',
  'yarn',
  'vite-node',
]);

/**
 * The line's characters outside quotes (quoted ones blanked), and whether a quote is still
 * open at its end (`open`: the quote character, or null).
 */
function unquoted(line, open) {
  let quote = open;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      out += ' ';
      continue;
    }
    if (ch === '\\') {
      out += '  ';
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return { bare: out, open: quote };
}

/**
 * The here-document operator's delimiter at `line[at]` (`<<` or `<<-`), read as bash reads the
 * word: up to an unquoted blank or operator character, quotes removed, the parts concatenated
 * (`'EOF'x` is `EOFx`). `{ delimiter, quoted, strip, end }`, or null when it isn't clear (an
 * unclosed quote, a `$`, an empty word).
 */
function delimiterAt(line, at) {
  let i = at + 2;
  const strip = line[i] === '-';
  if (strip) i++;
  while (line[i] === ' ' || line[i] === '\t') i++;
  let delimiter = '';
  let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) return null;
      delimiter += line.slice(i + 1, close);
      quoted = true;
      i = close;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && /[$`"\\]/.test(line[j + 1] ?? '')) j++;
        delimiter += line[j];
      }
      if (j >= line.length) return null;
      quoted = true;
      i = j;
    } else if (ch === '\\') {
      if (i + 1 >= line.length) return null;
      delimiter += line[++i];
      quoted = true;
    } else if (/[\s;&|<>()]/.test(ch)) {
      break;
    } else {
      delimiter += ch;
    }
  }
  if (delimiter === '' || delimiter.includes('$')) return null;
  return { delimiter, quoted, strip, end: i };
}

/**
 * Whether a here-document's command, after the text `before` (the earlier lines as already
 * rewritten, and its own line up to the command), stands at the top level: nothing in it opens
 * a group, subshell, substitution or compound command, and no pipe feeds into it.
 */
function atTopLevel(before) {
  const { bare, open } = unquoted(before, null);
  if (open !== null || /[(){}`]/.test(bare)) return false;
  if (/\|\s*$/.test(bare)) return false;
  return bare
    .split(/[;&|\n]+/)
    .every(
      (part) =>
        !KEYWORDS.has(part.trim().split(/\s+/)[0] ?? '') && !/^\s*!/.test(part),
    );
}

/** A body as one single-quoted shell word. */
const quoteWord = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The consumer of the here-document on a line whose unquoted text is `bare`: the plain name of
 * the last command on the line, when it holds the operator, or null when it isn't clear.
 */
function consumer(bare, opAt) {
  if (/[(){}`]/.test(bare)) return null;
  // The last command on the line: after the last operator (`;`, `&`, `|`, `&&`, `||`), a file
  // descriptor's `>&2` aside.
  const lastOp = Math.max(
    ...[';', '&', '|'].map((op) =>
      bare.replace(/>&\d/g, '   ').lastIndexOf(op),
    ),
  );
  if (lastOp > opAt) return null;
  const words = bare
    .slice(lastOp + 1, opAt)
    .trim()
    .split(/\s+/)
    .filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const name = (words[0] ?? '').split('/').pop();
  if (INTERPRETERS.has(name)) return { name, start: lastOp + 1 };
  // A commit or PR message read from stdin: data, dropped like a writer's.
  if (messageFromStdin(words)) return { name: 'message', start: lastOp + 1 };
  return WRITERS.has(name) ? { name, start: lastOp + 1 } : null;
}

/**
 * The files a `cat`/`tee` command (its unquoted text `segment`) writes, or null when one isn't
 * named plainly (a quoted name is blanked in the unquoted text). `>&2` writes no file.
 */
function writtenFiles(name, segment) {
  const files = [];
  const words = segment
    .replace(/<<-?\s*/g, ' ')
    .trim()
    .split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const redirect = /^(?:\d|&)?>>?\|?(.*)$/.exec(word);
    if (redirect) {
      if (/^&\d$/.test(redirect[1])) continue;
      const target = redirect[1] || words[++i] || '';
      if (!target || /[<>]/.test(target)) return null;
      files.push(target);
    } else if (name === 'tee' && i > 0 && !word.startsWith('-')) {
      files.push(word);
    }
  }
  return files;
}

/** The text's words, split at blanks and the shell's operators, quotes dropped. */
const wordsOf = (text) =>
  text
    .replace(/['"\\]/g, '')
    .split(/[\s;&|<>()]+/)
    .filter(Boolean);

/** The first word of each simple command in the text (split at `;`, `&`, `|`, line ends). */
const commandNames = (text) =>
  text
    .split(/[;&|\n]+/)
    .map(
      (part) =>
        part
          .replace(/['"]/g, '')
          .trim()
          .split(/\s+/)
          .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? '',
    )
    .filter(Boolean);

const base = (word) => word.split('/').pop();

/**
 * Whether a here-document written by `cat`/`tee` (unquoted text `segment`) may be run as shell:
 * true unless every file it writes is named plainly with a data extension and `rest` (the
 * command without the body) holds nothing that could run, source, move or feed a file to
 * anything (see the header). `others`: `rest` without the writer's own command, so the file
 * names it writes don't count as naming them.
 */
function mayRunAsShell(name, segment, rest, others) {
  const files = writtenFiles(name, segment);
  // To stdout (or `>&2`) the body may reach anything that reads it: commands.
  if (files === null || files.length === 0) return true;
  if (files.some((file) => !DATA_EXTENSIONS.test(base(file)))) return true;
  if (/\$\(|`/.test(rest) || /</.test(rest.replace(/<<+-?/g, ''))) return true;
  const words = wordsOf(rest);
  if (
    words.some((word) => EXEC_WORDS.has(base(word)) || RUNNERS.has(base(word)))
  )
    return true;
  const names = files.flatMap((file) => [file, base(file)]);
  // A commit or PR command naming the file reads it as its message (`git commit -F msg.txt`,
  // `gh pr create --body-file pr.md`): no run.
  const runners = others
    .split(/[;&|\n]+/)
    .filter((part) => !writesMessage(plainWords(unquoted(part, null).bare)))
    .join('\n');
  if (
    wordsOf(runners).some((word) => names.some((file) => word.includes(file)))
  )
    return true;
  return commandNames(rest).some(
    (word) => word.includes('/') || word.startsWith('$'),
  );
}

/**
 * Whether a command's words (quotes blanked) write a commit, tag, PR or issue text: `git
 * [-C <dir>] [--no-pager] commit|tag …` or `gh [-R <repo>] pr|issue
 * create|edit|comment|review …`. Its message is data: neither runs it.
 */
function writesMessage(words) {
  let i = 1;
  if (words[0] === 'git') {
    while (words[i] === '-C' || words[i] === '--no-pager')
      i += words[i] === '-C' ? 2 : 1;
    return ['commit', 'tag'].includes(words[i]);
  }
  if (words[0] !== 'gh') return false;
  if (words[i] === '-R' || words[i] === '--repo') i += 2;
  return (
    ['pr', 'issue'].includes(words[i]) &&
    /^(create|edit|comment|review)$/.test(words[i + 1])
  );
}

/** The words of a command text (quotes blanked first: unquoted()). */
const plainWords = (bare) => bare.trim().split(/\s+/).filter(Boolean);

/**
 * Whether the message command (words `words`) reads its message from stdin: `git commit|tag -F
 * -` / `--file=-` / `--file -`, `gh … --body-file -` / `-F -`.
 */
const messageFromStdin = (words) =>
  writesMessage(words) &&
  words.some(
    (word, i) =>
      ((word === '-F' || word === '--file' || word === '--body-file') &&
        words[i + 1] === '-') ||
      word === '--file=-' ||
      word === '--body-file=-',
  );

/**
 * A message given as `"$(cat <<'X'` … `X` `)"`, the whole of one argument of a top-level
 * `git commit|tag` or `gh pr|issue create|edit|comment|review` (the form Claude Code writes a
 * commit or PR body in), rewritten as one single-quoted word: the delimiter is quoted, so
 * nothing in the body is expanded, and the only reader is that command, which runs none of it.
 * Anything else is left as it is.
 */
function withMessageBodies(command) {
  const open =
    /"\$\(\s*cat\s+<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\(\w+))[ \t]*\n/g;
  let out = '';
  let from = 0;
  for (let match = open.exec(command); match; match = open.exec(command)) {
    const delimiter = match[2] ?? match[3] ?? match[4];
    const lineStart = command.lastIndexOf('\n', match.index) + 1;
    const before = command.slice(lineStart, match.index);
    // The argument stands alone (after a blank, or `--body=`), and its command is a message one.
    const { bare, open: quote } = unquoted(before, null);
    const segment = bare.split(/&&|\|\||[;&|]/).pop() ?? '';
    const bodyStart = match.index + match[0].length;
    const lines = command.slice(bodyStart).split('\n');
    const end = lines.findIndex(
      (line) => (match[1] ? line.replace(/^\t+/, '') : line) === delimiter,
    );
    const close =
      end === -1 ? null : /^\s*\)"(?=$|[\s;&|)])/.exec(lines[end + 1] ?? '');
    if (
      quote !== null ||
      !/(^|\s|=)$/.test(before) ||
      !writesMessage(plainWords(segment.replace(/=$/, ' '))) ||
      !atTopLevel(
        command.slice(0, lineStart) +
          before.slice(0, before.length - segment.length),
      ) ||
      close === null
    ) {
      continue;
    }
    const body = lines.slice(0, end).join('\n');
    const after =
      bodyStart +
      lines.slice(0, end + 1).join('\n').length +
      1 +
      close[0].length;
    out += command.slice(from, match.index) + quoteWord(body);
    from = after;
    open.lastIndex = after;
  }
  return out + command.slice(from);
}

/**
 * `command` with every here-document body that is surely data rewritten as above (dropped for
 * a writer or a message command reading stdin, one quoted word for an interpreter, a commit
 * or PR message as one quoted word: withMessageBodies); everything else unchanged.
 */
export function withHeredocData(command) {
  const lines = withMessageBodies(command).split('\n');
  const out = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const scan = unquoted(line, open);
    const startedOpen = open !== null;
    open = scan.open;
    // `<<<` is a here-string, not a here-document: a line with one is left as it is.
    const ops = scan.bare.split('<<').length - 1;
    const opAt = scan.bare.indexOf('<<');
    // One operator, outside quotes, the line in no quote and not continued on the next (a
    // trailing `\` would carry `| sh` past the body), its delimiter quoted.
    const word = opAt === -1 ? null : delimiterAt(line, opAt);
    if (
      startedOpen ||
      open !== null ||
      ops !== 1 ||
      scan.bare.includes('<<<') ||
      /\\$/.test(line) ||
      word === null ||
      !word.quoted
    ) {
      out.push(line);
      continue;
    }
    // The line's unquoted text with the operator and its delimiter blanked.
    const bare =
      scan.bare.slice(0, opAt) +
      ' '.repeat(word.end - opAt) +
      scan.bare.slice(word.end);
    const found = consumer(bare, opAt);
    const { delimiter, strip } = word;
    const end = lines.findIndex(
      (candidate, j) =>
        j > i &&
        (strip ? candidate.replace(/^\t+/, '') : candidate) === delimiter,
    );
    const rest = [...lines.slice(0, i), line, ...lines.slice(end + 1)].join(
      '\n',
    );
    const others = found
      ? [
          ...lines.slice(0, i),
          line.slice(0, found.start),
          ...lines.slice(end + 1),
        ].join('\n')
      : '';
    if (
      !found ||
      end === -1 ||
      !atTopLevel([...out, line.slice(0, found.start)].join('\n')) ||
      (WRITERS.has(found.name) &&
        mayRunAsShell(found.name, bare.slice(found.start), rest, others))
    ) {
      out.push(line);
      continue;
    }
    const body = lines.slice(i + 1, end).join('\n');
    out.push(
      INTERPRETERS.has(found.name) ? `${line} ${quoteWord(body)}` : line,
    );
    i = end;
  }
  return out.join('\n');
}
