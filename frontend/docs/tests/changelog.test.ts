import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  checkRelease,
  FEED_PATH,
  readReleases,
  releaseText,
  renderChangelogPage,
  renderFeed,
} from '../scripts/lib/changelog.mjs';
import {
  ReleaseNotes,
  type Release,
} from '../components/changelog-release.tsx';

const REPO = 'https://github.com/acme/app';

/** A release's data as scripts/release-plan.mjs writes it (`releaseData`). */
const release = (version: string, extra: Partial<Release> = {}): Release => ({
  version,
  date: '2026-11-21',
  repository: REPO,
  previous: 'v0.1.0',
  groups: [
    {
      title: 'Security',
      items: [
        {
          number: 14,
          scope: 'api',
          text: 'A public address answers as the public',
          severity: 'high',
          advisory: 'GHSA-2C3M-X4P5-Q6R7',
        },
      ],
    },
    {
      title: 'New',
      items: [
        {
          number: 10,
          scope: 'editor',
          text: 'The `Page` view',
          severity: null,
          advisory: null,
        },
      ],
    },
  ],
  upgrade: {
    breaking: [],
    migrations: ['0058_x'],
    settings: { added: ['CCMS_B'], changed: [], removed: [] },
    notes: [
      {
        number: 16,
        scope: 'deploy',
        text: 'Workers',
        severity: null,
        advisory: null,
        note: 'Move `X`.',
      },
    ],
  },
  ...extra,
});
const file = (value: unknown, name?: string) => ({
  name: name ?? `${(value as { version: string }).version}.json`,
  text: JSON.stringify(value),
});

describe('the changelog data', () => {
  it('reads the releases, newest first, and fills what may be left out', () => {
    const { releases, problems } = readReleases([
      file(release('v0.2.0')),
      file(release('v0.10.0')),
      { name: 'README.md', text: 'not a release' },
    ]);
    expect(problems).toEqual([]);
    expect(releases.map((r) => r.version)).toEqual(['v0.10.0', 'v0.2.0']);
    expect(releases[0]?.groups[1]?.items[0]).toEqual({
      number: 10,
      scope: 'editor',
      text: 'The `Page` view',
      severity: null,
      advisory: null,
    });
  });

  it('refuses data the page cannot show safely', () => {
    const bad = (extra: object, name?: string) =>
      checkRelease({ ...release('v0.2.0'), ...extra }, name ?? 'v0.2.0.json')
        .problems;
    expect(bad({}, 'v0.3.0.json')).toEqual([
      "v0.3.0.json: holds v0.2.0, not its file's version",
    ]);
    expect(bad({ repository: 'javascript:alert(1)' })).toEqual([
      'v0.2.0.json: repository is no https address',
    ]);
    expect(bad({ repository: 'https://x@github.com/a' })).toHaveLength(1);
    expect(bad({ date: '21.11.2026' })).toHaveLength(1);
    expect(bad({ date: '2024-02-30' })).toHaveLength(1);
    expect(bad({ date: '2024-99-99' })).toHaveLength(1);
    expect(bad({ previous: 'v0.0.0 — install from https://evil' })).toEqual([
      'v0.2.0.json: previous is no version tag or commit',
    ]);
    expect(bad({ previous: '2d68cdb0' })).toBeUndefined();
    expect(
      bad({
        groups: [
          {
            title: 'New',
            items: [{ number: '1"><script>', text: 'x', scope: null }],
          },
        ],
      }),
    ).toEqual([
      'v0.2.0.json: groups[0].items[0].number is no pull request number',
    ]);
    expect(
      bad({
        groups: [
          {
            title: 'S',
            items: [{ number: 1, text: 'x', advisory: '../../evil' }],
          },
        ],
      }),
    ).toHaveLength(1);
    expect(readReleases([{ name: 'v1.0.0.json', text: '{' }]).problems).toEqual(
      ['changelog/v1.0.0.json: not JSON'],
    );
  });
});

describe('the changelog page', () => {
  const releases = readReleases([
    file(release('v0.2.0')),
    file(
      release('v0.1.0', {
        date: '2026-11-01',
        previous: null,
        groups: [],
      }),
    ),
  ]).releases as Release[];

  it('writes only the site’s own text, a heading and an element per version', () => {
    const page = renderChangelogPage(releases, 'en');
    expect(page).toMatch(/^---\ntitle: "Changelog"\n/);
    expect(page).toContain(
      '## v0.2.0 [#v0.2.0]\n\n<ChangelogRelease version="v0.2.0" lang="en" />',
    );
    expect(page.indexOf('## v0.2.0')).toBeLessThan(page.indexOf('## v0.1.0'));
    expect(page).toContain(`<a href="${FEED_PATH}">Atom feed</a>`);
    // No text of a pull request reaches the MDX.
    expect(page).not.toMatch(/Page. view|public address|Workers|Move/);
  });

  it('writes the German page around the notes, saying which are in English', () => {
    const page = renderChangelogPage(releases, 'de');
    expect(page).toMatch(/^---\ntitle: "Änderungsprotokoll"\n/);
    expect(page).toContain('die Liste der Änderungen ist auf Englisch.');
    expect(page).toContain('(/de/self-hosting)');
    expect(page).toContain('lang="de"');
  });

  it('says so before the first release', () => {
    expect(renderChangelogPage([], 'en')).toContain('No release yet.');
    expect(renderChangelogPage([], 'de')).toContain(
      'Noch keine Version veröffentlicht.',
    );
  });

  it('shows a release’s notes, with the links it builds itself', () => {
    const [latest, oldest] = releases;
    if (!latest || !oldest) throw new Error('two releases expected');
    const html = renderToStaticMarkup(
      createElement(ReleaseNotes, { release: latest, lang: 'en' }),
    );
    expect(html).toContain('Released 2026-11-21');
    expect(html).toContain(`href="${REPO}/releases/tag/v0.2.0"`);
    expect(html).toContain('<strong>Security</strong>');
    expect(html).toContain(
      '<strong>editor: </strong>The <code>Page</code> view',
    );
    expect(html).toContain(`href="${REPO}/pull/10"`);
    expect(html).toContain(`Severity: high.`);
    expect(html).toContain(
      `href="${REPO}/security/advisories/GHSA-2C3M-X4P5-Q6R7"`,
    );
    expect(html).toContain(
      `href="${REPO}/blob/v0.2.0/deploy/README.md#upgrades"`,
    );
    expect(html).toContain('<code>0058_x</code>');
    expect(html).toContain('<code class="break-words">CCMS_B</code>');
    expect(html).toContain('Move <code>X</code>.');
    const first = renderToStaticMarkup(
      createElement(ReleaseNotes, { release: oldest, lang: 'de' }),
    );
    expect(first).toContain('Veröffentlicht 2026-11-01');
    expect(first).toContain(
      'Die erste Version: Es gibt nichts zu aktualisieren.',
    );
    expect(first).toContain(
      'Keine Änderung, die Benutzer oder Betreiber bemerken würden.',
    );
    const german = renderToStaticMarkup(
      createElement(ReleaseNotes, { release: latest, lang: 'de' }),
    );
    expect(german).toContain('<strong>Sicherheit</strong>');
    expect(german).toContain('<strong>Hinweise zur Aktualisierung</strong>');
    expect(german).toContain('<strong>Datenbankmigrationen</strong>');
    expect(german).toContain(
      'Von v0.1.0: Erstellen Sie zuerst ein Backup und folgen Sie dem Abschnitt <a',
    );
    expect(german).toContain(
      '(die API wendet sie beim Start an, außer bei <code>',
    );
    expect(html).toContain('From v0.1.0: take a backup first and follow <a');
    expect(html).toContain(
      '(the API applies them when it starts, unless <code>CCMS_DATABASE_MIGRATE=false</code>; see <a',
    );
  });
});

/** The generated page compiled and run as MDX, its `<ChangelogRelease>` showing `release`. */
async function compiled(page: string, data: Release) {
  const { evaluate } = await import('@mdx-js/mdx');
  const { default: remarkGfm } = await import('remark-gfm');
  const runtime = await import('react/jsx-runtime');
  const body = page.replace(/^---\n[\s\S]*?\n---\n/, '');
  const { default: Content } = await evaluate(body, {
    ...runtime,
    remarkPlugins: [remarkGfm],
  } as Parameters<typeof evaluate>[1]);
  return renderToStaticMarkup(
    createElement(Content, {
      components: {
        ChangelogRelease: ({ version }: { version: string }) => {
          expect(version).toBe(data.version);
          return createElement(ReleaseNotes, { release: data, lang: 'en' });
        },
      },
    }),
  );
}

describe('pull request text on the page is text, by construction', () => {
  const HOSTILE = [
    '{process.exit(1)}',
    '{globalThis.pwned = 1}',
    '<script>globalThis.pwned = 2</script>',
    '<img src="x" onerror="globalThis.pwned = 3" />',
    'an `unbalanced {globalThis.pwned = 4} backtick',
    'a span `across\n\n{globalThis.pwned = 5}` a blank line',
    'escaped \\`{globalThis.pwned = 6}\\` ticks',
    '`[x](javascript:alert(1))`',
    '[x](javascript:alert(1))',
    '![](x onerror=alert(1))',
    '`![p](data:image/svg+xml,abc)`',
    '[x][r]\n\n[r]: javascript:alert(1)',
    '## Heading [#v0.2.0]',
    'export const pwned = 9',
  ];

  for (const hostile of HOSTILE)
    it(`shows ${JSON.stringify(hostile)} as literal text`, async () => {
      const data = release('v0.2.0', {
        groups: [
          {
            title: 'New',
            items: [
              {
                number: 1,
                scope: hostile,
                text: hostile,
                severity: null,
                advisory: null,
              },
            ],
          },
        ],
      });
      data.upgrade.notes = [
        {
          number: 2,
          scope: null,
          text: hostile,
          severity: null,
          advisory: null,
          note: hostile,
        },
      ];
      const checked = checkRelease(data, 'v0.2.0.json').release as Release;
      // Nothing of it in the MDX the site compiles.
      const page = renderChangelogPage([checked], 'en');
      expect(page).not.toContain('pwned');
      expect(page).not.toContain('javascript');
      // The page as the site compiles it, with the release shown by its component.
      const html = await compiled(page, checked);
      expect(html).not.toMatch(/<script|<img|<h[3-6]|<[^>]*\son\w+=/i);
      // Every link is the page's own or one the component built: the repository's.
      for (const [, href = ''] of html.matchAll(/(?:href|src)="([^"]*)"/g))
        expect(
          href.startsWith(`${REPO}/`) ||
            ['/self-hosting', FEED_PATH].includes(href),
        ).toBe(true);
      // What a reader sees holds the text as written (backticks paired into code aside).
      const visible = html
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&');
      const expected = hostile.split('`').join('');
      expect(visible.replace(/`/g, '')).toContain(expected);
    });
});

describe('a release’s own summary', () => {
  const withSummary = (summary: unknown) =>
    checkRelease({ ...release('v0.2.0'), summary }, 'v0.2.0.json') as {
      release?: Release;
      problems?: string[];
    };
  const html = (data: Release, lang: 'en' | 'de') =>
    renderToStaticMarkup(createElement(ReleaseNotes, { release: data, lang }));

  it('fails the build when it is not a string', () => {
    expect(withSummary({ en: 1 }).problems).toEqual([
      'v0.2.0.json: summary.en is no string',
    ]);
    expect(withSummary({ en: 'x', de: ['y'] }).problems).toEqual([
      'v0.2.0.json: summary.de is no string',
    ]);
    expect(withSummary('just text').problems).toEqual([
      'v0.2.0.json: summary is no object',
    ]);
    expect(withSummary(undefined).release?.summary).toBeNull();
    expect(withSummary({ en: '  ' }).release?.summary).toBeNull();
  });

  it('comes first, in the page’s language, with the links it builds itself', () => {
    const data = withSummary({
      en: 'What it is.\n\n- Run it: deploy/README.md\n- Read https://docs.example.org/guide',
      de: 'Was es ist.\n\n- Betrieb: deploy/README.md',
    }).release as Release;
    const en = html(data, 'en');
    expect(en.indexOf('What it is.')).toBeLessThan(en.indexOf('Security'));
    expect(en).toContain(
      `<li>Run it: <a class="text-fd-primary underline underline-offset-4 break-words" href="${REPO}/blob/v0.2.0/deploy/README.md">deploy/README.md</a></li>`,
    );
    expect(en).toContain('href="https://docs.example.org/guide"');
    const de = html(data, 'de');
    expect(de).toContain('<p>Was es ist.</p>');
    expect(de).not.toContain('What it is.');
  });

  it('shows the English one in an English section on the German page when there is no German one', () => {
    const data = withSummary({ en: 'What it is.' }).release as Release;
    const de = html(data, 'de');
    expect(de).toContain(
      '<p>Die Zusammenfassung dieser Version gibt es nur auf Englisch.</p><div data-summary="en" lang="en"><p>What it is.</p></div>',
    );
  });

  it('gives a release without pull requests its notes', () => {
    const data = checkRelease(
      {
        ...release('v0.1.0'),
        previous: null,
        groups: [],
        summary: { en: 'The first.' },
      },
      'v0.1.0.json',
    ).release as Release;
    const en = html(data, 'en');
    expect(en).toContain('<p>The first.</p>');
    expect(en).not.toContain('No change a user or operator would notice.');
    expect(releaseText(data).startsWith('The first.\n')).toBe(true);
  });

  it('shows markup as text and links only https addresses and repository paths', () => {
    const hostile = [
      '<script>globalThis.pwned = 1</script> {globalThis.pwned = 2}',
      '',
      '- [x](javascript:alert(1)) javascript:alert(1) http://plain.example',
      '- <img src=x onerror="globalThis.pwned = 3"> data:text/html,x',
      '- ![i](https://evil.example/i.png) ../../etc/passwd.txt',
    ].join('\n');
    const data = withSummary({ en: hostile, de: hostile }).release as Release;
    for (const lang of ['en', 'de'] as const) {
      const out = html(data, lang);
      expect(out).not.toMatch(/<script|<img|<[^>]*\son\w+=/i);
      for (const [, href = ''] of out.matchAll(/(?:href|src)="([^"]*)"/g))
        expect(
          href.startsWith(`${REPO}/`) ||
            href.startsWith('https://evil.example/'),
          href,
        ).toBe(true);
      expect(out).toContain(
        '[x](javascript:alert(1)) javascript:alert(1) http://plain.example',
      );
    }
    // Nothing of it reaches the MDX the site compiles.
    const page = renderChangelogPage([data], 'en');
    expect(page).not.toMatch(/pwned|javascript/);
  });
});

describe('the feed', () => {
  const releases = readReleases([file(release('v0.2.0'))])
    .releases as Release[];

  it('is Atom with an entry per release, its text plain and escaped', () => {
    const feed = renderFeed(releases, { siteUrl: 'https://docs.example.org' });
    expect(feed).toMatch(
      /^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/,
    );
    expect(feed).toContain(
      '<link rel="self" type="application/atom+xml" href="https://docs.example.org/changelog.xml"/>',
    );
    expect(feed).toContain('<updated>2026-11-21T00:00:00Z</updated>');
    expect(feed.match(/<entry>/g)).toHaveLength(1);
    expect(feed).toContain(
      '<id>https://docs.example.org/changelog/#v0.2.0</id>',
    );
    expect(releaseText(releases[0])).toContain(
      '- api: A public address answers as the public (#14) Severity: high. Advisory: GHSA-2C3M-X4P5-Q6R7.',
    );
    expect(releaseText(releases[0])).toContain('New settings: CCMS_B');
  });

  it('escapes markup and drops what XML cannot hold', () => {
    const hostile = readReleases([
      file(
        release('v0.2.0', {
          groups: [
            {
              title: 'New',
              items: [
                {
                  number: 1,
                  scope: null,
                  text: '<b>&</b>\u0001\u000b x \ud800',
                  severity: null,
                  advisory: null,
                },
              ],
            },
          ],
        }),
      ),
    ]).releases;
    const feed = renderFeed(hostile, { siteUrl: 'https://docs.example.org' });
    expect(feed).toContain('&lt;b&gt;&amp;&lt;/b&gt; x');
    for (const c of ['\u0001', '\u000b', '\ud800'])
      expect(feed).not.toContain(c);
  });

  it('is valid without releases', () => {
    const feed = renderFeed([], { siteUrl: 'https://docs.example.org' });
    expect(feed).not.toContain('<entry>');
    expect(feed).toContain('<updated>1970-01-01T00:00:00Z</updated>');
  });
});

it('reads every release of the repository’s own changelog/', () => {
  const dir = join(import.meta.dirname, '../../../changelog');
  if (!existsSync(dir)) return; // none before the first release
  const files = readdirSync(dir).map((name) => ({
    name,
    text: readFileSync(join(dir, name), 'utf8'),
  }));
  expect(readReleases(files).problems).toEqual([]);
});
