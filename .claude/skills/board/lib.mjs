// The working board's pure logic and its file helpers: the inbox checks, the Host/Origin checks,
// the derived durations (wall time minus pauses) and the friction summary. The server
// (server.mjs) and the CLI (board.mjs) both use it; the tests import it
// (tests/__tests__/working-board.test.ts). Node's standard library only. Over 250 lines because it
// is all of the board's checked logic in one place, each part small and tested on its own.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const INBOX_KINDS = ['answer', 'done', 'request'];
export const MAX_TEXT = 4000;
export const DEFAULT_PORT = 4777;
export const LOG_DAYS = 14;

/** The fixed list, so friction can be counted; a note adds the detail. */
export const FRICTION_CATEGORIES = [
  'review-finding',
  'merge-conflict',
  'migration-renumber',
  'flaky-test',
  'tooling',
  'spec-gap',
  'dependency',
  'limit',
  'other',
];

/** Review findings (`board.mjs finding`): fixed lists, so they can be counted per kind. */
export const FINDING_SEVERITIES = ['critical', 'major', 'minor'];
export const FINDING_KINDS = [
  'concurrency',
  'authorization',
  'security',
  'money',
  'data-integrity',
  'validation',
  'error-handling',
  'migration',
  'performance',
  'i18n',
  'ui-convention',
  'test-gap',
  'spec-mismatch',
  'duplication',
  'other',
];
/** Who found it: the agent's own review rounds, the coordinator's review, the security hook. */
export const FINDING_SOURCES = [
  'agent-review',
  'coordinator-review',
  'security-review',
];
/** What became of it. */
export const FINDING_OUTCOMES = ['fixed', 'declined', 'deferred', 'open'];

/** The state.json sections the session may replace one at a time. */
export const STATE_LISTS = [
  'needsYou',
  'questions',
  'waitingOnClient',
  'lanes',
];

export const FILES = {
  state: 'state.json',
  log: 'log.jsonl',
  timings: 'timings.json',
  inbox: 'inbox.jsonl',
  cursor: 'inbox.cursor',
};

/**
 * The board's directory: BOARD_DIR, else `<git toplevel>/.claude/board`, else `<cwd>/.claude/board`.
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @returns {string}
 */
export function boardDir(env, cwd) {
  const fromEnv = env.BOARD_DIR?.trim();
  if (fromEnv) return path.resolve(cwd, fromEnv);
  let top = cwd;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git checkout: the board lives under the working directory.
  }
  return path.join(top, '.claude', 'board');
}

/**
 * BOARD_PORT, else 4777. Anything that isn't a whole port number is refused.
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function boardPort(env) {
  const raw = env.BOARD_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error(`BOARD_PORT must be a port number (1-65535), got "${raw}"`);
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------------------------
// Files: atomic whole-file writes, tolerant reads.

/**
 * Writes a whole file atomically: a temp file beside it, then a rename.
 * @param {string} file
 * @param {string} content
 */
export function writeAtomic(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export function writeJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Appends one JSON line (a single small write, so a reader never sees half of it).
 * @param {string} file
 * @param {unknown} value
 */
export function appendJsonl(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return null;
    throw error;
  }
}

/**
 * A JSON file's value, or `fallback` when it is missing or not valid JSON.
 * @param {string} file
 * @param {any} fallback
 * @returns {any}
 */
export function readJson(file, fallback) {
  const text = readText(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Every whole, valid line of a JSONL file (a line still being written is skipped).
 * @param {string} file
 * @returns {any[]}
 */
export function readJsonl(file) {
  const text = readText(file);
  if (!text) return [];
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop();
  return lines.flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** @returns {any} */
export function emptyState() {
  return {
    updatedAt: null,
    project: '',
    client: '',
    needsYou: [],
    questions: [],
    waitingOnClient: [],
    lanes: [],
    replies: [],
    groups: [],
  };
}

/**
 * state.json with every section present, whatever the file holds.
 * @param {any} raw
 * @returns {any}
 */
export function normalizeState(raw) {
  const state = {
    ...emptyState(),
    ...(raw && typeof raw === 'object' ? raw : {}),
  };
  for (const key of [...STATE_LISTS, 'replies', 'groups']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  return state;
}

/** @returns {string} A new inbox id: sortable by time, then random. */
export function newInboxId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------------------------
// Request checks.

/**
 * The page's own origins. Anything else (a website in another tab) is refused on POST.
 * @param {number} port
 * @returns {string[]}
 */
function ownHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/**
 * DNS rebinding: only `127.0.0.1:<port>` or `localhost:<port>` may be the Host.
 * @param {string | undefined} host
 * @param {number} port
 * @returns {boolean}
 */
export function hostAllowed(host, port) {
  return (
    typeof host === 'string' && ownHosts(port).includes(host.toLowerCase())
  );
}

/**
 * A POST must come from the page itself: Origin `http://127.0.0.1:<port>` or
 * `http://localhost:<port>`. A missing Origin is refused too (browsers send it on every POST).
 * @param {string | undefined} origin
 * @param {number} port
 * @returns {boolean}
 */
export function originAllowed(origin, port) {
  return (
    typeof origin === 'string' &&
    ownHosts(port)
      .map((host) => `http://${host}`)
      .includes(origin.toLowerCase())
  );
}

/**
 * Checks what the page posts to /api/inbox against state.json. `answer` refers to a question,
 * `done` to a needs-you item; `answer` and `request` need 1–4000 characters of text.
 * @param {unknown} body
 * @param {any} state
 * @returns {{ ok: true, item: { kind: string, ref?: string, text: string } } | { ok: false, error: string }}
 */
export function checkInbox(body, state) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const { kind, ref, text } = /** @type {Record<string, unknown>} */ (body);
  if (typeof kind !== 'string' || !INBOX_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `kind must be one of ${INBOX_KINDS.join(', ')}`,
    };
  }
  if (text !== undefined && typeof text !== 'string') {
    return { ok: false, error: 'text must be a string' };
  }
  const cleanText = typeof text === 'string' ? text.trim() : '';
  if (cleanText.length > MAX_TEXT) {
    return { ok: false, error: `text is longer than ${MAX_TEXT} characters` };
  }
  if ((kind === 'answer' || kind === 'request') && cleanText.length === 0) {
    return { ok: false, error: 'text is required' };
  }
  if (kind === 'request') {
    if (ref !== undefined) return { ok: false, error: 'a request has no ref' };
    return { ok: true, item: { kind, text: cleanText } };
  }
  const list = kind === 'answer' ? state.questions : state.needsYou;
  if (
    typeof ref !== 'string' ||
    !list.some((/** @type {any} */ item) => item?.id === ref)
  ) {
    return {
      ok: false,
      error: `ref must be the id of an item in ${kind === 'answer' ? 'questions' : 'needsYou'}`,
    };
  }
  return { ok: true, item: { kind, ref, text: cleanText } };
}

// ---------------------------------------------------------------------------------------------
// Inbox and log views.

/**
 * The inbox split into items still waiting for the session and the latest answered ones (with
 * the session's reply).
 * @param {any[]} inbox
 * @param {any} state
 * @param {number} [answeredLimit]
 */
export function inboxView(inbox, state, answeredLimit = 10) {
  const replies = new Map();
  for (const reply of state.replies) replies.set(reply?.inboxId, reply);
  const pending = inbox.filter((item) => !replies.has(item.id));
  const answered = inbox
    .filter((item) => replies.has(item.id))
    .slice(-answeredLimit)
    .reverse()
    .map((item) => ({ ...item, reply: replies.get(item.id) }));
  return { pending, answered };
}

/**
 * The log of the last `days` days, newest first.
 * @param {any[]} log
 * @param {number} now
 * @param {number} [days]
 */
export function recentLog(log, now, days = LOG_DAYS) {
  const since = now - days * 86_400_000;
  return log
    .filter(
      (entry) => typeof entry?.at === 'string' && Date.parse(entry.at) >= since,
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// ---------------------------------------------------------------------------------------------
// Timings.

/** @param {string} status */
const norm = (status) =>
  status
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');

/**
 * The first time an issue reached a status (compared without case, spaces or dashes).
 * @param {any} issue
 * @param {string[]} names
 * @returns {string | null}
 */
function firstEvent(issue, names) {
  const wanted = names.map(norm);
  const hit = (issue.events ?? []).find(
    (/** @type {any} */ e) =>
      typeof e?.status === 'string' && wanted.includes(norm(e.status)),
  );
  return hit?.at ?? null;
}

/**
 * Milliseconds of [from, to] covered by the pauses (overlapping pauses count once; an open pause
 * runs until `to`).
 * @param {{ from: string, to?: string | null }[]} pauses
 * @param {number} from
 * @param {number} to
 */
export function pausedMs(pauses, from, to) {
  const spans = pauses
    .map((p) => [
      Math.max(Date.parse(p.from), from),
      Math.min(p.to ? Date.parse(p.to) : to, to),
    ])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    const start = Math.max(a, end);
    if (b > start) total += b - start;
    end = Math.max(end, b);
  }
  return total;
}

/**
 * An issue's derived times. Wall time runs from the first `In progress` to the merge (or now);
 * active time is wall time minus the pauses.
 * @param {any} issue
 * @param {number} now
 */
export function deriveIssue(issue, now) {
  const started = firstEvent(issue, ['in progress']);
  const pr = firstEvent(issue, ['in review', 'pr open', 'pr']);
  const merged = issue.merged ?? null;
  const rounds = issue.rounds ?? [];
  let wallMs = null;
  let activeMs = null;
  if (started) {
    const from = Date.parse(started);
    const to = merged ? Date.parse(merged) : now;
    wallMs = Math.max(0, to - from);
    activeMs = Math.max(0, wallMs - pausedMs(issue.pauses ?? [], from, to));
  }
  return {
    started,
    pr,
    merged,
    wallMs,
    activeMs,
    paused: (issue.pauses ?? []).some((/** @type {any} */ p) => !p.to),
    rounds: rounds.length,
    critical: rounds.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + (r.critical || 0),
      0,
    ),
    major: rounds.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + (r.major || 0),
      0,
    ),
    minor: rounds.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + (r.minor || 0),
      0,
    ),
    friction: (issue.friction ?? []).length,
    findings: (issue.findings ?? []).length,
    /** Each round's worst finding, oldest first: how the reviews converged. */
    roundMarks: rounds.map((/** @type {any} */ r) =>
      r.critical ? 'critical' : r.major ? 'major' : 'clean',
    ),
    ...workedOf(issue),
  };
}

/**
 * An agent's working time on an issue: the sum of its `work` entries (`board.mjs worked`). Null
 * when none is recorded, so "not recorded" never reads as zero.
 * @param {any} issue
 * @returns {{ workedMs: number | null, workEntries: number }}
 */
export function workedOf(issue) {
  const work = (Array.isArray(issue?.work) ? issue.work : []).filter(
    (/** @type {any} */ w) => Number.isFinite(w?.minutes) && w.minutes > 0,
  );
  if (!work.length) return { workedMs: null, workEntries: 0 };
  const minutes = work.reduce(
    (/** @type {number} */ n, /** @type {any} */ w) => n + w.minutes,
    0,
  );
  return { workedMs: Math.round(minutes * 60_000), workEntries: work.length };
}

/**
 * Per friction category: how many issues it touched, those issues' review rounds, the time noted
 * against it (each note's `minutes`) and how many notes. Most expensive first: time, then rounds,
 * then issues, then notes; ties by category name.
 * @param {Record<string, any>} issues
 */
export function frictionSummary(issues) {
  /** @type {Map<string, { category: string, issues: Set<string>, rounds: number, minutes: number, notes: number }>} */
  const rows = new Map();
  for (const [key, issue] of Object.entries(issues)) {
    const roundCount = (issue.rounds ?? []).length;
    for (const entry of issue.friction ?? []) {
      const category = entry?.category;
      if (typeof category !== 'string') continue;
      let row = rows.get(category);
      if (!row) {
        row = { category, issues: new Set(), rounds: 0, minutes: 0, notes: 0 };
        rows.set(category, row);
      }
      if (!row.issues.has(key)) {
        row.issues.add(key);
        row.rounds += roundCount;
      }
      row.minutes += Number.isFinite(entry.minutes) ? entry.minutes : 0;
      row.notes += 1;
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, issues: row.issues.size }))
    .sort(
      (a, b) =>
        b.minutes - a.minutes ||
        b.rounds - a.rounds ||
        b.issues - a.issues ||
        b.notes - a.notes ||
        a.category.localeCompare(b.category),
    );
}

/**
 * Per finding kind: counts by severity, outcome and source, and how many issues it touched; most
 * serious first (critical, then major, then minor, then issues; ties by kind). Plus every finding,
 * newest first, with its issue's number and title, for the list under the summary.
 * @param {Record<string, any>} issues
 */
export function findingsSummary(issues) {
  /** @type {Map<string, any>} */
  const kinds = new Map();
  /** @type {any[]} */
  const list = [];
  for (const [key, issue] of Object.entries(issues)) {
    for (const f of issue.findings ?? []) {
      if (
        !f ||
        typeof f.kind !== 'string' ||
        !FINDING_SEVERITIES.includes(f.severity)
      )
        continue;
      let row = kinds.get(f.kind);
      if (!row) {
        row = {
          kind: f.kind,
          critical: 0,
          major: 0,
          minor: 0,
          issues: new Set(),
          outcomes: {},
          sources: {},
        };
        kinds.set(f.kind, row);
      }
      row[f.severity] += 1;
      row.issues.add(key);
      const outcome = f.outcome ?? 'open';
      row.outcomes[outcome] = (row.outcomes[outcome] ?? 0) + 1;
      const source = f.source ?? 'agent-review';
      row.sources[source] = (row.sources[source] ?? 0) + 1;
      list.push({
        issue: key,
        title: issue.title ?? '',
        ...f,
        outcome,
        source,
      });
    }
  }
  const rows = [...kinds.values()]
    .map((row) => ({ ...row, issues: row.issues.size }))
    .sort(
      (a, b) =>
        b.critical - a.critical ||
        b.major - a.major ||
        b.minor - a.minor ||
        b.issues - a.issues ||
        a.kind.localeCompare(b.kind),
    );
  list.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { kinds: rows, list };
}

/**
 * timings.json with every issue's derived times, newest start first, and the friction summary.
 * @param {any} timings
 * @param {number} now
 */
export function timingsView(timings, now) {
  const issues =
    timings?.issues && typeof timings.issues === 'object' ? timings.issues : {};
  const rows = Object.entries(issues)
    .map(([key, issue]) => ({
      issue: key,
      title: issue.title ?? '',
      ...deriveIssue(issue, now),
    }))
    .sort(
      (a, b) =>
        (b.started ?? '').localeCompare(a.started ?? '') ||
        Number(b.issue) - Number(a.issue),
    );
  return {
    issues: rows,
    friction: frictionSummary(issues),
    findings: findingsSummary(issues),
    pauses: boardPauses(issues),
  };
}

/**
 * The pauses across all issues, once each (`pause` opens the same one on every open issue),
 * oldest first. A pause still open on any issue is open (`to: null`).
 * @param {Record<string, any>} issues
 * @returns {{ from: string, to: string | null, reason: string }[]}
 */
export function boardPauses(issues) {
  /** @type {Map<string, { from: string, to: string | null, reason: string }>} */
  const seen = new Map();
  for (const issue of Object.values(issues)) {
    for (const pause of issue.pauses ?? []) {
      if (typeof pause?.from !== 'string') continue;
      const key = `${pause.from}|${pause.reason ?? ''}`;
      const to = pause.to ?? null;
      const known = seen.get(key);
      if (!known)
        seen.set(key, { from: pause.from, to, reason: pause.reason ?? '' });
      else if (known.to !== null && (to === null || to > known.to))
        known.to = to;
    }
  }
  return [...seen.values()].sort((a, b) => a.from.localeCompare(b.from));
}

// ---------------------------------------------------------------------------------------------
// Lanes and groups (a sprint, or any set of issues: `board.mjs sync-group`).

export const LANE_PHASES = ['idle', 'building', 'review', 'merging', 'waiting'];

/**
 * A lane's phase: its own `phase` when it is one of LANE_PHASES, else read from its status text.
 * @param {any} lane
 * @returns {string}
 */
export function lanePhase(lane) {
  const own = typeof lane?.phase === 'string' ? lane.phase.toLowerCase() : '';
  if (LANE_PHASES.includes(own)) return own;
  const status = `${lane?.status ?? ''}`.toLowerCase();
  if (!lane?.issue && !lane?.title) return 'idle';
  if (/\bidle\b/.test(status)) return 'idle';
  if (/merg/.test(status)) return 'merging';
  if (/review|round/.test(status)) return 'review';
  if (/wait|blocked|paused/.test(status)) return 'waiting';
  return 'building';
}

/** A lane's short label: "Lane A" → "A". @param {any} lane */
export function laneLetter(lane) {
  return String(lane?.name || lane?.id || '')
    .replace(/^lane\s+/i, '')
    .slice(0, 2);
}

/** The buckets of a group's progress bar, done first. */
export const GROUP_BUCKETS = ['done', 'review', 'progress', 'ready', 'backlog'];

/**
 * An issue's bucket: a closed issue is done whatever its board status; an open one goes by its
 * project-board Status, and one without a known Status counts as backlog.
 * @param {{ state: string, status?: string | null }} issue
 * @returns {string}
 */
export function issueBucket(issue) {
  if (issue.state === 'closed') return 'done';
  const status = typeof issue.status === 'string' ? norm(issue.status) : '';
  if (status === 'done') return 'done';
  if (status === 'in review') return 'review';
  if (status === 'in progress') return 'progress';
  if (status === 'ready') return 'ready';
  return 'backlog';
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const PACE_MIN_DONE = 3;
export const WORKING_DAY_HOURS = 8;

/**
 * A rough pace: the median time of the group's done issues, times the open issues, divided by
 * the busy lanes, in working days of 8 hours. The time is agent working time (`worked`) when at
 * least 3 done issues have it, else active time (wall time minus pauses) when at least 3 have
 * that; null otherwise, or with no open issue or no busy lane. `basis` says which was used.
 * @param {{ worked: number[], active: number[] }} doneMs
 * @param {number} open
 * @param {number} busyLanes
 */
export function groupPace(doneMs, open, busyLanes) {
  const basis =
    doneMs.worked.length >= PACE_MIN_DONE
      ? 'worked'
      : doneMs.active.length >= PACE_MIN_DONE
        ? 'active'
        : null;
  if (!basis || open === 0 || busyLanes === 0) return null;
  const values = doneMs[basis];
  const medianMs = median(values);
  const hours = (medianMs * open) / busyLanes / 3_600_000;
  return {
    basis,
    medianMs,
    sample: values.length,
    workedSample: doneMs.worked.length,
    open,
    busyLanes,
    hours,
    days: hours / WORKING_DAY_HOURS,
  };
}

/**
 * A group as the page shows it: counts per bucket, the issues per bucket (with the letter of
 * the lane working on each, from the lanes), and the pace.
 * @param {any} group
 * @param {any[]} lanes
 * @param {Record<string, any>} timingIssues timings.json's issues
 * @param {number} now
 */
export function groupView(group, lanes, timingIssues, now) {
  const laneOf = new Map();
  for (const lane of lanes) {
    if (
      lane?.issue !== undefined &&
      lane?.issue !== null &&
      lane.issue !== ''
    ) {
      laneOf.set(String(lane.issue).replace(/^#/, ''), laneLetter(lane));
    }
  }
  /** @type {Record<string, any[]>} */
  const buckets = Object.fromEntries(GROUP_BUCKETS.map((b) => [b, []]));
  for (const issue of Array.isArray(group?.issues) ? group.issues : []) {
    const bucket = issueBucket(issue);
    buckets[bucket].push({
      ...issue,
      bucket,
      lane: laneOf.get(String(issue.number)) ?? null,
    });
  }
  for (const list of Object.values(buckets))
    list.sort((a, b) => a.number - b.number);
  const counts = Object.fromEntries(
    GROUP_BUCKETS.map((b) => [b, buckets[b].length]),
  );
  const total = GROUP_BUCKETS.reduce((n, b) => n + counts[b], 0);
  /** @type {{ worked: number[], active: number[] }} */
  const doneMs = { worked: [], active: [] };
  for (const issue of buckets.done) {
    const timing = timingIssues[String(issue.number)];
    if (!timing) continue;
    const derived = deriveIssue(timing, now);
    if (derived.workedMs !== null) doneMs.worked.push(derived.workedMs);
    if (derived.merged && derived.activeMs !== null)
      doneMs.active.push(derived.activeMs);
  }
  const busy = lanes.filter((lane) => lanePhase(lane) !== 'idle').length;
  return {
    name: group?.name ?? '',
    milestone: group?.milestone ?? null,
    syncedAt: group?.syncedAt ?? null,
    total,
    left: total - counts.done,
    counts,
    buckets,
    pace: groupPace(doneMs, total - counts.done, busy),
  };
}

// ---------------------------------------------------------------------------------------------
// Lanes over time: which lane held which issue when (`board.mjs assign`).

/**
 * The phase an issue was in at a time, from its status events: review from an "In review" until
 * a later move back, else building.
 * @param {{ at: string, status: string }[]} events sorted by time
 * @param {number} t
 */
function phaseAt(events, t) {
  let phase = 'building';
  for (const e of events) {
    if (Date.parse(e.at) > t) break;
    const status = norm(String(e.status));
    if (status === 'in review') phase = 'review';
    else if (status === 'in progress') phase = 'building';
  }
  return phase;
}

/**
 * Each lane's spans over time. An assignment runs from its `from` until the first of: the lane's
 * next assignment, the issue's next assignment (to any lane), the issue's merge, or now. Within
 * a span, the issue's status events split it into building and review; its work entries for that
 * lane (or without a lane) mark where an agent ran (`[at − minutes, at]`); the merge is a dot.
 * Between spans, from the first assignment on the board until now, a lane is idle.
 * @param {Record<string, any>} issues timings.json's issues
 * @param {any[]} lanes state.json's lanes (their order and names)
 * @param {number} now
 */
export function laneTimeline(issues, lanes, now) {
  /** @type {{ issue: string, lane: string, from: number }[]} */
  const all = [];
  for (const [key, issue] of Object.entries(issues)) {
    for (const a of issue.assignments ?? []) {
      const from = Date.parse(a?.from);
      if (typeof a?.lane === 'string' && Number.isFinite(from) && from <= now) {
        all.push({ issue: key, lane: a.lane, from });
      }
    }
  }
  all.sort((a, b) => a.from - b.from);
  const start = all.length ? all[0].from : now;

  const laneIds = [
    ...lanes.map((l) => String(l?.id ?? '')).filter(Boolean),
    ...[...new Set(all.map((a) => a.lane))].sort(),
  ].filter((id, i, list) => list.indexOf(id) === i);
  const byId = new Map(lanes.map((l) => [String(l?.id ?? ''), l]));

  const rows = laneIds.map((laneId) => {
    const spans = all
      .filter((a) => a.lane === laneId)
      .map((a) => {
        const issue = issues[a.issue];
        const merged = issue.merged ? Date.parse(issue.merged) : NaN;
        const ends = [
          now,
          ...all
            .filter(
              (b) =>
                b.from > a.from && (b.lane === laneId || b.issue === a.issue),
            )
            .map((b) => b.from),
        ];
        if (Number.isFinite(merged) && merged > a.from) ends.push(merged);
        const to = Math.min(...ends);
        const events = (issue.events ?? [])
          .filter((/** @type {any} */ e) => Number.isFinite(Date.parse(e?.at)))
          .sort(
            (/** @type {any} */ x, /** @type {any} */ y) =>
              Date.parse(x.at) - Date.parse(y.at),
          );
        /** @type {{ phase: string, from: number, to: number }[]} */
        const segments = [];
        const cuts = [
          a.from,
          ...events
            .map((/** @type {any} */ e) => Date.parse(e.at))
            .filter((t) => t > a.from && t < to),
          to,
        ];
        for (let i = 0; i < cuts.length - 1; i++) {
          if (cuts[i + 1] <= cuts[i]) continue;
          const phase = phaseAt(events, cuts[i]);
          const last = segments[segments.length - 1];
          if (last && last.phase === phase) last.to = cuts[i + 1];
          else segments.push({ phase, from: cuts[i], to: cuts[i + 1] });
        }
        const worked = (issue.work ?? [])
          .filter(
            (/** @type {any} */ w) =>
              Number.isFinite(w?.minutes) &&
              w.minutes > 0 &&
              (!w.lane || w.lane === laneId),
          )
          .map((/** @type {any} */ w) => {
            const end = Date.parse(w.at);
            return {
              from: Math.max(end - w.minutes * 60_000, a.from),
              to: Math.min(end, to),
            };
          })
          .filter(
            (/** @type {{ from: number, to: number }} */ w) => w.to > w.from,
          );
        const derived = deriveIssue(issue, now);
        return {
          issue: a.issue,
          title: issue.title ?? '',
          from: a.from,
          to,
          open: to === now,
          merged:
            Number.isFinite(merged) && merged > a.from && merged <= to
              ? merged
              : null,
          segments,
          worked,
          hasWork: derived.workedMs !== null,
          workedMs: derived.workedMs,
          rounds: derived.rounds,
          critical: derived.critical,
          major: derived.major,
        };
      });
    /** @type {{ from: number, to: number }[]} */
    const idle = [];
    let cursor = start;
    for (const span of [...spans].sort((x, y) => x.from - y.from)) {
      if (span.from > cursor) idle.push({ from: cursor, to: span.from });
      cursor = Math.max(cursor, span.to);
    }
    if (now > cursor) idle.push({ from: cursor, to: now });
    const lane = byId.get(laneId);
    return {
      lane: laneId,
      letter: laneLetter(
        lane ?? { id: laneId.replace(/^lane-/i, '').toUpperCase() },
      ),
      name: lane?.name ?? laneId,
      spans,
      idle,
    };
  });
  return { start, end: now, rows };
}
