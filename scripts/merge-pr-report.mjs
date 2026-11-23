// What `pnpm merge:pr` reads and tells around a merge, as plain functions a test can pin
// (scripts/merge-pr-flow.mjs calls them; the findings that hold a merge are merge-pr-hold.mjs):
// what changed since the last full check, the note for the agents still running, the handover
// line and the coordinator's own leftover worktrees.

/** A line naming the full check: `pnpm check`, not `pnpm check:changed`. */
const FULL_CHECK = /\bpnpm check\b(?!:)/;

/**
 * The commit the PR's last full check (`pnpm check`) ran on, as its body names it, or null when
 * it names none. On a line that mentions `pnpm check` (not check:changed), a SHA is a 7–40 hex
 * word with at least one a–f letter (so "1523406 ms" isn't one); of those, the first that
 * `resolves` (a commit here), else the line's last.
 * @param {string | null | undefined} body
 * @param {(sha: string) => boolean} [resolves]
 */
export function checkedShaFrom(body, resolves = () => false) {
  for (const line of String(body ?? '').split('\n')) {
    if (!FULL_CHECK.test(line)) continue;
    const shas = (line.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).filter((word) =>
      /[a-f]/i.test(word),
    );
    if (shas.length > 0) return shas.find(resolves) ?? shas[shas.length - 1];
  }
  return null;
}

/** The lines saying what changed on the head after the checked commit (a list, no verdict). */
export function sinceCheckLines({ checked, head, files }) {
  if (files.length === 0) {
    return [
      `Since pnpm check ran on ${checked.slice(0, 8)}: nothing changed (the head is it).`,
    ];
  }
  return [
    `Since pnpm check ran on ${checked.slice(0, 8)}, ${files.length} file(s) changed on the head ${head.slice(0, 8)} (decide whether it needs a re-run):`,
    ...files.map((file) => `  ${file}`),
  ];
}

/** Files every running agent shares, whose change it merges in with care. */
const SHARED = [
  /(^|\/)CLAUDE\.md$/,
  /^docs\//,
  /^\.claude\/(skills|hooks)\//,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^nx\.json$/,
  /^tsconfig\.base\.json$/,
];

/** The PR's files that agents share. */
export function sharedFiles(paths) {
  return paths.filter((file) => SHARED.some((pattern) => pattern.test(file)));
}

/** The note for the agents still running, ready to paste. */
export function othersNote({ pr, shared }) {
  const base = pr.baseRefName;
  return [
    `----- for the running agents: PR #${pr.number} is merged into ${base} -----`,
    `PR #${pr.number} (${pr.title}) is on ${base}. Merge it into your branch now: git fetch origin && git merge origin/${base}, then pnpm install and pnpm check:changed.`,
    shared.length > 0
      ? `Shared files it changed (merge with care, keep both sides): ${shared.join(', ')}.`
      : 'It changed no shared file (CLAUDE.md, docs, skills, hooks, package.json, the lockfile, nx.json, tsconfig.base.json).',
    '----- end -----',
  ];
}

/** The one line to add to .claude/handover/handover.md (printed, never written). */
export function handoverLine({ pr, slot }) {
  const issues = (pr.closingIssuesReferences ?? []).map(
    (issue) => `#${issue.number}`,
  );
  return `- PR #${pr.number} (${pr.title}) merged into ${pr.baseRefName} at ${pr.headRefOid.slice(0, 8)}${issues.length ? `, closing ${issues.join(' ')}` : ''}${slot ? `; slot "${slot.name}" removed` : ''}.`;
}

/**
 * The worktrees of `git worktree list --porcelain` that are neither the main checkout (`root`)
 * nor an agent slot's (`slotTrees`: the worktree paths the slot records name): `{ own }`
 * (merge:pr's own temporary ones, `isOwnTemp(path)`, to remove) and `{ others }` (to list for
 * the coordinator; a folder under .claude/worktrees/ that no slot names is one of them).
 */
export function leftoverWorktrees(porcelain, root, isOwnTemp, slotTrees = []) {
  const slots = new Set(slotTrees);
  const paths = String(porcelain ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((dir) => dir !== root && !slots.has(dir));
  return {
    own: paths.filter(isOwnTemp),
    others: paths.filter((dir) => !isOwnTemp(dir)),
  };
}
