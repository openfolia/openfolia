// The release step's logic (#421), apart from git, GitHub and the disk so it runs in a test:
// which merged pull requests a release holds, how they group (`.github/release.yml`), the upgrade
// notes (migrations, settings, pull requests that ask for one), the notes of the GitHub Release
// and the entry in CHANGELOG.md. scripts/release.mjs wires it to the real tools.
//
// What the notes never hold: who wrote a pull request (no author, no @-mention that would name or
// notify someone) and a pull request's body, but for its "Upgrade notes" section and, for a
// security fix, its severity and advisory ID, so a fix is listed without how to exploit it.
import { parse } from 'yaml';

/** A release tag: `vX.Y.Z`, semantic versioning, no pre-release or build suffix. */
export const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The parts of a version tag, or null when it is none. */
export function parseVersion(tag) {
  const match = VERSION.exec(String(tag));
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Orders version tags: negative when `a` is older than `b`. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The newest version tag older than `version` among `tags`, or null (the first release). */
export function previousVersion(tags, version) {
  return (
    tags
      .filter((tag) => parseVersion(tag) && compareVersions(tag, version) < 0)
      .sort(compareVersions)
      .at(-1) ?? null
  );
}

/**
 * The groups and the left-out labels of `.github/release.yml`, in GitHub's format
 * (`changelog.categories[].title/labels`, `changelog.exclude.labels`).
 */
export function releaseConfig(text) {
  const changelog = parse(text)?.changelog ?? {};
  const lower = (labels) => (labels ?? []).map((l) => String(l).toLowerCase());
  const categories = (changelog.categories ?? []).map((category) => ({
    title: String(category.title),
    labels: lower(category.labels),
  }));
  if (categories.length === 0)
    throw new Error('.github/release.yml: changelog.categories lists no group');
  return { categories, exclude: lower(changelog.exclude?.labels) };
}

/** The group a title's conventional-commit type falls into when no label decides. */
const BY_TYPE = {
  feat: 'New',
  perf: 'Improved',
  fix: 'Fixed',
  revert: 'Fixed',
  docs: 'Docs',
  test: null,
  chore: null,
  ci: null,
  build: null,
  refactor: null,
  style: null,
};

/** Scopes of the repository's own tooling: a title with only these is internal, whatever its type. */
export const INTERNAL_SCOPES = [
  'workflow',
  'hooks',
  'ci',
  'scripts',
  'factory',
  'board',
  'agents',
];

/** `feat(api)!: text` → `{ type, scope, breaking, text }`; a title without a type is all text. */
export function parseTitle(title) {
  const match = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i.exec(
    String(title).trim(),
  );
  if (!match)
    return { type: null, scope: null, breaking: false, text: title.trim() };
  return {
    type: match[1].toLowerCase(),
    scope: match[2]?.trim() || null,
    breaking: match[3] === '!',
    text: match[4].trim(),
  };
}

const labelsOf = (pr) =>
  (pr.labels ?? []).map((l) => String(l.name ?? l).toLowerCase());

/**
 * The group of a pull request: the first whose label it carries, else its title's type; null when
 * it is left out (an excluded label, or an internal type).
 */
export function groupOf(pr, config) {
  const labels = labelsOf(pr);
  if (labels.some((l) => config.exclude.includes(l))) return null;
  const labelled = config.categories.find((c) =>
    c.labels.some((l) => labels.includes(l)),
  );
  if (labelled) return labelled.title;
  const { type, scope } = parseTitle(pr.title);
  const scopes = (scope ?? '').split(',').map((s) => s.trim().toLowerCase());
  if (scope && scopes.every((s) => INTERNAL_SCOPES.includes(s))) return null;
  const wanted = type && type in BY_TYPE ? BY_TYPE[type] : 'Improved';
  if (wanted === null) return null;
  // The type's group as release.yml names it; a renamed or missing group falls to the last one.
  return (
    config.categories.find((c) => c.title === wanted)?.title ??
    config.categories.at(-1).title
  );
}

/** Whether a pull request changes something an upgrade has to deal with. */
export const isBreaking = (pr) =>
  labelsOf(pr).includes('breaking') || parseTitle(pr.title).breaking;

/**
 * Text from a pull request made fit for the notes: HTML comments (the template's hints) go, any
 * `<!--` or `-->` left over is shown as text, and an @-mention loses its `@`, so the notes neither
 * link nor notify a person. Anyone opening a pull request controls this text; the docs site makes
 * it safe for MDX itself (`frontend/docs/scripts/lib/changelog.mjs`).
 */
export function plain(text) {
  return (
    String(text ?? '')
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      // What is left of a nested or overlapping comment can no longer open or close one, so it can't
      // pass for the changelog's release markers.
      .replace(/<!--/g, '&lt;!--')
      .replace(/--!?>/g, '--&gt;')
      // An `@` before a login-shaped name, unless it is part of a word (an email address).
      .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1')
      .trim()
  );
}

/** A pull request's sentence: `**scope:** text`, capitalised, and its link. */
export function noteLine(pr, repoUrl) {
  const { scope, text } = parseTitle(pr.title);
  const sentence = plain(text.charAt(0).toUpperCase() + text.slice(1));
  const prefix = scope ? `**${plain(scope)}:** ` : '';
  return `${prefix}${sentence} ([#${pr.number}](${repoUrl}/pull/${pr.number}))`;
}

/**
 * A pull request as data, for the docs site (`changelog/<version>.json`): its number, scope and
 * sentence as plain strings, which the site shows as text, never as Markdown or MDX.
 */
export function noteItem(pr) {
  const { scope, text } = parseTitle(pr.title);
  const item = {
    number: pr.number,
    scope: scope ? plain(scope) : null,
    text: plain(text.charAt(0).toUpperCase() + text.slice(1)),
  };
  return item;
}

const SEVERITY =
  /^\s*\**severity\**\s*:\s*\**\s*(low|moderate|medium|high|critical)\b/im;
const ADVISORY = /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/i;

/**
 * A security fix's line: its title, its severity and its advisory, from the lines
 * `Severity: <low|moderate|high|critical>` and the advisory's ID (`GHSA-…`) in its body. Nothing
 * else from the body: the notes name the fix, never how to exploit what it fixed.
 */
export function securityItem(pr) {
  const body = String(pr.body ?? '');
  const severity = SEVERITY.exec(body)?.[1]?.toLowerCase();
  const advisory = ADVISORY.exec(body)?.[0]?.toUpperCase();
  return {
    ...noteItem(pr),
    severity: severity === 'medium' ? 'moderate' : (severity ?? null),
    advisory: advisory ?? null,
  };
}

/** A security fix's line in Markdown (`securityItem`). */
export function securityLine(pr, repoUrl) {
  const { severity, advisory } = securityItem(pr);
  const parts = [noteLine(pr, repoUrl)];
  if (severity) parts.push(`Severity: ${severity}.`);
  if (advisory)
    parts.push(
      `Advisory: [${advisory}](${repoUrl}/security/advisories/${advisory}).`,
    );
  return parts.join(' ');
}

/** The text of a pull request body's `## Upgrade notes` section (any heading level), or ''. */
export function upgradeSection(body) {
  const lines = String(body ?? '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+upgrade notes?\s*$/i.test(l));
  if (start === -1) return '';
  const level = /^#+/.exec(lines[start])[0].length;
  const rest = lines.slice(start + 1);
  const fenced = insideFences(rest);
  const end = rest.findIndex((l, i) => {
    const heading = !fenced[i] && /^(#{1,6})\s/.exec(l);
    return heading && heading[1].length <= level;
  });
  return plain((end === -1 ? rest : rest.slice(0, end)).join('\n'));
}

/** For each line, whether it is inside a fenced code block (or is one of its fences). */
function insideFences(lines) {
  let fence = null;
  return lines.map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) {
      fence = marker;
      return true;
    }
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      return true;
    }
    return false;
  });
}

/**
 * An upgrade note for Markdown (the GitHub Release, CHANGELOG.md): a heading in it is bold text,
 * so it becomes no heading (or custom anchor) of the release; code blocks stay as they are.
 */
function markdownNote(text) {
  const lines = text.split('\n');
  const fenced = insideFences(lines);
  return lines
    .map((l, i) =>
      fenced[i] ? l : l.replace(/^(\s*)#{1,6}\s+(.*?)\s*#*\s*$/, '$1**$2**'),
    )
    .join('\n');
}

/**
 * The settings of an `.env.example`: each variable with the comment above it and its example
 * value (a commented-out `# NAME=value` counts as the variable too).
 */
export function envSettings(text) {
  const settings = new Map();
  let comment = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    // A variable, or one commented out (`# NAME=value`, its value without spaces): a comment
    // that names a variable in prose (`# NAME=x and more`) is part of the comment.
    const variable =
      /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line) ??
      /^\s*#\s*([A-Z][A-Z0-9_]*)=(\S*)\s*$/.exec(line);
    if (variable) {
      if (!settings.has(variable[1]))
        settings.set(variable[1], {
          comment: comment.join('\n'),
          value: variable[2].trim(),
        });
      comment = [];
    } else if (/^\s*#/.test(line)) comment.push(line.replace(/^\s*#\s?/, ''));
    else comment = [];
  }
  return settings;
}

/** What changed in the settings between two `.env.example` texts: names added, changed, removed. */
export function settingChanges(before, after) {
  const [old, now] = [envSettings(before), envSettings(after)];
  const added = [...now.keys()].filter((name) => !old.has(name));
  const removed = [...old.keys()].filter((name) => !now.has(name));
  const changed = [...now.keys()].filter((name) => {
    const was = old.get(name);
    const is = now.get(name);
    return was && (was.comment !== is.comment || was.value !== is.value);
  });
  return { added, changed, removed };
}

/** A migration's name from its file (`backend/api/migrations/0056_search_sweep.sql`). */
export const migrationName = (file) =>
  file
    .split('/')
    .at(-1)
    .replace(/\.sql$/, '');

const list = (items) => items.map((item) => `- ${item}`).join('\n');
const indent = (text) => text.replace(/\n/g, '\n  ');

/**
 * The "Upgrade notes" section of a release.
 * @param {{ previous: string|null, version: string, repoUrl: string, migrations: string[],
 *   settings: { added: string[], changed: string[], removed: string[] },
 *   breaking: object[], notes: { pr: object, text: string }[] }} upgrade
 */
export function renderUpgradeNotes(upgrade) {
  const { previous, version, repoUrl } = upgrade;
  const blob = (path) => `${repoUrl}/blob/${version}/${path}`;
  const guide = `[Upgrades](${blob('deploy/README.md')}#upgrades)`;
  if (previous === null)
    return [
      '### Upgrade notes',
      '',
      `The first release: there is nothing to upgrade from. To install it, follow the quick start in [deploy/README.md](${blob('deploy/README.md')}).`,
    ].join('\n');
  const parts = [
    '### Upgrade notes',
    '',
    `From ${previous}: take a backup first and follow ${guide} in deploy/README.md.`,
  ];
  if (upgrade.breaking.length > 0)
    parts.push(
      '',
      '**Breaking changes:**',
      '',
      list(upgrade.breaking.map((pr) => noteLine(pr, repoUrl))),
    );
  if (upgrade.migrations.length > 0)
    parts.push(
      '',
      `**Database migrations** (the API applies them when it starts, unless \`CCMS_DATABASE_MIGRATE=false\`; see ${guide}):`,
      '',
      list(upgrade.migrations.map((m) => `\`${migrationName(m)}\``)),
    );
  const { added, changed, removed } = upgrade.settings;
  if (added.length + changed.length + removed.length > 0) {
    const names = (items) => items.map((n) => `\`${n}\``).join(', ');
    parts.push(
      '',
      `**Settings** (see [.env.example](${blob('.env.example')})):`,
      '',
      list(
        [
          added.length > 0 && `New: ${names(added)}`,
          changed.length > 0 &&
            `Changed description or example: ${names(changed)}`,
          removed.length > 0 && `Removed: ${names(removed)}`,
        ].filter(Boolean),
      ),
    );
  }
  if (upgrade.notes.length > 0)
    parts.push(
      '',
      '**From the pull requests:**',
      '',
      list(
        upgrade.notes.map(({ pr, text }) =>
          text
            ? `${noteLine(pr, repoUrl)}\n\n  ${indent(markdownNote(text))}`
            : noteLine(pr, repoUrl),
        ),
      ),
    );
  if (parts.length === 3)
    parts.push('', 'Nothing else to do: no migration, no changed setting.');
  return parts.join('\n');
}

/**
 * Everything a release's notes are made from.
 * @param {{ version: string, previous: string|null, repoUrl: string, config: object,
 *   prs: object[], migrations: string[], envBefore: string, envAfter: string }} input
 *   `prs`: the merged pull requests the release holds (number, title, labels, body).
 */
export function planRelease(input) {
  const { config, repoUrl } = input;
  const prs = [...input.prs].sort((a, b) => a.number - b.number);
  const groups = config.categories.map((c) => ({
    title: c.title,
    lines: [],
    items: [],
  }));
  const securityPrs = new Set();
  for (const pr of prs) {
    const title = groupOf(pr, config);
    if (title === null) continue;
    const security = config.categories
      .find((c) => c.title === title)
      .labels.includes('security');
    const group = groups.find((g) => g.title === title);
    if (security) securityPrs.add(pr.number);
    group.lines.push(
      security ? securityLine(pr, repoUrl) : noteLine(pr, repoUrl),
    );
    group.items.push(security ? securityItem(pr) : noteItem(pr));
  }
  return {
    groups: groups.filter((g) => g.lines.length > 0),
    upgrade: {
      previous: input.previous,
      version: input.version,
      repoUrl,
      migrations: input.previous === null ? [] : [...input.migrations].sort(),
      settings:
        input.previous === null
          ? { added: [], changed: [], removed: [] }
          : settingChanges(input.envBefore, input.envAfter),
      // Every pull request of the release, also one left out of the groups (a deployment chore
      // can still need a step when upgrading).
      breaking: prs.filter(isBreaking),
      // A security fix's body stays out of the notes, its upgrade section too: it could say how
      // to exploit what it fixed. Its `upgrade-note` label still lists its title.
      notes: prs
        .map((pr) => ({
          pr,
          text: securityPrs.has(pr.number) ? '' : upgradeSection(pr.body),
        }))
        .filter(
          ({ pr, text }) =>
            text !== '' || labelsOf(pr).includes('upgrade-note'),
        ),
    },
  };
}

/**
 * A release as data (`changelog/<version>.json`), what the docs site's /changelog and its feed are
 * made from: every text from a pull request a plain string, shown by the site as text only.
 */
export function releaseData(plan, { version, date, repoUrl }) {
  const { upgrade } = plan;
  return {
    version,
    date,
    repository: repoUrl,
    previous: upgrade.previous,
    groups: plan.groups.map((g) => ({ title: g.title, items: g.items })),
    upgrade: {
      breaking: upgrade.breaking.map(noteItem),
      migrations: upgrade.migrations.map(migrationName),
      settings: upgrade.settings,
      notes: upgrade.notes.map(({ pr, text }) => ({
        ...noteItem(pr),
        note: text,
      })),
    },
  };
}

/** The notes of a GitHub Release: the groups, then the upgrade notes. */
export function renderNotes(plan) {
  const groups = plan.groups.map((g) => `### ${g.title}\n\n${list(g.lines)}`);
  if (groups.length === 0)
    groups.push('No change a user or operator would notice.');
  return `${[...groups, renderUpgradeNotes(plan.upgrade)].join('\n\n')}\n`;
}

export const CHANGELOG_HEADER = `# Changelog

Every release, newest first: what is new, improved and fixed, the security fixes, and what to do
when you upgrade. \`scripts/release.mjs\` writes this file on each release tag, with the same notes
as the release on GitHub (CONTRIBUTING.md, "Releases"); don't edit it by hand.
`;

const ENTRY =
  /<!-- release (v\d+\.\d+\.\d+) (\d{4}-\d{2}-\d{2}) -->\n([\s\S]*?)<!-- \/release \1 -->\n?/g;

/** The releases in a CHANGELOG.md: version, date and notes (without the version's heading). */
export function parseChangelog(text) {
  return [...String(text ?? '').matchAll(ENTRY)].map((m) => ({
    version: m[1],
    date: m[2],
    notes: m[3].replace(/^## .*\n+/, '').trimEnd(),
  }));
}

/** CHANGELOG.md with `release`'s entry added, or replaced when it is there: newest first. */
export function updateChangelog(existing, release, repoUrl) {
  // The notes' own text never holds a marker (`plain`); refuse rather than write a forged entry.
  if (/<!--\s*\/?\s*release\b/i.test(release.notes))
    throw new Error(`the notes of ${release.version} hold a release marker`);
  const others = parseChangelog(existing).filter(
    (r) => r.version !== release.version,
  );
  const all = [...others, release].sort((a, b) =>
    compareVersions(b.version, a.version),
  );
  const entries = all.map(
    (r) =>
      `<!-- release ${r.version} ${r.date} -->\n## [${r.version}](${repoUrl}/releases/tag/${r.version}) (${r.date})\n\n${r.notes.trimEnd()}\n<!-- /release ${r.version} -->\n`,
  );
  return `${CHANGELOG_HEADER}\n${entries.join('\n')}`;
}

export const USAGE = `Usage: node scripts/release.mjs <vX.Y.Z> [options]

Writes the release notes of the tag vX.Y.Z (CONTRIBUTING.md, "Releases"): creates or updates its
GitHub Release and adds its entry to CHANGELOG.md.

  --dry-run          print the notes; change nothing on GitHub or on disk (but --changelog)
  --to <ref>         the release's commit (default: the tag; any ref with --dry-run)
  --from <ref>       the previous release (default: the newest older vX.Y.Z tag)
  --changelog <file> the changelog to write (default: CHANGELOG.md; with --dry-run only when given)
  --data <dir>       where the release's data goes, <dir>/<version>.json, for the docs site
                     (default: changelog; with --dry-run only when given)
  --no-github        write the changelog only; no GitHub Release
`;

/** The command line: the version and the options; throws with a reason. */
export function parseArgs(argv) {
  const options = {
    dryRun: false,
    github: true,
    to: null,
    from: null,
    changelog: null,
    data: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--'))
        throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-github') options.github = false;
    else if (arg === '--to') options.to = value();
    else if (arg === '--from') options.from = value();
    else if (arg === '--changelog') options.changelog = value();
    else if (arg === '--data') options.data = value();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  if (options.help) return options;
  if (rest.length !== 1)
    throw new Error('name exactly one version, e.g. v1.2.0');
  if (!parseVersion(rest[0]))
    throw new Error(`"${rest[0]}" is no version tag: vX.Y.Z, e.g. v1.2.0`);
  options.version = rest[0];
  if (options.to !== null && !options.dryRun)
    throw new Error('--to is for a dry run: a release is made from its tag');
  return options;
}

/**
 * The release step, its tools injected:
 * - `git(args)`: git's output (throws on failure); `gitOk(args)`: whether it succeeds;
 * - `github`: `repo()` → `{ url }`, `mergedPullRequests()` → `[{ number, title, labels,
 *   body, mergeCommit }]`, `hasRelease(tag)`, `createRelease(tag, notes)`,
 *   `editRelease(tag, notes)`;
 * - `files`: `read(path)` (null when missing), `write(path, text)`;
 * - `log(line)`.
 * Returns the notes.
 */
export function runRelease(argv, { git, gitOk, github, files, log }) {
  const options = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return null;
  }
  const { version } = options;
  const tagExists = gitOk([
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/tags/${version}`,
  ]);
  if (!options.dryRun && !tagExists)
    throw new Error(
      `no tag ${version}: tag the release's commit first (CONTRIBUTING.md, "Releases")`,
    );
  const to = options.to ?? (tagExists ? version : 'HEAD');
  const toCommit = git(['rev-parse', '--verify', `${to}^{commit}`]).trim();

  const previous =
    options.from ??
    previousVersion(
      git(['tag', '--list', 'v*.*.*', '--merged', toCommit])
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean),
      version,
    );
  const fromCommit =
    previous && git(['rev-parse', '--verify', `${previous}^{commit}`]).trim();
  const range = previous ? `${fromCommit}..${toCommit}` : toCommit;
  const commits = new Set(
    git(['rev-list', range])
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean),
  );
  const prs = github
    .mergedPullRequests()
    .filter((pr) => pr.mergeCommit && commits.has(pr.mergeCommit));

  const migrations = previous
    ? git([
        'diff',
        '--name-only',
        '--diff-filter=A',
        fromCommit,
        toCommit,
        '--',
        'backend/api/migrations',
      ])
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => /^backend\/api\/migrations\/[^/]+\.sql$/.test(f))
        .sort()
    : [];
  const envAt = (commit) =>
    gitOk(['cat-file', '-e', `${commit}:.env.example`])
      ? git(['show', `${commit}:.env.example`])
      : '';

  const { url: repoUrl } = github.repo();
  // The groups as the checkout running the step has them (the workflow runs it on main).
  const groups = files.read('.github/release.yml');
  if (groups === null)
    throw new Error(
      'no .github/release.yml: run the release step from the repository root',
    );
  const config = releaseConfig(groups);
  const plan = planRelease({
    version,
    previous,
    repoUrl,
    config,
    prs,
    migrations,
    envBefore: previous ? envAt(fromCommit) : '',
    envAfter: envAt(toCommit),
  });
  const notes = renderNotes(plan);
  const date = git(['log', '-1', '--format=%cs', toCommit]).trim();
  log(
    `${version} (${date}), from ${previous ?? 'the first commit'}: ${prs.length} pull request(s) merged, ${plan.groups.reduce((n, g) => n + g.lines.length, 0)} in the notes.`,
  );

  if (options.dryRun) log(`\n${notes}`);
  else if (options.github) {
    if (github.hasRelease(version)) {
      github.editRelease(version, notes);
      log(`Updated the GitHub Release ${version}.`);
    } else {
      github.createRelease(version, notes);
      log(`Created the GitHub Release ${version}.`);
    }
  }
  const changelogPath =
    options.changelog ?? (options.dryRun ? null : 'CHANGELOG.md');
  if (changelogPath) {
    files.write(
      changelogPath,
      updateChangelog(
        files.read(changelogPath),
        { version, date, notes },
        repoUrl,
      ),
    );
    log(`Wrote ${changelogPath}.`);
  }
  const dataDir = options.data ?? (options.dryRun ? null : 'changelog');
  if (dataDir) {
    const file = `${dataDir.replace(/\/+$/, '')}/${version}.json`;
    files.write(
      file,
      `${JSON.stringify(releaseData(plan, { version, date, repoUrl }), null, 2)}\n`,
    );
    log(`Wrote ${file}.`);
  }
  return notes;
}
