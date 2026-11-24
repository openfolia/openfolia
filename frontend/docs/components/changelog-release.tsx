import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lang } from '../lib/i18n';

/** A pull request in a release's data (`changelog/<version>.json`, checked by the generator). */
export type ReleaseItem = {
  number: number;
  scope: string | null;
  text: string;
  severity: string | null;
  advisory: string | null;
  note?: string;
};

/**
 * A part of a line of a release's summary, as `scripts/release-summary.mjs` cut it: text, code, an
 * https address, or a path of the repository.
 */
export type SummaryPart =
  | { text: string }
  | { code: string }
  | { url: string; text: string }
  | { path: string; anchor: string | null; text: string };

/** A paragraph or a list of a release's summary. */
export type SummaryBlock =
  { paragraph: SummaryPart[] } | { list: SummaryPart[][] };

/** A release's data as `scripts/generate.mjs` checked it (`checkRelease`). */
export type Release = {
  version: string;
  date: string;
  repository: string;
  previous: string | null;
  summary?: { en: SummaryBlock[]; de: SummaryBlock[] | null } | null;
  groups: { title: string; items: ReleaseItem[] }[];
  upgrade: {
    breaking: ReleaseItem[];
    migrations: string[];
    settings: { added: string[]; changed: string[]; removed: string[] };
    notes: ReleaseItem[];
  };
};

const TEXT = {
  en: {
    released: 'Released',
    onGithub: 'Release on GitHub',
    nothingNoticed: 'No change a user or operator would notice.',
    upgradeNotes: 'Upgrade notes',
    upgrades: 'Upgrades',
    first:
      'The first release: there is nothing to upgrade from. To install it, follow the quick start in',
    from: 'From',
    backup: ': take a backup first and follow',
    inDeploy: 'in deploy/README.md.',
    breaking: 'Breaking changes:',
    migrations: 'Database migrations',
    migrationsText:
      '(the API applies them when it starts, unless {setting}; see {guide}):',
    settings: 'Settings',
    see: 'see',
    added: 'New:',
    changed: 'Changed description or example:',
    removed: 'Removed:',
    fromPulls: 'From the pull requests:',
    nothingElse: 'Nothing else to do: no migration, no changed setting.',
    summaryInEnglish: '',
  },
  de: {
    released: 'Veröffentlicht',
    onGithub: 'Auf GitHub',
    nothingNoticed:
      'Keine Änderung, die Benutzer oder Betreiber bemerken würden.',
    upgradeNotes: 'Hinweise zur Aktualisierung',
    upgrades: 'Upgrades',
    first:
      'Die erste Version: Es gibt nichts zu aktualisieren. Zum Installieren folgen Sie dem Schnellstart in',
    from: 'Von',
    backup: ': Erstellen Sie zuerst ein Backup und folgen Sie dem Abschnitt',
    inDeploy: 'in deploy/README.md.',
    breaking: 'Inkompatible Änderungen:',
    migrations: 'Datenbankmigrationen',
    migrationsText:
      '(die API wendet sie beim Start an, außer bei {setting}; siehe {guide}):',
    settings: 'Einstellungen',
    see: 'siehe',
    added: 'Neu:',
    changed: 'Beschreibung oder Beispiel geändert:',
    removed: 'Entfernt:',
    fromPulls: 'Aus den Pull Requests:',
    nothingElse:
      'Sonst nichts zu tun: keine Migration, keine geänderte Einstellung.',
    summaryInEnglish:
      'Die Zusammenfassung dieser Version gibt es nur auf Englisch.',
  },
} satisfies Record<Lang, Record<string, string>>;

/**
 * The German titles of the changelog's groups (`.github/release.yml`); a title not listed is shown
 * as the release's data has it.
 */
const GROUP_TITLES: Record<Lang, Record<string, string>> = {
  en: {},
  de: {
    Security: 'Sicherheit',
    New: 'Neu',
    Improved: 'Verbessert',
    Fixed: 'Behoben',
    Docs: 'Dokumentation',
  },
};

/**
 * Text from a pull request, as text: `code` in backticks shown as code when the backticks pair up,
 * everything else as it is. Only text nodes: no Markdown, no HTML, no link from the text.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <code key={i}>{part}</code> : part,
      )}
    </>
  );
}

const linkClass = 'text-fd-primary underline underline-offset-4';

/** A pull request's line: scope, sentence, and the link the page builds from its number. */
function Item({ item, repository }: { item: ReleaseItem; repository: string }) {
  return (
    <>
      {item.scope && <strong>{item.scope}: </strong>}
      <Inline text={item.text} /> (
      <a className={linkClass} href={`${repository}/pull/${item.number}`}>
        #{item.number}
      </a>
      ){item.severity && <> Severity: {item.severity}.</>}
      {item.advisory && (
        <>
          {' '}
          Advisory:{' '}
          <a
            className={linkClass}
            href={`${repository}/security/advisories/${item.advisory}`}
          >
            {item.advisory}
          </a>
          .
        </>
      )}
    </>
  );
}

function Items({
  items,
  repository,
}: {
  items: ReleaseItem[];
  repository: string;
}) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.number}>
          <Item item={item} repository={repository} />
          {item.note && (
            <span className="mt-1 block whitespace-pre-wrap break-words">
              <Inline text={item.note} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The https address of a link, or null: nothing else ever becomes a link. */
function https(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** A line of a release's summary: text nodes, code, and the links built here. */
function SummaryLine({
  parts,
  repository,
  version,
}: {
  parts: SummaryPart[];
  repository: string;
  version: string;
}) {
  return (
    <>
      {parts.map((part, i) => {
        if ('code' in part) return <code key={i}>{part.code}</code>;
        if ('url' in part) {
          const href = https(part.url);
          return href ? (
            <a key={i} className={`${linkClass} break-words`} href={href}>
              {part.text}
            </a>
          ) : (
            part.text
          );
        }
        if (
          'path' in part &&
          /^(?:[A-Za-z0-9_][\w.-]*\/)*[A-Za-z0-9_][\w.-]*$/.test(part.path) &&
          !part.path.includes('..')
        ) {
          const anchor =
            part.anchor && /^#[\w-]+$/.test(part.anchor) ? part.anchor : '';
          return (
            <a
              key={i}
              className={`${linkClass} break-words`}
              href={`${repository}/blob/${version}/${part.path}${anchor}`}
            >
              {part.text}
            </a>
          );
        }
        return part.text;
      })}
    </>
  );
}

/** A release's summary, first in its notes. */
function Summary({
  blocks,
  repository,
  version,
}: {
  blocks: SummaryBlock[];
  repository: string;
  version: string;
}) {
  return (
    <>
      {blocks.map((block, i) =>
        'paragraph' in block ? (
          <p key={i}>
            <SummaryLine
              parts={block.paragraph}
              repository={repository}
              version={version}
            />
          </p>
        ) : (
          <ul key={i}>
            {block.list.map((item, j) => (
              <li key={j}>
                <SummaryLine
                  parts={item}
                  repository={repository}
                  version={version}
                />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

const codes = (names: string[]) =>
  names.map((name, i) => (
    <span key={name}>
      {i > 0 && ', '}
      <code className="break-words">{name}</code>
    </span>
  ));

/** A release's notes, from its data: every string a text node, every link built here. */
export function ReleaseNotes({
  release,
  lang,
}: {
  release: Release;
  lang: Lang;
}) {
  const { repository, version, upgrade } = release;
  const blob = (path: string) => `${repository}/blob/${version}/${path}`;
  const t = TEXT[lang];
  const guide = (
    <a className={linkClass} href={`${blob('deploy/README.md')}#upgrades`}>
      {t.upgrades}
    </a>
  );
  const [beforeSetting, afterSetting] = t.migrationsText.split('{setting}');
  const [beforeGuide, afterGuide] = (afterSetting ?? '').split('{guide}');
  const { added, changed, removed } = upgrade.settings;
  const summary = release.summary ?? null;
  const ownSummary = summary && (lang === 'en' ? summary.en : summary.de);
  const nothing =
    upgrade.breaking.length +
      upgrade.migrations.length +
      added.length +
      changed.length +
      removed.length +
      upgrade.notes.length ===
    0;
  return (
    <div data-release={version}>
      <p>
        {t.released} {release.date} ·{' '}
        <a className={linkClass} href={`${repository}/releases/tag/${version}`}>
          {t.onGithub}
        </a>
      </p>
      {summary &&
        (ownSummary ? (
          <div data-summary={lang} lang={lang}>
            <Summary
              blocks={ownSummary}
              repository={repository}
              version={version}
            />
          </div>
        ) : (
          <>
            <p>{t.summaryInEnglish}</p>
            <div data-summary="en" lang="en">
              <Summary
                blocks={summary.en}
                repository={repository}
                version={version}
              />
            </div>
          </>
        ))}
      {release.groups.length === 0 && !summary && <p>{t.nothingNoticed}</p>}
      {release.groups.map((group) => (
        <section key={group.title}>
          <p>
            <strong>
              {Object.hasOwn(GROUP_TITLES[lang], group.title)
                ? GROUP_TITLES[lang][group.title]
                : group.title}
            </strong>
          </p>
          <Items items={group.items} repository={repository} />
        </section>
      ))}
      <p>
        <strong>{t.upgradeNotes}</strong>
      </p>
      {release.previous === null ? (
        <p>
          {t.first}{' '}
          <a className={linkClass} href={blob('deploy/README.md')}>
            deploy/README.md
          </a>
          .
        </p>
      ) : (
        <>
          <p>
            {t.from} {release.previous}
            {t.backup} {guide} {t.inDeploy}
          </p>
          {upgrade.breaking.length > 0 && (
            <>
              <p>
                <strong>{t.breaking}</strong>
              </p>
              <Items items={upgrade.breaking} repository={repository} />
            </>
          )}
          {upgrade.migrations.length > 0 && (
            <>
              <p>
                <strong>{t.migrations}</strong> {beforeSetting}
                <code>CCMS_DATABASE_MIGRATE=false</code>
                {beforeGuide}
                {guide}
                {afterGuide}
              </p>
              <ul>
                {upgrade.migrations.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {added.length + changed.length + removed.length > 0 && (
            <>
              <p>
                <strong>{t.settings}</strong> ({t.see}{' '}
                <a className={linkClass} href={blob('.env.example')}>
                  .env.example
                </a>
                ):
              </p>
              <ul>
                {added.length > 0 && (
                  <li>
                    {t.added} {codes(added)}
                  </li>
                )}
                {changed.length > 0 && (
                  <li>
                    {t.changed} {codes(changed)}
                  </li>
                )}
                {removed.length > 0 && (
                  <li>
                    {t.removed} {codes(removed)}
                  </li>
                )}
              </ul>
            </>
          )}
          {upgrade.notes.length > 0 && (
            <>
              <p>
                <strong>{t.fromPulls}</strong>
              </p>
              <Items items={upgrade.notes} repository={repository} />
            </>
          )}
          {nothing && <p>{t.nothingElse}</p>}
        </>
      )}
    </div>
  );
}

let releases: Release[] | undefined;

/** A release of the site's changelog by version, from `generated/changelog.json`. */
export function ChangelogRelease({
  version,
  lang = 'en',
}: {
  version: string;
  lang?: Lang;
}) {
  releases ??= JSON.parse(
    readFileSync(join(process.cwd(), 'generated/changelog.json'), 'utf8'),
  ) as Release[];
  const release = releases.find((r) => r.version === version);
  if (!release) throw new Error(`No release ${version} in the changelog data`);
  return <ReleaseNotes release={release} lang={lang} />;
}
