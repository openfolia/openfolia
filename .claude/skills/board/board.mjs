#!/usr/bin/env node
// The working board's CLI: the session's only writer of state.json, log.jsonl, timings.json and
// inbox.cursor (see SKILL.md). Every whole-file write is atomic. Run with no arguments for help.
// Over 250 lines because every write the session makes lives here, so each file keeps one writer.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FILES,
  FINDING_KINDS,
  FINDING_OUTCOMES,
  FINDING_SEVERITIES,
  FINDING_SOURCES,
  FRICTION_CATEGORIES,
  STATE_LISTS,
  appendJsonl,
  boardDir,
  normalizeState,
  readJson,
  readJsonl,
  writeAtomic,
  writeJson,
} from './lib.mjs';
import { seedDemo } from './demo.mjs';

const USAGE = `Usage: node .claude/skills/board/board.mjs <command> [...]

Timings (timings.json):
  status <issue> "<status>" [--title "<title>"] [--at <iso>]   a project-board move; "Done" or
                                                               "Merged" records the merge time
  round <issue> <critical> <major> <minor> [--at <iso>]         after each review round
  worked <issue> <minutes> [--lane <id>] [--at <iso>]           an agent's working time (adds up)
  assign <issue> <lane id> [--at <iso>]                         a lane starts an issue
  friction <issue> <category> "<note>" [--minutes <n>]          categories: ${FRICTION_CATEGORIES.join(', ')}
  finding <issue> <severity> <kind> "<summary>" [--source <s>] [--outcome <o>] [--file <path:line>] [--round <n>]
                                                                one review finding; severities:
                                                                ${FINDING_SEVERITIES.join(', ')}; kinds: ${FINDING_KINDS.join(', ')};
                                                                sources: ${FINDING_SOURCES.join(', ')} (default agent-review);
                                                                outcomes: ${FINDING_OUTCOMES.join(', ')} (default fixed)
  findings <issue> -                                            several at once: a JSON array of
                                                                { severity, kind, summary, source?, outcome?, file?, round? } on stdin
  pause "<reason>"                                              every open issue at once
  resume

The page (state.json, log.jsonl):
  set project "<name>"                                          the page's title
  set client "<name>"                                           "Waiting on <name>"
  set <${STATE_LISTS.join('|')}> '<json array>'|-   replace one section (- reads stdin)
  remove <id>                                                   drop an item from any section
  reply <inboxId> "<text>"                                      acknowledge an inbox item
  log "<text>" [--issue <n>] [--at <iso>]                       something done

Groups (state.json's groups: a sprint, or any set of issues):
  sync-group "<name>" --milestone "<title>" [--project "<board>"] [--repo owner/name]
                                                                the milestone's issues, their
                                                                open/closed and board Status (gh)
  remove-group "<name>"

The inbox (inbox.jsonl, inbox.cursor):
  inbox                                                         items after the cursor
  handled <inboxId>                                             move the cursor past an item
  watch                                                         print each new item as it comes (Monitor)

  dir                                                           the board directory (BOARD_DIR)
  demo                                                          example data, into an empty board only`;

/** @param {string} dir */
const files = (dir) => ({
  state: path.join(dir, FILES.state),
  log: path.join(dir, FILES.log),
  timings: path.join(dir, FILES.timings),
  inbox: path.join(dir, FILES.inbox),
  cursor: path.join(dir, FILES.cursor),
});

/** @param {string | undefined} at */
function iso(at) {
  if (at === undefined) return new Date().toISOString();
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`not a date: "${at}"`);
  return new Date(ms).toISOString();
}

/** @param {string} issue */
function issueKey(issue) {
  const key = String(issue).replace(/^#/, '');
  if (!/^\d+$/.test(key))
    throw new Error(`issue must be a number, got "${issue}"`);
  return key;
}

/** @param {string} value @param {string} name */
function count(value, name) {
  if (!/^\d+$/.test(String(value)))
    throw new Error(`${name} must be a whole number, got "${value}"`);
  return Number(value);
}

/** @param {string} dir */
function readTimings(dir) {
  const raw = readJson(files(dir).timings, {});
  return {
    ...raw,
    issues: raw?.issues && typeof raw.issues === 'object' ? raw.issues : {},
  };
}

/**
 * @param {string} dir
 * @param {(timings: any) => void} change
 */
function updateTimings(dir, change) {
  const timings = readTimings(dir);
  change(timings);
  writeJson(files(dir).timings, timings);
  return timings;
}

/** @param {any} timings @param {string} key */
function issueOf(timings, key) {
  timings.issues[key] ??= {
    title: '',
    events: [],
    pauses: [],
    rounds: [],
    friction: [],
  };
  const issue = timings.issues[key];
  for (const list of [
    'events',
    'pauses',
    'rounds',
    'friction',
    'findings',
    'work',
    'assignments',
  ]) {
    issue[list] ??= [];
  }
  return issue;
}

/** @param {string} dir */
function readState(dir) {
  return normalizeState(readJson(files(dir).state, null));
}

/**
 * @param {string} dir
 * @param {(state: any) => void} change
 */
function updateState(dir, change) {
  const state = readState(dir);
  change(state);
  state.updatedAt = new Date().toISOString();
  writeJson(files(dir).state, state);
  return state;
}

// ---------------------------------------------------------------------------------------------
// Commands, exported for the tests.

/**
 * @param {string} dir
 * @param {string} issue
 * @param {string} status
 * @param {{ title?: string, at?: string }} [options]
 */
export function recordStatus(dir, issue, status, options = {}) {
  if (!status?.trim()) throw new Error('status is required');
  const key = issueKey(issue);
  const at = iso(options.at);
  return updateTimings(dir, (timings) => {
    const entry = issueOf(timings, key);
    if (options.title) entry.title = options.title;
    entry.events.push({ at, status: status.trim() });
    if (/^(done|merged)$/i.test(status.trim())) {
      entry.merged = at;
      for (const pause of entry.pauses) if (!pause.to) pause.to = at;
    }
  });
}

/**
 * @param {string} dir
 * @param {string} issue
 * @param {string} critical
 * @param {string} major
 * @param {string} minor
 * @param {{ at?: string }} [options]
 */
export function recordRound(dir, issue, critical, major, minor, options = {}) {
  const key = issueKey(issue);
  const round = {
    at: iso(options.at),
    critical: count(critical, 'critical'),
    major: count(major, 'major'),
    minor: count(minor, 'minor'),
  };
  return updateTimings(dir, (timings) =>
    issueOf(timings, key).rounds.push(round),
  );
}

/**
 * Records that a lane holds an issue from a time (`{ lane, from }`). The span it starts ends at
 * the lane's next assignment, the issue's next one, or the merge (lib.mjs laneTimeline).
 * @param {string} dir
 * @param {string} issue
 * @param {string} lane a lane id, as in state.json's lanes (e.g. lane-a)
 * @param {{ at?: string }} [options]
 */
export function recordAssign(dir, issue, lane, options = {}) {
  const key = issueKey(issue);
  if (typeof lane !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(lane)) {
    throw new Error(`lane must be a lane id like lane-a, got "${lane}"`);
  }
  const entry = { lane, from: iso(options.at) };
  return updateTimings(dir, (timings) => {
    const list = issueOf(timings, key).assignments;
    list.push(entry);
    list.sort((/** @type {any} */ a, /** @type {any} */ b) =>
      a.from.localeCompare(b.from),
    );
  });
}

/**
 * Adds an agent's working time to an issue (one `work` entry; entries add up). Minutes may have
 * a fraction (a `duration_ms` delta), and must be more than 0 and at most a week.
 * @param {string} dir
 * @param {string} issue
 * @param {string} minutes
 * @param {{ lane?: string, at?: string }} [options]
 */
export function recordWork(dir, issue, minutes, options = {}) {
  const key = issueKey(issue);
  const value = Number(minutes);
  if (
    !/^\d+(\.\d+)?$/.test(String(minutes).trim()) ||
    !(value > 0) ||
    value > 7 * 24 * 60
  ) {
    throw new Error(
      `minutes must be a number above 0 (at most a week), got "${minutes}"`,
    );
  }
  /** @type {any} */
  const entry = { at: iso(options.at), minutes: Math.round(value * 100) / 100 };
  if (options.lane?.trim()) entry.lane = options.lane.trim();
  return updateTimings(dir, (timings) =>
    issueOf(timings, key).work.push(entry),
  );
}

/**
 * @param {string} dir
 * @param {string} issue
 * @param {string} category
 * @param {string} note
 * @param {{ minutes?: string, at?: string }} [options]
 */
export function recordFriction(dir, issue, category, note, options = {}) {
  const key = issueKey(issue);
  if (!FRICTION_CATEGORIES.includes(category)) {
    throw new Error(
      `category must be one of ${FRICTION_CATEGORIES.join(', ')}`,
    );
  }
  if (!note?.trim()) throw new Error('a note is required');
  /** @type {any} */
  const entry = { at: iso(options.at), category, note: note.trim() };
  if (options.minutes !== undefined)
    entry.minutes = count(options.minutes, 'minutes');
  return updateTimings(dir, (timings) =>
    issueOf(timings, key).friction.push(entry),
  );
}

/**
 * Checks one review finding and returns it as stored. Throws on an unknown severity, kind, source
 * or outcome, an empty or over-long summary, or a round that isn't a positive whole number.
 * @param {any} input
 * @param {string} [at]
 */
export function checkFinding(input, at) {
  const { severity, kind, summary } = input ?? {};
  const source = input?.source ?? 'agent-review';
  const outcome = input?.outcome ?? 'fixed';
  if (!FINDING_SEVERITIES.includes(severity)) {
    throw new Error(
      `severity must be one of ${FINDING_SEVERITIES.join(', ')}, got "${severity}"`,
    );
  }
  if (!FINDING_KINDS.includes(kind)) {
    throw new Error(
      `kind must be one of ${FINDING_KINDS.join(', ')}, got "${kind}"`,
    );
  }
  if (!FINDING_SOURCES.includes(source)) {
    throw new Error(
      `source must be one of ${FINDING_SOURCES.join(', ')}, got "${source}"`,
    );
  }
  if (!FINDING_OUTCOMES.includes(outcome)) {
    throw new Error(
      `outcome must be one of ${FINDING_OUTCOMES.join(', ')}, got "${outcome}"`,
    );
  }
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 500) {
    throw new Error('a summary of 1–500 characters is required');
  }
  /** @type {any} */
  const entry = {
    at: iso(input?.at ?? at),
    severity,
    kind,
    source,
    outcome,
    summary: summary.trim(),
  };
  if (
    input?.file !== undefined &&
    input.file !== null &&
    String(input.file).trim()
  ) {
    entry.file = String(input.file).trim().slice(0, 200);
  }
  if (input?.round !== undefined && input.round !== null) {
    const round = Number(input.round);
    if (!Number.isInteger(round) || round < 1)
      throw new Error(`round must be 1 or more, got "${input.round}"`);
    entry.round = round;
  }
  return entry;
}

/**
 * @param {string} dir
 * @param {string} issue
 * @param {any[]} findings
 * @param {{ at?: string }} [options]
 */
export function recordFindings(dir, issue, findings, options = {}) {
  const key = issueKey(issue);
  if (!Array.isArray(findings) || !findings.length)
    throw new Error('findings must be a non-empty JSON array');
  const at = iso(options.at);
  const entries = findings.map((f) => checkFinding(f, at));
  return updateTimings(dir, (timings) =>
    issueOf(timings, key).findings.push(...entries),
  );
}

/**
 * Opens a pause on every issue that is started, not merged and not already paused.
 * @param {string} dir
 * @param {string} reason
 * @param {{ at?: string }} [options]
 */
export function pauseAll(dir, reason, options = {}) {
  if (!reason?.trim()) throw new Error('a reason is required');
  const at = iso(options.at);
  return updateTimings(dir, (timings) => {
    for (const issue of Object.values(timings.issues)) {
      const started = (issue.events ?? []).some((/** @type {any} */ e) =>
        /^in[\s_-]*progress$/i.test(String(e?.status).trim()),
      );
      const open = (issue.pauses ?? []).some((/** @type {any} */ p) => !p.to);
      if (started && !issue.merged && !open) {
        issue.pauses ??= [];
        issue.pauses.push({ from: at, to: null, reason: reason.trim() });
      }
    }
  });
}

/**
 * Closes every open pause.
 * @param {string} dir
 * @param {{ at?: string }} [options]
 */
export function resumeAll(dir, options = {}) {
  const at = iso(options.at);
  return updateTimings(dir, (timings) => {
    for (const issue of Object.values(timings.issues)) {
      for (const pause of issue.pauses ?? []) if (!pause.to) pause.to = at;
    }
  });
}

/**
 * Replaces one section of state.json (`project` takes a string, the lists an array of items
 * with a string `id`).
 * @param {string} dir
 * @param {string} section
 * @param {unknown} value
 */
export function setSection(dir, section, value) {
  if (section === 'project' || section === 'client') {
    if (typeof value !== 'string')
      throw new Error(`${section} must be a string`);
  } else if (STATE_LISTS.includes(section)) {
    if (!Array.isArray(value))
      throw new Error(`${section} must be a JSON array`);
    const ids = new Set();
    for (const item of value) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.id !== 'string' ||
        !item.id
      ) {
        throw new Error(`every ${section} item needs a string id`);
      }
      if (ids.has(item.id))
        throw new Error(`duplicate id "${item.id}" in ${section}`);
      ids.add(item.id);
    }
  } else {
    throw new Error(
      `section must be project, client or one of ${STATE_LISTS.join(', ')}`,
    );
  }
  return updateState(dir, (state) => {
    state[section] = value;
  });
}

/**
 * @param {string} dir
 * @param {string} id
 */
export function removeItem(dir, id) {
  let found = false;
  const state = updateState(dir, (s) => {
    for (const list of STATE_LISTS) {
      const kept = s[list].filter((/** @type {any} */ item) => item?.id !== id);
      found ||= kept.length !== s[list].length;
      s[list] = kept;
    }
  });
  if (!found) throw new Error(`no item with id "${id}"`);
  return state;
}

/**
 * Acknowledges an inbox item in state.json's replies (one reply per item; a second replaces it).
 * @param {string} dir
 * @param {string} inboxId
 * @param {string} text
 */
export function replyTo(dir, inboxId, text) {
  if (!text?.trim()) throw new Error('a reply text is required');
  if (!readJsonl(files(dir).inbox).some((item) => item.id === inboxId)) {
    throw new Error(`no inbox item "${inboxId}"`);
  }
  return updateState(dir, (state) => {
    state.replies = state.replies.filter(
      (/** @type {any} */ r) => r?.inboxId !== inboxId,
    );
    state.replies.push({
      inboxId,
      at: new Date().toISOString(),
      text: text.trim(),
    });
  });
}

/**
 * Runs gh and returns its stdout.
 * @param {string[]} args
 * @returns {string}
 */
export function runGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Turns `gh issue list --json number,title,state,projectItems` output into a group's issues:
 * number, title, open/closed and the project-board Status (of the named project, else the first
 * project that has one; null when none).
 * @param {string} json
 * @param {string} [project]
 * @returns {{ number: number, title: string, state: 'open' | 'closed', status: string | null }[]}
 */
export function parseGroupIssues(json, project) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('gh did not return JSON');
  }
  if (!Array.isArray(raw))
    throw new Error('gh did not return a list of issues');
  return raw
    .map((issue) => {
      if (
        !Number.isInteger(issue?.number) ||
        typeof issue?.title !== 'string'
      ) {
        throw new Error('gh returned an issue without a number or title');
      }
      const state = String(issue.state).toLowerCase();
      if (state !== 'open' && state !== 'closed') {
        throw new Error(
          `issue #${issue.number} has an unknown state "${issue.state}"`,
        );
      }
      const items = Array.isArray(issue.projectItems) ? issue.projectItems : [];
      const item = project
        ? items.find((/** @type {any} */ i) => i?.title === project)
        : items.find(
            (/** @type {any} */ i) => typeof i?.status?.name === 'string',
          );
      const status =
        typeof item?.status?.name === 'string' ? item.status.name : null;
      return { number: issue.number, title: issue.title, state, status };
    })
    .sort((a, b) => a.number - b.number);
}

/**
 * Fetches a milestone's issues with gh and stores them as a group in state.json (replacing a
 * group of the same name, keeping the others and their order).
 * @param {string} dir
 * @param {string} name
 * @param {{ milestone?: string, project?: string, repo?: string }} options
 * @param {(args: string[]) => string} [gh]
 */
export function syncGroup(dir, name, options, gh = runGh) {
  if (!name?.trim()) throw new Error('a group name is required');
  if (!options.milestone?.trim()) throw new Error('--milestone is required');
  const args = [
    'issue',
    'list',
    '--milestone',
    options.milestone,
    '--state',
    'all',
    '--json',
    'number,title,state,projectItems',
    '--limit',
    '1000',
  ];
  if (options.repo) args.push('--repo', options.repo);
  const issues = parseGroupIssues(gh(args), options.project);
  const group = {
    name: name.trim(),
    milestone: options.milestone,
    ...(options.project ? { project: options.project } : {}),
    syncedAt: new Date().toISOString(),
    issues,
  };
  return updateState(dir, (state) => {
    const at = state.groups.findIndex(
      (/** @type {any} */ g) => g?.name === group.name,
    );
    if (at >= 0) state.groups[at] = group;
    else state.groups.push(group);
  });
}

/**
 * @param {string} dir
 * @param {string} name
 */
export function removeGroup(dir, name) {
  let found = false;
  const state = updateState(dir, (s) => {
    const kept = s.groups.filter((/** @type {any} */ g) => g?.name !== name);
    found = kept.length !== s.groups.length;
    s.groups = kept;
  });
  if (!found) throw new Error(`no group "${name}"`);
  return state;
}

/**
 * @param {string} dir
 * @param {string} text
 * @param {{ issue?: string, at?: string }} [options]
 */
export function addLog(dir, text, options = {}) {
  if (!text?.trim()) throw new Error('a text is required');
  /** @type {any} */
  const entry = { at: iso(options.at), text: text.trim() };
  if (options.issue !== undefined)
    entry.issue = Number(issueKey(options.issue));
  appendJsonl(files(dir).log, entry);
  return entry;
}

/**
 * The inbox's whole lines as parsed items (a line still being written, or not valid JSON, is
 * skipped) and the byte length they cover, from one read, so a watcher goes on exactly there.
 * @param {string} file
 */
function readInbox(file) {
  if (!existsSync(file)) return { items: [], bytes: 0 };
  const buffer = readFileSync(file);
  const bytes = buffer.lastIndexOf(0x0a) + 1;
  const items = parseLines(buffer.subarray(0, bytes).toString('utf8'));
  return { items, bytes };
}

/** @param {string} text */
function parseLines(text) {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** @param {string} dir @returns {Set<string>} the inbox ids the session has replied to */
function repliedIds(dir) {
  return new Set(
    readState(dir).replies.map((/** @type {any} */ r) => r?.inboxId),
  );
}

/**
 * The inbox items still to handle: after the cursor and without a reply. The page's "waiting for
 * the session" is the same rule (no reply), so the two never disagree.
 * @param {string} dir
 * @param {any[]} [items]
 */
export function unhandled(dir, items = readInbox(files(dir).inbox).items) {
  const cursor = readCursor(dir);
  const at = cursor ? items.findIndex((item) => item.id === cursor) : -1;
  const replied = repliedIds(dir);
  return items.slice(at + 1).filter((item) => !replied.has(item.id));
}

/** @param {string} dir */
function readCursor(dir) {
  const file = files(dir).cursor;
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
}

/**
 * Marks an item handled: it needs a reply first (`reply`). The cursor then moves past every
 * replied item in a row after it, and stops before the first one without a reply, so handling
 * out of order never skips an item or moves the cursor back. Returns the cursor.
 * @param {string} dir
 * @param {string} inboxId
 */
export function markHandled(dir, inboxId) {
  const { items } = readInbox(files(dir).inbox);
  if (!items.some((item) => item.id === inboxId))
    throw new Error(`no inbox item "${inboxId}"`);
  const replied = repliedIds(dir);
  if (!replied.has(inboxId))
    throw new Error(`reply to "${inboxId}" first (board.mjs reply)`);
  const cursor = readCursor(dir);
  let at = cursor ? items.findIndex((item) => item.id === cursor) : -1;
  while (at + 1 < items.length && replied.has(items[at + 1].id)) at++;
  if (at >= 0 && items[at].id !== cursor)
    writeAtomic(files(dir).cursor, `${items[at].id}\n`);
  return at >= 0 ? items[at].id : null;
}

/**
 * Prints the items still to handle, then each new one as it is appended, one JSON line each.
 * Polls once a second; runs until killed.
 * @param {string} dir
 * @param {(line: string) => void} [print]
 */
export function watchInbox(
  dir,
  print = (line) => process.stdout.write(`${line}\n`),
) {
  const file = files(dir).inbox;
  const first = readInbox(file);
  for (const item of unhandled(dir, first.items)) print(JSON.stringify(item));
  let offset = first.bytes;
  let partial = Buffer.alloc(0);
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < offset) {
      offset = 0; // replaced: start over
      partial = Buffer.alloc(0);
    }
    if (size === offset) return;
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;
    // Bytes, not text, until a line is whole: a character split across two reads stays intact.
    const pending = Buffer.concat([partial, buffer]);
    const end = pending.lastIndexOf(0x0a) + 1;
    partial = pending.subarray(end);
    for (const line of pending.subarray(0, end).toString('utf8').split('\n')) {
      if (line.trim()) print(line.trim());
    }
  }, 1000);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------------------------
// CLI.

const OPTIONS = [
  '--source',
  '--outcome',
  '--file',
  '--round',
  '--title',
  '--at',
  '--minutes',
  '--issue',
  '--lane',
  '--milestone',
  '--project',
  '--repo',
];

/**
 * Splits the known `--name value` options from positional arguments (so a text that starts with
 * `--` stays text).
 * @param {string[]} args
 */
function parseArgs(args) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (OPTIONS.includes(arg)) {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = args[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

/** @param {string} raw */
function parseJsonArg(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('the value must be valid JSON');
  }
}

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {string[]} argv
 * @param {string} dir
 */
export async function main(argv, dir) {
  const [command, ...rest] = argv;
  const { positional: p, options } = parseArgs(rest);
  /** @param {number} n */
  const need = (n) => {
    if (p.length < n)
      throw new Error(`${command} needs ${n} argument(s)\n\n${USAGE}`);
  };
  switch (command) {
    case 'status':
      need(2);
      recordStatus(dir, p[0], p[1], options);
      break;
    case 'round':
      need(4);
      recordRound(dir, p[0], p[1], p[2], p[3], options);
      break;
    case 'assign':
      need(2);
      recordAssign(dir, p[0], p[1], options);
      break;
    case 'worked':
      need(2);
      recordWork(dir, p[0], p[1], options);
      break;
    case 'friction':
      need(3);
      recordFriction(dir, p[0], p[1], p[2], options);
      break;
    case 'finding':
      need(4);
      recordFindings(
        dir,
        p[0],
        [
          {
            severity: p[1],
            kind: p[2],
            summary: p[3],
            source: options.source,
            outcome: options.outcome,
            file: options.file,
            round: options.round,
          },
        ],
        options,
      );
      break;
    case 'findings':
      need(2);
      recordFindings(
        dir,
        p[0],
        parseJsonArg(p[1] === '-' ? await readStdin() : p[1]),
        options,
      );
      break;
    case 'pause':
      need(1);
      pauseAll(dir, p[0], options);
      break;
    case 'resume':
      resumeAll(dir, options);
      break;
    case 'set':
      need(2);
      {
        const raw = p[1] === '-' ? await readStdin() : p[1];
        setSection(
          dir,
          p[0],
          ['project', 'client'].includes(p[0]) ? raw.trim() : parseJsonArg(raw),
        );
      }
      break;
    case 'remove':
      need(1);
      removeItem(dir, p[0]);
      break;
    case 'sync-group': {
      need(1);
      const state = syncGroup(dir, p[0], options);
      const group = state.groups.find(
        (/** @type {any} */ g) => g.name === p[0].trim(),
      );
      process.stdout.write(`${group.name}: ${group.issues.length} issues\n`);
      break;
    }
    case 'remove-group':
      need(1);
      removeGroup(dir, p[0]);
      break;
    case 'reply':
      need(2);
      replyTo(dir, p[0], p[1]);
      break;
    case 'log':
      need(1);
      addLog(dir, p[0], options);
      break;
    case 'inbox':
      for (const item of unhandled(dir))
        process.stdout.write(`${JSON.stringify(item)}\n`);
      break;
    case 'handled':
      need(1);
      markHandled(dir, p[0]);
      break;
    case 'watch':
      watchInbox(dir);
      return;
    case 'dir':
      process.stdout.write(`${dir}\n`);
      break;
    case 'demo':
      seedDemo(dir);
      process.stdout.write(`Example data written to ${dir}\n`);
      break;
    default:
      process.stdout.write(`${USAGE}\n`);
      if (command && command !== 'help' && command !== '--help')
        process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2), boardDir(process.env, process.cwd())).catch(
    (error) => {
      process.stderr.write(
        `board: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
