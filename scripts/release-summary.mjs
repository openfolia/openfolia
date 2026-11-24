// A release's written summary (#812): `release-notes/<version>.md` (English) and
// `release-notes/<version>.de.md` (German), committed before the tag. The release step puts it
// first in the release's notes (scripts/release-plan.mjs) and its text into
// `changelog/<version>.json`; the docs site shows it first on /changelog
// (frontend/docs/scripts/lib/changelog.mjs, components/changelog-release.tsx).
//
// The file is read as text, never as Markdown or HTML: paragraphs (separated by a blank line) and
// `- ` bullets, `code` between a pair of backticks, and links only where this module finds them
// itself: a bare `https://` address, or a relative path of the repository (`deploy/README.md`,
// `CONTRIBUTING.md`), linked to the file at the release's tag. Anything else (a `javascript:` or
// `http:` address, `[text](url)`, `<a>`, `*emphasis*`) stays text.

/** A bare `https://` address, up to a space, a quote or an angle bracket. */
const URL_START = /(?<![\w/.:@-])https:\/\/[^\s<>"'`]+/gi;

/**
 * A relative path of the repository: two or more segments, the last with an extension
 * (`deploy/README.md`, `deploy/compose.yaml`), or a file at the root named in capitals
 * (`CONTRIBUTING.md`); optionally an anchor (`deploy/README.md#upgrades`). No segment starts with a
 * dot, so the path never leaves the repository (`..`) or names a hidden file.
 */
const PATH =
  /(?<![\w/.:@#-])((?:[A-Za-z0-9_][\w.-]*\/)+[A-Za-z0-9_][\w-]*(?:\.[\w-]+)*\.[A-Za-z0-9]+|[A-Z][A-Z0-9_-]*\.md)(#[\w-]+)?(?![\w/])/g;

/** What ends a sentence after an address, rather than belonging to it. */
const TRAILING = '.,;:!?\'"*_';

/** Brackets an address may hold in pairs: a closing one without its opener ends it. */
const PAIRS = { ')': '(', ']': '[', '}': '{' };

/**
 * An address cut where it ends: trailing punctuation off, and a `)` that closes no `(` of it.
 * One pass from the end, so a long run of punctuation costs no more than its length.
 */
function trimAddress(raw) {
  const count = {};
  for (const c of raw) count[c] = (count[c] ?? 0) + 1;
  let end = raw.length;
  while (end > 0) {
    const c = raw[end - 1];
    if (TRAILING.includes(c)) end--;
    else if (c in PAIRS && (count[PAIRS[c]] ?? 0) < count[c]) {
      count[c]--;
      end--;
    } else break;
  }
  return raw.slice(0, end);
}

/** The address of a link, when it is an https one without a user or password; else null. */
export function httpsAddress(text) {
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Paths and plain text of a stretch of text with no address in it. */
function pathsIn(text) {
  const out = [];
  let at = 0;
  for (const match of text.matchAll(PATH)) {
    if (match.index > at) out.push({ text: text.slice(at, match.index) });
    out.push({ path: match[1], anchor: match[2] ?? null, text: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Links and plain text of a stretch of text outside code. */
function linksIn(text) {
  const out = [];
  let at = 0;
  for (const match of text.matchAll(URL_START)) {
    const raw = trimAddress(match[0]);
    const href = httpsAddress(raw);
    if (!href) continue;
    if (match.index > at) out.push(...pathsIn(text.slice(at, match.index)));
    out.push({ url: href, text: raw });
    at = match.index + raw.length;
  }
  if (at < text.length) out.push(...pathsIn(text.slice(at)));
  return out;
}

/**
 * A line's parts: `{ text }`, `{ code }`, `{ url, text }` (an https address) and
 * `{ path, anchor, text }` (a relative path of the repository). Backticks make code only when they
 * pair up, as in the pull request titles; else the whole line is text with its backticks.
 */
export function inlineParts(line) {
  const pieces = line.split('`');
  const parts =
    pieces.length % 2 === 0
      ? linksIn(line)
      : pieces.flatMap((piece, i) =>
          // An empty pair of backticks is text, as the docs site shows it.
          i % 2 === 1
            ? piece === ''
              ? [{ text: '``' }]
              : [{ code: piece }]
            : linksIn(piece),
        );
  // Adjacent text parts joined, empty ones dropped.
  const joined = [];
  for (const part of parts) {
    const last = joined.at(-1);
    if ('text' in part && Object.keys(part).length === 1) {
      if (part.text === '') continue;
      if (last && 'text' in last && Object.keys(last).length === 1)
        last.text += part.text;
      else joined.push({ text: part.text });
    } else joined.push(part);
  }
  return joined;
}

/**
 * A summary's blocks: `{ paragraph: parts }` and `{ list: parts[] }`. A blank line ends a paragraph
 * or a list; a line starting with `- ` starts a bullet, an indented line after it goes on with
 * that bullet; the lines of a paragraph are joined by a space. Returns [] for an empty summary.
 */
export function parseSummary(text) {
  const blocks = [];
  let lines = null; // the paragraph being read
  let items = null; // the list being read: its bullets' lines
  const close = () => {
    if (lines) blocks.push({ paragraph: inlineParts(lines.join(' ')) });
    // A bullet with no text is left out, and a list of none with it.
    const bullets = (items ?? [])
      .map((item) => item.join(' ').trim())
      .filter((item) => item !== '');
    if (bullets.length > 0) blocks.push({ list: bullets.map(inlineParts) });
    lines = items = null;
  };
  for (const raw of String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line === '') close();
    else if (/^\s*- /.test(raw)) {
      if (!items) close();
      items ??= [];
      items.push([line.slice(2).trim()]);
    } else if (items && /^\s/.test(raw)) items.at(-1).push(line);
    else {
      if (items) close();
      lines ??= [];
      lines.push(line);
    }
  }
  close();
  return blocks;
}

/** The paths a summary links to, for the release step to check that each is in the release. */
export function summaryPaths(blocks) {
  const parts = blocks.flatMap((b) => (b.paragraph ? [b.paragraph] : b.list));
  return [
    ...new Set(
      parts
        .flat()
        .filter((p) => 'path' in p)
        .map((p) => p.path),
    ),
  ];
}

/**
 * Text for Markdown as it reads: what Markdown or HTML would take as markup escaped (HTML, `&`,
 * emphasis, code, links and images), an address GitHub would link by itself (`http://`, `www.`,
 * an email address) broken outside a link's text, and an @-mention's `@` dropped so the notes notify no one. A
 * line's start is the caller's (`markdownLine`).
 */
export function markdownText(text, { inLink = false } = {}) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]~]/g, '\\$&')
    // An `@` before a login-shaped name, unless it is part of a word (an email address).
    .replace(/(^|\W)@(?=[A-Za-z0-9])/g, '$1')
    // `#123` names no issue or pull request.
    .replace(/#(?=\d)/g, '\\#');
  return inLink
    ? escaped
    : escaped
        .replace(/(?<=[A-Za-z]):(?=\/\/)/g, '\\:')
        .replace(/(www)\./gi, '$1\\.')
        .replace(/@/g, '\\@');
}

/** A link in Markdown: its text escaped, brackets in its address percent-encoded. */
const markdownLink = (text, href) =>
  `[${markdownText(text, { inLink: true })}](${href.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))})`;

/** A line of a summary in Markdown, its links built here. */
function markdownLine(parts, { repoUrl, version }) {
  const out = parts
    .map((part) => {
      if ('code' in part) return `\`${part.code}\``;
      if ('url' in part) return markdownLink(part.text, part.url);
      if ('path' in part)
        return markdownLink(
          part.text,
          `${repoUrl}/blob/${version}/${part.path}${part.anchor ?? ''}`,
        );
      return markdownText(part.text);
    })
    .join('');
  // What would start a heading, a list or a setext heading at the start of a line stays text.
  return out.replace(/^(\d+)([.)])/, '$1\\$2').replace(/^[-+=#]/, '\\$&');
}

/** A summary as Markdown, for the GitHub Release and CHANGELOG.md: its text as text. */
export function summaryMarkdown(blocks, where) {
  return blocks
    .map((block) =>
      block.paragraph
        ? markdownLine(block.paragraph, where)
        : block.list.map((item) => `- ${markdownLine(item, where)}`).join('\n'),
    )
    .join('\n\n');
}

/** A summary as plain text, for the docs site's feed. */
export function summaryText(blocks) {
  const line = (parts) =>
    parts.map((p) => ('code' in p ? p.code : p.text)).join('');
  return blocks
    .map((block) =>
      block.paragraph
        ? line(block.paragraph)
        : block.list.map((item) => `- ${line(item)}`).join('\n'),
    )
    .join('\n\n');
}
