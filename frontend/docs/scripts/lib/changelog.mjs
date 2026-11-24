// The changelog page and its feed (#421), from the release step's data: `changelog/<version>.json`
// at the repository's root, one file per release, which `scripts/release.mjs` writes on each
// release tag alongside CHANGELOG.md and the GitHub Release. The site reads the files rather than
// GitHub's API, so a build needs no network and no token.
//
// Pull request titles and upgrade notes in that data are untrusted: anyone opening a pull request
// writes them. So none of it is ever compiled as Markdown or MDX. The generated page holds only the
// site's own text, a heading per version and a `<ChangelogRelease>` element naming the version;
// the component (`components/changelog-release.tsx`) shows the release's strings as React text
// nodes and builds every link itself, from the repository's address and the pull request's number.
// A release's own summary (`summary: { en, de? }`, #812) is read the same way: the generator cuts
// it into paragraphs, bullets, code and the links it finds itself (an https address, a path of the
// repository; scripts/release-summary.mjs), and the component shows those as text nodes.
import {
  parseSummary,
  summaryText,
} from '../../../../scripts/release-summary.mjs';
import { frontMatter, GENERATED_NOTE } from './markdown.mjs';

const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADVISORY = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/i;
const SEVERITIES = ['low', 'moderate', 'high', 'critical'];

/** A real calendar day as YYYY-MM-DD. */
const isDate = (v) => {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const day = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === v;
};

/** Orders version tags: negative when `a` is older than `b`. */
const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => VERSION.exec(v).slice(1, 4).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * One release's data, checked and cut down to the fields the site shows: `{ release }`, or
 * `{ problems }` saying what is wrong (the build fails on them).
 */
export function checkRelease(value, name) {
  const problems = [];
  const fail = (what) => {
    problems.push(`${name}: ${what}`);
    return undefined;
  };
  const isString = (v) => typeof v === 'string';
  const strings = (v, what) =>
    Array.isArray(v) && v.every(isString)
      ? [...v]
      : fail(`${what} is no list of strings`);
  const item = (v, what, withNote = false) => {
    if (typeof v !== 'object' || v === null)
      return fail(`${what} is no object`);
    if (!Number.isInteger(v.number) || v.number < 1)
      return fail(`${what}.number is no pull request number`);
    if (v.scope !== null && v.scope !== undefined && !isString(v.scope))
      return fail(`${what}.scope is no string`);
    if (!isString(v.text)) return fail(`${what}.text is no string`);
    if (v.severity != null && !SEVERITIES.includes(v.severity))
      return fail(`${what}.severity is none of ${SEVERITIES.join(', ')}`);
    if (
      v.advisory != null &&
      !(isString(v.advisory) && ADVISORY.test(v.advisory))
    )
      return fail(`${what}.advisory is no GHSA ID`);
    if (withNote && !isString(v.note)) return fail(`${what}.note is no string`);
    return {
      number: v.number,
      scope: v.scope ?? null,
      text: v.text,
      severity: v.severity ?? null,
      advisory: v.advisory ?? null,
      ...(withNote ? { note: v.note } : {}),
    };
  };
  const items = (v, what, withNote) =>
    Array.isArray(v)
      ? v.map((x, i) => item(x, `${what}[${i}]`, withNote))
      : fail(`${what} is no list`);

  if (typeof value !== 'object' || value === null) {
    fail('is no object');
    return { problems };
  }
  if (!isString(value.version) || !VERSION.test(value.version))
    fail('version is no vX.Y.Z');
  else if (`${value.version}.json` !== name)
    fail(`holds ${value.version}, not its file's version`);
  if (!isDate(value.date)) fail('date is no YYYY-MM-DD');
  let repository;
  try {
    const url = new URL(value.repository);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    repository = url.href.replace(/\/+$/, '');
  } catch {
    fail('repository is no https address');
  }
  // The previous release's tag, or a commit for a release made with `--from <commit>`.
  if (
    value.previous !== null &&
    !(
      isString(value.previous) &&
      (VERSION.test(value.previous) || /^[0-9a-f]{7,40}$/.test(value.previous))
    )
  )
    fail('previous is no version tag or commit');
  const groups = Array.isArray(value.groups)
    ? value.groups.map((g, i) =>
        typeof g === 'object' && g !== null && isString(g.title)
          ? { title: g.title, items: items(g.items, `groups[${i}].items`) }
          : fail(`groups[${i}] has no title`),
      )
    : fail('groups is no list');
  // The release's summary, cut into blocks here: the page never reads it as Markdown.
  let summary = null;
  if (value.summary !== undefined && value.summary !== null) {
    const { en, de } = value.summary;
    if (typeof value.summary !== 'object' || Array.isArray(value.summary))
      fail('summary is no object');
    else if (!isString(en)) fail('summary.en is no string');
    else if (de !== undefined && de !== null && !isString(de))
      fail('summary.de is no string');
    else
      summary = {
        en: parseSummary(en),
        de: isString(de) && de.trim() !== '' ? parseSummary(de) : null,
      };
  }
  const upgrade = value.upgrade ?? {};
  const settings = upgrade.settings ?? {};
  const release = {
    version: value.version,
    date: value.date,
    repository,
    previous: value.previous,
    summary: summary && summary.en.length > 0 ? summary : null,
    groups,
    upgrade: {
      breaking: items(upgrade.breaking, 'upgrade.breaking'),
      migrations: strings(upgrade.migrations, 'upgrade.migrations'),
      settings: {
        added: strings(settings.added, 'upgrade.settings.added'),
        changed: strings(settings.changed, 'upgrade.settings.changed'),
        removed: strings(settings.removed, 'upgrade.settings.removed'),
      },
      notes: items(upgrade.notes, 'upgrade.notes', true),
    },
  };
  return problems.length > 0 ? { problems } : { release };
}

/**
 * The releases of the files `{ name, text }` (`changelog/*.json`), newest first, and what is wrong
 * with any of them.
 */
export function readReleases(files) {
  const releases = [];
  const problems = [];
  for (const { name, text } of files) {
    if (!name.endsWith('.json')) continue;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      problems.push(`changelog/${name}: not JSON`);
      continue;
    }
    const checked = checkRelease(value, name);
    if (checked.release) releases.push(checked.release);
    else problems.push(...checked.problems.map((p) => `changelog/${p}`));
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  return { releases, problems };
}

const TEXT = {
  en: {
    title: 'Changelog',
    description:
      'Release notes and upgrade notes for every release, newest first.',
    intro:
      'What is new, improved and fixed in each release, the security fixes, and what to do when you upgrade. Before upgrading a server, read the upgrade notes of every release since yours, then the [upgrade steps](/self-hosting).',
    feed: 'Follow new releases with the',
    feedLink: 'Atom feed',
    none: 'No release yet. Until the first one, the latest commit on `main` is the current version.',
  },
  de: {
    title: 'Änderungsprotokoll',
    description:
      'Versionshinweise und Hinweise zur Aktualisierung für jede Version, die neueste zuerst.',
    intro:
      'Was in jeder Version neu, verbessert und behoben ist, die Sicherheitskorrekturen und was beim Aktualisieren zu tun ist. Die Zusammenfassung einer Version steht hier auf Deutsch, wo es sie gibt; die Liste der Änderungen ist auf Englisch. Vor dem Aktualisieren eines Servers die Hinweise zur Aktualisierung aller Versionen seit der eigenen lesen, dann die [Schritte zur Aktualisierung](/de/self-hosting).',
    feed: 'Neue Versionen verfolgen mit dem',
    feedLink: 'Atom-Feed',
    none: 'Noch keine Version veröffentlicht. Bis zur ersten ist der neueste Commit auf `main` die aktuelle Version.',
  },
};

/** The page's path of the feed (`app/changelog.xml/route.ts`). */
export const FEED_PATH = '/changelog.xml';

/**
 * The changelog page in a language, an MDX file: the site's own text, then per release a heading
 * with its anchor (`#v1.2.0`) and the element that shows its notes. Nothing of a release but its
 * version (checked: `vX.Y.Z`) is written into the MDX.
 */
export function renderChangelogPage(releases, lang) {
  const text = TEXT[lang];
  const parts = [
    frontMatter({ title: text.title, description: text.description }),
    GENERATED_NOTE,
    '',
    text.intro,
    '',
    // A plain link, not client navigation: the feed is a file.
    `${text.feed} <a href="${FEED_PATH}">${text.feedLink}</a>.`,
  ];
  if (releases.length === 0) parts.push('', text.none);
  for (const { version } of releases) {
    if (!VERSION.test(version))
      throw new Error(`no version: ${JSON.stringify(version)}`);
    parts.push(
      '',
      `## ${version} [#${version}]`,
      '',
      `<ChangelogRelease version="${version}" lang="${lang}" />`,
    );
  }
  return `${parts.join('\n')}\n`;
}

const line = (item) =>
  `${item.scope ? `${item.scope}: ` : ''}${item.text} (#${item.number})${item.severity ? ` Severity: ${item.severity}.` : ''}${item.advisory ? ` Advisory: ${item.advisory}.` : ''}`;

/** A release's notes as plain text, for its feed entry. */
export function releaseText(release) {
  const out = [];
  if (release.summary) out.push(summaryText(release.summary.en), '');
  for (const group of release.groups)
    out.push(group.title, ...group.items.map((i) => `- ${line(i)}`), '');
  const { upgrade } = release;
  out.push('Upgrade notes');
  if (release.previous === null)
    out.push('The first release: there is nothing to upgrade from.');
  else {
    out.push(
      `From ${release.previous}: take a backup first and follow the upgrade steps.`,
    );
    if (upgrade.breaking.length > 0)
      out.push(
        'Breaking changes:',
        ...upgrade.breaking.map((i) => `- ${line(i)}`),
      );
    if (upgrade.migrations.length > 0)
      out.push(
        'Database migrations:',
        ...upgrade.migrations.map((m) => `- ${m}`),
      );
    const { added, changed, removed } = upgrade.settings;
    if (added.length > 0) out.push(`New settings: ${added.join(', ')}`);
    if (changed.length > 0) out.push(`Changed settings: ${changed.join(', ')}`);
    if (removed.length > 0) out.push(`Removed settings: ${removed.join(', ')}`);
    for (const note of upgrade.notes)
      out.push(
        `- ${line(note)}${note.note ? `\n  ${note.note.replace(/\n/g, '\n  ')}` : ''}`,
      );
  }
  return out.join('\n');
}

const XML = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
/** Text for XML: what XML 1.0 cannot hold at all (control characters, lone surrogates) dropped. */
const xml = (text) =>
  String(text)
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '',
    )
    .replace(/[&<>"']/g, (c) => XML[c]);

/**
 * The Atom feed of the releases (RFC 4287), newest first: one entry per release, its notes as
 * plain text, linking to the release's anchor on the page.
 */
export function renderFeed(releases, { siteUrl }) {
  const page = `${siteUrl}/changelog/`;
  const time = (date) => `${date}T00:00:00Z`;
  const updated = releases[0] ? time(releases[0].date) : '1970-01-01T00:00:00Z';
  const entries = releases.map((r) =>
    [
      '  <entry>',
      `    <title>${xml(r.version)}</title>`,
      `    <id>${xml(`${page}#${r.version}`)}</id>`,
      `    <link rel="alternate" type="text/html" href="${xml(`${page}#${r.version}`)}"/>`,
      `    <updated>${time(r.date)}</updated>`,
      `    <content type="text">${xml(releaseText(r))}</content>`,
      '  </entry>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${TEXT.en.title}</title>`,
    `  <subtitle>${xml(TEXT.en.description)}</subtitle>`,
    `  <id>${xml(page)}</id>`,
    `  <link rel="self" type="application/atom+xml" href="${xml(`${siteUrl}${FEED_PATH}`)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xml(page)}"/>`,
    `  <updated>${updated}</updated>`,
    '  <author><name>The maintainers</name></author>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
