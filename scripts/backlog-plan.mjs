// What `pnpm backlog:create` decides, as plain functions a test can pin: the key markers,
// the bodies, and what is missing on GitHub (milestones, issues, labels, sub-issue and blocked-by
// links, empty board fields). It never plans an edit of what a person may have touched: an
// existing item that differs is reported, not rewritten, so a later pass is safe to re-run.
// scripts/backlog-github.mjs reads GitHub and applies it.

/** @typedef {{ key: string, title: string, description?: string }} MilestoneEntry */
/**
 * @typedef {{ key: string, title: string, body?: string, milestone?: string, labels?: string[],
 *   parent?: string, waitsFor?: string[], fields?: Record<string, string | number> }} IssueEntry
 */
/**
 * @typedef {{ milestones?: MilestoneEntry[], labels?: { name: string, color?: string,
 *   description?: string }[], issues: IssueEntry[] }} Backlog
 */
/** @typedef {{ number: number, title: string, description?: string | null }} GitHubMilestone */
/** @typedef {{ number: number, title: string, body: string, milestone: number | null }} GitHubIssue */
/**
 * @typedef {{ number: number | null, open: boolean, parent: number | null,
 *   blockedBy: number[] }} IssueState
 */

const MARKER = /^<!-- backlog:key (\S+) -->$/;

/** The marker line that names an item's key; every body and description written ends with it. */
export const marker = (/** @type {string} */ key) =>
  `<!-- backlog:key ${key} -->`;

/**
 * An item's key: the last line that is exactly a marker, outside fenced code blocks.
 * @param {string | null | undefined} text
 */
export function keyOf(text) {
  let key = null;
  let fenced = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) key = line.match(MARKER)?.[1] ?? key;
  }
  return key;
}

/**
 * An issue's body: the Model and Waits-for lines, the file's body, the marker.
 * @param {IssueEntry} issue
 * @param {(key: string) => number | null} numberOf
 */
export function renderIssueBody(issue, numberOf) {
  const head = [];
  if (issue.fields?.Model) head.push(`**Model:** ${issue.fields.Model}`);
  if (issue.waitsFor?.length) {
    const refs = issue.waitsFor.map((key) => `#${numberOf(key) ?? `<${key}>`}`);
    head.push(`**Waits for:** ${refs.join(', ')}`);
  }
  const parts = [
    head.join('\n'),
    String(issue.body ?? '').trim(),
    marker(issue.key),
  ];
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

/** A milestone's description, ending with its marker. @param {MilestoneEntry} milestone */
export function renderMilestoneDescription(milestone) {
  return [String(milestone.description ?? '').trim(), marker(milestone.key)]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * "Sprint 2 · Invoices" → "Sprint 2 · ": an unmarked milestone with that start is the same one.
 * A title without " · " has no start (only an exact title matches).
 */
const titleStart = (/** @type {string} */ title) => {
  const at = title.indexOf(' · ');
  return at < 0 ? null : title.slice(0, at + 3);
};

/**
 * For each milestone of the file: `create`, `adopt` (add the marker) or `exists`.
 * @template {GitHubMilestone} M
 * @param {MilestoneEntry[]} milestones
 * @param {M[]} existing
 * @returns {{ plan: { key: string, action: string, existing?: M }[], problems: string[] }}
 */
export function planMilestones(milestones, existing) {
  const problems = [];
  /** @type {Map<M, string>} which file milestone adopted an unmarked one */
  const adopted = new Map();
  const plan = milestones.map((m) => {
    const marked = existing.filter((e) => keyOf(e.description) === m.key);
    if (marked.length > 1)
      problems.push(`two milestones carry the key ${m.key}`);
    if (marked.length)
      return { key: m.key, action: 'exists', existing: marked[0] };
    const start = titleStart(m.title);
    const same = existing.filter(
      (e) =>
        !keyOf(e.description) &&
        (e.title === m.title || (start !== null && e.title.startsWith(start))),
    );
    if (same.length > 1)
      problems.push(`several unmarked milestones could be ${m.key}: ask`);
    if (same.length) {
      const taken = adopted.get(same[0]);
      if (taken)
        problems.push(
          `${taken} and ${m.key} would both adopt "${same[0].title}": ask`,
        );
      adopted.set(same[0], m.key);
      return { key: m.key, action: 'adopt', existing: same[0] };
    }
    return { key: m.key, action: 'create' };
  });
  return { plan, problems };
}

/**
 * For each issue of the file: `create` or `exists` (with the GitHub issue), plus `problems`
 * that stop the run (one key on two issues) and `notes` for the report (differences, unmarked
 * look-alikes, keys the file no longer names).
 * @template {GitHubIssue} I
 * @param {IssueEntry[]} issues
 * @param {I[]} existing
 * @param {(key: string) => number | null} milestoneNumberOf
 * @returns {{ plan: { key: string, action: string, existing?: I }[], problems: string[],
 *   notes: string[] }}
 */
export function planIssues(issues, existing, milestoneNumberOf) {
  const problems = [];
  const notes = [];
  const byKey = new Map();
  for (const e of existing) {
    const key = keyOf(e.body);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  const plan = issues.map((issue) => {
    const found = byKey.get(issue.key) ?? [];
    if (found.length > 1) {
      problems.push(
        `${found.map((e) => `#${e.number}`).join(' and ')} both carry the key ${issue.key}: which one stays?`,
      );
    }
    if (!found.length) {
      const alike = existing.find(
        (e) => !keyOf(e.body) && e.title === issue.title,
      );
      if (alike)
        notes.push(
          `#${alike.number} "${alike.title}" has no key marker: not adopted`,
        );
      return { key: issue.key, action: 'create' };
    }
    const e = found[0];
    if (e.title !== issue.title)
      notes.push(
        `#${e.number} (${issue.key}): titled "${e.title}", the file says "${issue.title}"`,
      );
    const milestone =
      issue.milestone == null ? null : milestoneNumberOf(issue.milestone);
    if (milestone != null && e.milestone !== milestone) {
      notes.push(
        `#${e.number} (${issue.key}): in another milestone than ${issue.milestone}`,
      );
    }
    return { key: issue.key, action: 'exists', existing: e };
  });
  const keys = new Set(issues.map((issue) => issue.key));
  for (const [key, found] of byKey) {
    if (!keys.has(key))
      notes.push(
        `#${found[0].number} carries the key ${key}, which the file no longer names`,
      );
  }
  return { plan, problems, notes };
}

/**
 * Labels the file's issues use that the repository lacks, with their colour and description.
 * @param {{ labels?: Backlog['labels'], issues?: { labels?: string[] }[] }} backlog
 * @param {string[]} existingNames
 */
export function missingLabels(backlog, existingNames) {
  const have = new Set(existingNames.map((name) => name.toLowerCase()));
  const defined = new Map(
    (backlog.labels ?? []).map((label) => [label.name.toLowerCase(), label]),
  );
  // GitHub's label names ignore case: one label per name, its first spelling in the file.
  const used = new Map();
  for (const name of (backlog.issues ?? []).flatMap(
    (issue) => issue.labels ?? [],
  )) {
    if (!used.has(name.toLowerCase())) used.set(name.toLowerCase(), name);
  }
  return [...used.values()]
    .filter((name) => !have.has(name.toLowerCase()))
    .map((name) => ({
      color: 'ededed',
      description: '',
      ...defined.get(name.toLowerCase()),
      name: defined.get(name.toLowerCase())?.name ?? name,
    }));
}

/**
 * Sub-issue and blocked-by links the file asks for and GitHub lacks. `state(key)` gives
 * `{ number, open, parent, blockedBy }` for every issue (a planned one: no parent, no links).
 * A closed issue is left as it is.
 * @param {IssueEntry[]} issues
 * @param {(key: string) => IssueState} state
 * @returns {{ kind: string, parent?: string, child?: string, issue?: string,
 *   blocking?: string, text?: string }[]}
 */
export function missingLinks(issues, state) {
  const links = [];
  for (const issue of issues) {
    const own = state(issue.key);
    if (!own.open) continue;
    if (issue.parent != null) {
      const parent = state(issue.parent);
      if (own.parent == null)
        links.push({
          kind: 'subIssue',
          parent: issue.parent,
          child: issue.key,
        });
      else if (own.parent !== parent.number) {
        links.push({
          kind: 'note',
          text: `${issue.key} has another parent than ${issue.parent}: left as it is`,
        });
      }
    }
    for (const dep of issue.waitsFor ?? []) {
      const blocking = state(dep);
      if (blocking.number == null || !own.blockedBy.includes(blocking.number)) {
        links.push({ kind: 'blockedBy', issue: issue.key, blocking: dep });
      }
    }
  }
  return links;
}

/**
 * Board values to set: only empty ones, on open issues (Status `Backlog` unless the file says
 * otherwise). A value someone set stays, even when the file differs: it becomes a note.
 * `values(key)` gives the issue's current `{ field: value }` on the board (`{}` when off it).
 * @param {IssueEntry[]} issues
 * @param {(key: string) => IssueState} state
 * @param {(key: string) => Record<string, unknown>} values
 */
export function missingFieldValues(issues, state, values) {
  const set = [];
  const notes = [];
  for (const issue of issues) {
    if (!state(issue.key).open) continue;
    const have = values(issue.key);
    for (const [field, value] of Object.entries({
      Status: 'Backlog',
      ...issue.fields,
    })) {
      if (have[field] == null || have[field] === '')
        set.push({ key: issue.key, field, value });
      else if (field !== 'Status' && have[field] !== value) {
        notes.push(
          `${issue.key}: ${field} is ${have[field]} on the board, the file says ${value}`,
        );
      }
    }
  }
  return { set, notes };
}
