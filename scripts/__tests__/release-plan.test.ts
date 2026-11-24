// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CHANGELOG_HEADER,
  compareVersions,
  envSettings,
  groupOf,
  noteLine,
  parseArgs,
  parseChangelog,
  parseTitle,
  planRelease,
  plain,
  previousVersion,
  releaseConfig,
  releaseData,
  releaseSummary,
  renderNotes,
  runRelease,
  securityLine,
  settingChanges,
  updateChangelog,
  upgradeSection,
} from '@/scripts/release-plan.mjs';

const REPO = 'https://github.com/acme/app';
const RELEASE_YML = readFileSync(
  join(import.meta.dirname, '../../.github/release.yml'),
  'utf8',
);
const config = releaseConfig(RELEASE_YML);

type Pr = {
  number: number;
  title: string;
  labels?: { name: string }[];
  body?: string;
  mergeCommit?: string | null;
};
const pr = (number: number, title: string, extra: Partial<Pr> = {}): Pr => ({
  number,
  title,
  labels: [],
  body: '',
  ...extra,
});
const labelled = (...names: string[]) => names.map((name) => ({ name }));

describe('versions', () => {
  it('orders vX.Y.Z tags by number, not as text', () => {
    expect(compareVersions('v1.10.0', 'v1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.0', 'v0.1.0')).toBe(0);
  });

  it('finds the newest older release, ignoring what is no version tag', () => {
    expect(
      previousVersion(
        ['v0.1.0', 'v0.10.0', 'v0.2.0', 'v1.0.0-rc.1', 'nightly', 'v2.0.0'],
        'v1.0.0',
      ),
    ).toBe('v0.10.0');
    expect(previousVersion(['v1.0.0'], 'v1.0.0')).toBeNull();
  });
});

describe('the groups (.github/release.yml)', () => {
  it('has the five groups and leaves the internal labels out', () => {
    expect(config.categories.map((c) => c.title)).toEqual([
      'Security',
      'New',
      'Improved',
      'Fixed',
      'Docs',
    ]);
    expect(config.exclude).toEqual(['internal', 'chore']);
  });

  it('puts a pull request in the first group whose label it carries', () => {
    expect(
      groupOf(
        pr(1, 'fix(api): a check', { labels: labelled('bug', 'Security') }),
        config,
      ),
    ).toBe('Security');
    expect(
      groupOf(pr(2, 'feat: x', { labels: labelled('enhancement') }), config),
    ).toBe('Improved');
  });

  it('lets an excluded label win over every other', () => {
    expect(
      groupOf(
        pr(3, 'feat: x', { labels: labelled('feature', 'internal') }),
        config,
      ),
    ).toBeNull();
  });

  it('groups an unlabelled pull request by its title, leaving internal types out', () => {
    const of = (title: string) => groupOf(pr(4, title), config);
    expect(of('feat(editor): a page')).toBe('New');
    expect(of('fix: a crash')).toBe('Fixed');
    expect(of('perf(api): faster lists')).toBe('Improved');
    expect(of('docs: the guide')).toBe('Docs');
    expect(of('revert: the page')).toBe('Fixed');
    for (const type of ['test', 'chore', 'ci', 'build', 'refactor', 'style'])
      expect(of(`${type}(workflow): tooling`)).toBeNull();
    expect(of('A title without a type')).toBe('Improved');
    expect(of('fix(hooks,workflow): the guard')).toBeNull();
    expect(of('fix(api,workflow): both')).toBe('Fixed');
  });

  it('refuses a release.yml without groups', () => {
    expect(() => releaseConfig('changelog: {}\n')).toThrow(/no group/);
  });
});

describe('a line of the notes', () => {
  it('reads a conventional-commit title', () => {
    expect(parseTitle('feat(api,content)!: drop the old route')).toEqual({
      type: 'feat',
      scope: 'api,content',
      breaking: true,
      text: 'drop the old route',
    });
  });

  it('is the scope, the capitalised title and the pull request', () => {
    expect(noteLine(pr(649, 'feat(api): branding images (#559)'), REPO)).toBe(
      `**api:** Branding images (#559) ([#649](${REPO}/pull/649))`,
    );
    expect(noteLine(pr(7, 'fix: a crash'), REPO)).toBe(
      `A crash ([#7](${REPO}/pull/7))`,
    );
  });

  it('names no person: an @-mention loses its @, an email address and code stay', () => {
    expect(
      plain('thanks @someone, and @org/team; mail a@b.example, `@scope/pkg`'),
    ).toBe('thanks someone, and org/team; mail a@b.example, `@scope/pkg`');
    expect(plain('a -@user x.@other (@third)')).toBe('a -user x.other (third)');
    expect(plain('<!-- the template -->kept')).toBe('kept');
  });

  it('lists a security fix with its severity and advisory, nothing else from its body', () => {
    const line = securityLine(
      pr(12, 'fix(api): bind a code to its address', {
        body: 'Severity: High\nAdvisory GHSA-2c3m-x4p5-q6r7\n\nSteps to reproduce: send the code twice …',
      }),
      REPO,
    );
    expect(line).toBe(
      `**api:** Bind a code to its address ([#12](${REPO}/pull/12)) Severity: high. Advisory: [GHSA-2C3M-X4P5-Q6R7](${REPO}/security/advisories/GHSA-2C3M-X4P5-Q6R7).`,
    );
    expect(line).not.toMatch(/reproduce|twice/);
    expect(
      securityLine(pr(13, 'fix: x', { body: '**Severity:** medium' }), REPO),
    ).toMatch(/Severity: moderate\.$/);
  });
});

describe('upgrade notes', () => {
  it('takes a pull request body’s Upgrade notes section, up to the next heading', () => {
    const body = [
      '## What changed',
      'stuff',
      '## Upgrade notes',
      '<!-- what an operator does -->',
      'Move `CCMS_X` into `worker.env`.',
      '### Detail',
      'more',
      '## Checks',
      'none',
    ].join('\n');
    expect(upgradeSection(body)).toBe(
      'Move `CCMS_X` into `worker.env`.\n### Detail\nmore',
    );
    expect(upgradeSection('## What changed\nx')).toBe('');
  });

  it('keeps a code block whole: a `#` line in it is no heading', () => {
    const body = [
      '## Upgrade notes',
      '',
      '```sh',
      '# stop the worker first',
      'docker compose stop worker',
      '```',
      '',
      'Then start it.',
      '## Checks',
    ].join('\n');
    expect(upgradeSection(body)).toBe(
      '```sh\n# stop the worker first\ndocker compose stop worker\n```\n\nThen start it.',
    );
  });

  it('writes a note’s headings as bold text in Markdown, but not in a code block', () => {
    const notes = renderNotes(
      planRelease({
        version: 'v0.2.0',
        previous: 'v0.1.0',
        repoUrl: REPO,
        config,
        prs: [
          pr(1, 'feat: x', {
            body: '## Upgrade notes\n\n### Detail [#v0.2.0]\n\n~~~\n# a comment\n~~~\n',
          }),
        ],
        migrations: [],
        envBefore: '',
        envAfter: '',
      }),
    );
    expect(notes).toContain('  **Detail [#v0.2.0]**');
    expect(notes).toContain('  ~~~\n  # a comment\n  ~~~');
  });

  it('reads the settings of an .env.example, commented-out ones too', () => {
    const settings = envSettings(
      '# Section\n\n# What A is.\nCCMS_A=\n# B, two\n# lines\n# CCMS_B=3\nCCMS_C=x\n',
    );
    expect([...settings.keys()]).toEqual(['CCMS_A', 'CCMS_B', 'CCMS_C']);
    expect(settings.get('CCMS_B')).toEqual({
      comment: 'B, two\nlines',
      value: '3',
    });
  });

  it('reads a variable named in a comment’s prose as part of the comment', () => {
    const settings = envSettings(
      '# Which adapter: set\n# CCMS_SEARCH_ADAPTER=postgres and pgvector with it.\nCCMS_EMBEDDER_URL=\n',
    );
    expect([...settings.keys()]).toEqual(['CCMS_EMBEDDER_URL']);
    expect(settings.get('CCMS_EMBEDDER_URL')?.comment).toContain('pgvector');
  });

  it('finds the settings added, changed and removed', () => {
    expect(
      settingChanges(
        '# a\nCCMS_A=\n# b\nCCMS_B=1\n# gone\nCCMS_OLD=\n',
        '# a\nCCMS_A=\n# b, now with a range\nCCMS_B=1\n# new\nCCMS_NEW=\n',
      ),
    ).toEqual({
      added: ['CCMS_NEW'],
      changed: ['CCMS_B'],
      removed: ['CCMS_OLD'],
    });
  });
});

describe('the notes of a release', () => {
  const prs = [
    pr(10, 'feat(editor): a new page (#1)'),
    pr(11, 'fix: a crash'),
    pr(12, 'chore(workflow): the board'),
    pr(13, 'test: more e2e'),
    pr(14, 'fix(api): a public address answers as the public', {
      labels: labelled('security'),
      body: 'Severity: critical\n\nHow to exploit: …',
    }),
    pr(15, 'docs: the guide'),
    pr(16, 'feat(deploy)!: separate workers', {
      body: '## Upgrade notes\n\nMove `CCMS_PDF_WORKERS` into `worker.env`.\n\n## Checks\n',
    }),
    pr(17, 'chore(deploy): compose tweak', {
      labels: labelled('upgrade-note'),
    }),
  ];
  const plan = (previous: string | null) =>
    planRelease({
      version: 'v0.2.0',
      previous,
      repoUrl: REPO,
      config,
      prs,
      migrations: [
        'backend/api/migrations/0057_email_code_sent_to.sql',
        'backend/api/migrations/0056_search_sweep.sql',
      ],
      envBefore: '# a\nCCMS_A=\n',
      envAfter: '# a\nCCMS_A=\n# b\nCCMS_B=\n',
    });

  it('groups the pull requests and leaves the internal ones out', () => {
    const notes = renderNotes(plan('v0.1.0'));
    expect(notes).toMatch(/^### Security\n\n- \*\*api:\*\* A public address/);
    expect(notes).toContain('### New\n\n- **editor:** A new page (#1)');
    expect(notes).toContain(`### Fixed\n\n- A crash ([#11](${REPO}/pull/11))`);
    expect(notes).toContain('### Docs');
    expect(notes).not.toContain('Improved');
    expect(notes).not.toMatch(/the board|more e2e|How to exploit/);
    expect(notes).toContain('Severity: critical.');
  });

  it('lists the upgrade notes: breaking changes, migrations, settings, the pull requests’', () => {
    const notes = renderNotes(plan('v0.1.0'));
    const upgrade = notes.slice(notes.indexOf('### Upgrade notes'));
    expect(upgrade).toContain(
      `From v0.1.0: take a backup first and follow [Upgrades](${REPO}/blob/v0.2.0/deploy/README.md#upgrades)`,
    );
    expect(upgrade).toContain(
      '**Breaking changes:**\n\n- **deploy:** Separate workers',
    );
    expect(upgrade).toContain(
      '- `0056_search_sweep`\n- `0057_email_code_sent_to`',
    );
    expect(upgrade).toContain('- New: `CCMS_B`');
    expect(upgrade).toContain('Move `CCMS_PDF_WORKERS` into `worker.env`.');
    // Left out of the groups as internal, but its label asks for an upgrade note.
    expect(upgrade).toContain('**deploy:** Compose tweak');
  });

  it('says a first release has nothing to upgrade from', () => {
    const notes = renderNotes(plan(null));
    expect(notes).toContain(
      'The first release: there is nothing to upgrade from.',
    );
    expect(notes).not.toContain('0056_search_sweep');
  });

  it('says so when there is nothing to do', () => {
    const notes = renderNotes(
      planRelease({
        version: 'v0.2.1',
        previous: 'v0.2.0',
        repoUrl: REPO,
        config,
        prs: [pr(20, 'chore: x')],
        migrations: [],
        envBefore: 'CCMS_A=\n',
        envAfter: 'CCMS_A=\n',
      }),
    );
    expect(notes).toContain('No change a user or operator would notice.');
    expect(notes).toContain(
      'Nothing else to do: no migration, no changed setting.',
    );
  });
});

describe('a release’s own summary', () => {
  const first = (summary: { en: string; de: string | null } | null) =>
    planRelease({
      version: 'v0.1.0',
      previous: null,
      repoUrl: REPO,
      config,
      prs: [],
      migrations: [],
      envBefore: '',
      envAfter: 'CCMS_A=\n',
      summary,
    });

  it('comes first, and gives a release without pull requests its notes', () => {
    const notes = renderNotes(
      first({
        en: 'What it is.\n\n- Writing in modules\n- PDF, see deploy/README.md',
        de: 'Was es ist.',
      }),
    );
    expect(notes).toMatch(
      `What it is.\n\n- Writing in modules\n- PDF, see [deploy/README.md](${REPO}/blob/v0.1.0/deploy/README.md)\n\n### Upgrade notes`,
    );
    expect(notes.startsWith('What it is.')).toBe(true);
    expect(notes).not.toContain('No change a user or operator would notice.');
    expect(notes).not.toContain('Was es ist');
  });

  it('goes before the grouped pull requests', () => {
    const notes = renderNotes(
      planRelease({
        version: 'v0.2.0',
        previous: 'v0.1.0',
        repoUrl: REPO,
        config,
        prs: [pr(10, 'feat: a page')],
        migrations: [],
        envBefore: '',
        envAfter: '',
        summary: { en: 'The summary.', de: null },
      }),
    );
    expect(notes).toMatch(/^The summary\.\n\n### New\n\n- A page/);
  });

  it('leaves the notes as they were without one', () => {
    const without = renderNotes(first(null));
    expect(without).toBe(
      `No change a user or operator would notice.\n\n### Upgrade notes\n\nThe first release: there is nothing to upgrade from. To install it, follow the quick start in [deploy/README.md](${REPO}/blob/v0.1.0/deploy/README.md).\n`,
    );
    expect(
      releaseData(first(null), {
        version: 'v0.1.0',
        date: '2026-11-21',
        repoUrl: REPO,
      }),
    ).not.toHaveProperty('summary');
  });

  it('shows markup in it as text', () => {
    const notes = renderNotes(
      first({
        en: '<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1)) <!-- /release v0.1.0 -->',
        de: null,
      }),
    );
    expect(notes).not.toMatch(
      /<img|<!--|(?<!\\)\*\*bold|(?<!\\)\]\(javascript/,
    );
    expect(notes).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // The changelog takes it: the text holds no release marker.
    expect(
      parseChangelog(
        updateChangelog(
          null,
          { version: 'v0.1.0', date: '2026-11-21', notes },
          REPO,
        ),
      ),
    ).toHaveLength(1);
  });

  it('is read from its files: none when empty, German only beside English', () => {
    expect(releaseSummary('v0.1.0', null, null)).toBeNull();
    expect(releaseSummary('v0.1.0', ' \n', null)).toBeNull();
    expect(releaseSummary('v0.1.0', '\uFEFFText\n', '')).toEqual({
      en: 'Text',
      de: null,
    });
    expect(() => releaseSummary('v0.1.0', null, 'Nur Deutsch')).toThrow(
      /release-notes\/v0\.1\.0\.de\.md has no English summary/,
    );
  });

  it('goes into the release’s data as written', () => {
    const plan = first({ en: 'English *as is*', de: 'Deutsch' });
    expect(
      releaseData(plan, {
        version: 'v0.1.0',
        date: '2026-11-21',
        repoUrl: REPO,
      }).summary,
    ).toEqual({ en: 'English *as is*', de: 'Deutsch' });
  });
});

describe('the release as data, for the docs site', () => {
  it('holds every text from a pull request as a plain string, and no author', () => {
    const plan = planRelease({
      version: 'v0.2.0',
      previous: 'v0.1.0',
      repoUrl: REPO,
      config,
      prs: [
        pr(10, 'feat(editor): a `<b>` page by @someone'),
        pr(14, 'fix(api): a check', {
          labels: labelled('security', 'upgrade-note'),
          body: 'Severity: high\nGHSA-2c3m-x4p5-q6r7\n\n## Upgrade notes\n\nThe exploit works like this.',
        }),
        pr(16, 'feat(deploy)!: workers', {
          body: '## Upgrade notes\n\nMove `X`.',
        }),
      ],
      migrations: ['backend/api/migrations/0058_x.sql'],
      envBefore: '',
      envAfter: '# b\nCCMS_B=\n',
    });
    const data = releaseData(plan, {
      version: 'v0.2.0',
      date: '2026-11-21',
      repoUrl: REPO,
    });
    expect(data).toEqual({
      version: 'v0.2.0',
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
              text: 'A check',
              severity: 'high',
              advisory: 'GHSA-2C3M-X4P5-Q6R7',
            },
          ],
        },
        {
          title: 'New',
          items: [
            { number: 10, scope: 'editor', text: 'A `<b>` page by someone' },
            { number: 16, scope: 'deploy', text: 'Workers' },
          ],
        },
      ],
      upgrade: {
        breaking: [{ number: 16, scope: 'deploy', text: 'Workers' }],
        migrations: ['0058_x'],
        settings: { added: ['CCMS_B'], changed: [], removed: [] },
        // The security fix's upgrade section stays out: only its title, through its label.
        notes: [
          { number: 14, scope: 'api', text: 'A check', note: '' },
          { number: 16, scope: 'deploy', text: 'Workers', note: 'Move `X`.' },
        ],
      },
    });
    expect(JSON.stringify(data)).not.toContain('exploit');
  });
});

describe('CHANGELOG.md', () => {
  const release = (version: string, date = '2026-11-21') => ({
    version,
    date,
    notes: `### Fixed\n\n- ${version}'s fix\n\n### Upgrade notes\n\nNone.\n`,
  });

  it('starts with its header and holds one entry per release, newest first', () => {
    let text = updateChangelog(null, release('v0.1.0', '2026-11-01'), REPO);
    text = updateChangelog(text, release('v0.10.0'), REPO);
    text = updateChangelog(text, release('v0.2.0', '2026-11-10'), REPO);
    expect(text.startsWith(CHANGELOG_HEADER)).toBe(true);
    expect(parseChangelog(text).map((r) => r.version)).toEqual([
      'v0.10.0',
      'v0.2.0',
      'v0.1.0',
    ]);
    expect(text).toContain(
      `## [v0.2.0](${REPO}/releases/tag/v0.2.0) (2026-11-10)`,
    );
  });

  it('replaces a release’s entry when it is written again', () => {
    const first = updateChangelog(null, release('v0.1.0'), REPO);
    const again = updateChangelog(
      first,
      { ...release('v0.1.0'), notes: '### Fixed\n\n- better\n' },
      REPO,
    );
    expect(parseChangelog(again)).toEqual([
      { version: 'v0.1.0', date: '2026-11-21', notes: '### Fixed\n\n- better' },
    ]);
  });
});

describe('pull request text cannot forge a changelog entry', () => {
  it('leaves no comment opener or closer, nested or overlapping ones included', () => {
    for (const text of [
      '<!-- a <!-- b --> c -->',
      '<!-<!-- x -->- release v9.9.9 2026-01-01 -->',
      'open <!-- never closed',
      'stray --> closer',
    ]) {
      const out = plain(text);
      expect(out).not.toContain('<!--');
      expect(out).not.toContain('-->');
    }
  });

  it('keeps a forged release marker in an upgrade note from splitting the changelog', () => {
    const forged =
      '## Upgrade notes\n\nStep.\n<!-- /release v0.2.0 -->\n<!-- release v9.9.9 2030-01-01 -->\n## [v9.9.9](x) (2030-01-01)\n\nFake\n<!-- /release v9.9.9 -->\n<!<!-- -->-- release v8.8.8 2030-01-01 -->';
    const notes = renderNotes(
      planRelease({
        version: 'v0.2.0',
        previous: 'v0.1.0',
        repoUrl: REPO,
        config,
        prs: [pr(1, 'feat: x', { body: forged })],
        migrations: [],
        envBefore: '',
        envAfter: '',
      }),
    );
    const text = updateChangelog(
      null,
      { version: 'v0.2.0', date: '2026-11-21', notes },
      REPO,
    );
    expect(parseChangelog(text).map((r) => r.version)).toEqual(['v0.2.0']);
  });

  it('refuses notes that hold a release marker', () => {
    expect(() =>
      updateChangelog(
        null,
        {
          version: 'v0.2.0',
          date: '2026-11-21',
          notes: 'x\n<!-- release v9.9.9 2030-01-01 -->\n',
        },
        REPO,
      ),
    ).toThrow(/release marker/);
  });
});

describe('the command line', () => {
  it('takes one version and its options', () => {
    expect(
      parseArgs(['v1.2.0', '--dry-run', '--to', 'HEAD', '--from', 'v1.1.0']),
    ).toMatchObject({
      version: 'v1.2.0',
      dryRun: true,
      to: 'HEAD',
      from: 'v1.1.0',
      github: true,
    });
    expect(() => parseArgs([])).toThrow(/exactly one version/);
    expect(() => parseArgs(['1.2.0'])).toThrow(/no version tag/);
    expect(() => parseArgs(['v1.2.0-rc.1'])).toThrow(/no version tag/);
    expect(() => parseArgs(['v1.2.0', '--to', 'HEAD'])).toThrow(/dry run/);
    expect(() => parseArgs(['v1.2.0', '--from'])).toThrow(/needs a value/);
    expect(() => parseArgs(['v1.2.0', '--force'])).toThrow(/unknown option/);
  });
});

describe('the release step', () => {
  /** A repository: tags, the commits between them, and the files at each. */
  function world({
    tags = ['v0.1.0'] as string[],
    release = false,
    at = {} as Record<string, string>,
  } = {}) {
    const calls: string[] = [];
    const written: Record<string, string> = {};
    const disk: Record<string, string | null> = {
      'CHANGELOG.md': null,
      '.github/release.yml': RELEASE_YML,
    };
    const show: Record<string, string> = {
      'c1:.env.example': '# a\nCCMS_A=\n',
      'c2:.env.example': '# a\nCCMS_A=\n# b\nCCMS_B=\n',
      ...at,
    };
    const git = (args: string[]) => {
      const key = args.join(' ');
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)!.replace('^{commit}', '');
        return { 'v0.1.0': 'c1', 'v0.2.0': 'c2', HEAD: 'c2' }[ref] ?? '';
      }
      if (args[0] === 'tag') return tags.join('\n');
      if (args[0] === 'rev-list')
        return key.endsWith('c1..c2') ? 'c2\nm1\nm2\n' : 'c2\nm1\nm2\nc1\nm0\n';
      if (args[0] === 'log')
        return args[2] === '--format=%cI'
          ? '2026-11-01T10:00:00+01:00'
          : '2026-11-21';
      if (args[0] === 'diff')
        return 'backend/api/migrations/0058_x.sql\nbackend/api/migrations/meta/_journal.json\n';
      if (args[0] === 'show') return show[args[1]];
      throw new Error(`unexpected git ${key}`);
    };
    const gitOk = (args: string[]) => {
      if (args[0] === 'rev-parse')
        return tags.includes(args.at(-1)!.replace('refs/tags/', ''));
      if (args[0] === 'cat-file') return args[2] in show;
      return false;
    };
    const github = {
      repo: () => ({ url: REPO }),
      mergedPullRequests: () => {
        calls.push('list');
        return [
          { ...pr(30, 'feat: in this release'), mergeCommit: 'm1' },
          { ...pr(31, 'fix: in this release too'), mergeCommit: 'm2' },
          { ...pr(29, 'feat: in the last release'), mergeCommit: 'm0' },
          { ...pr(28, 'feat: not merged into main'), mergeCommit: 'elsewhere' },
        ];
      },
      hasRelease: () => release,
      createRelease: (tag: string, notes: string) =>
        calls.push(`create ${tag}\n${notes}`),
      editRelease: (tag: string, notes: string) =>
        calls.push(`edit ${tag}\n${notes}`),
    };
    const files = {
      read: (path: string) => disk[path] ?? null,
      write: (path: string, text: string) => {
        written[path] = text;
      },
    };
    const log: string[] = [];
    const run = (argv: string[]) =>
      runRelease(argv, {
        git,
        gitOk,
        github,
        files,
        log: (l: string) => log.push(l),
      });
    return { run, calls, written, log };
  }

  it('dry-runs a tag that does not exist yet: prints the notes, writes nothing', () => {
    const w = world();
    const notes = w.run(['v0.2.0', '--dry-run', '--to', 'HEAD']);
    expect(notes).toContain('In this release');
    expect(notes).toContain('In this release too');
    expect(notes).not.toMatch(/last release|not merged/);
    expect(notes).toContain('`0058_x`');
    expect(notes).not.toContain('_journal');
    expect(notes).toContain('New: `CCMS_B`');
    expect(w.calls).toEqual(['list']);
    expect(w.written).toEqual({});
    expect(w.log.join('\n')).toContain('from v0.1.0: 2 pull request(s) merged');
  });

  it('writes the dry run’s changelog only where --changelog says', () => {
    const w = world();
    w.run([
      'v0.2.0',
      '--dry-run',
      '--to',
      'HEAD',
      '--changelog',
      '/tmp/preview.md',
    ]);
    expect(Object.keys(w.written)).toEqual(['/tmp/preview.md']);
    expect(parseChangelog(w.written['/tmp/preview.md'])[0]).toMatchObject({
      version: 'v0.2.0',
      date: '2026-11-21',
    });
  });

  it('refuses a real run without the tag', () => {
    expect(() => world().run(['v0.2.0'])).toThrow(/no tag v0.2.0/);
  });

  it('creates the GitHub Release and writes CHANGELOG.md on a tag', () => {
    const w = world({ tags: ['v0.1.0', 'v0.2.0'] });
    const notes = w.run(['v0.2.0']);
    expect(w.calls[1]).toBe(`create v0.2.0\n${notes}`);
    expect(parseChangelog(w.written['CHANGELOG.md'])).toHaveLength(1);
    expect(JSON.parse(w.written['changelog/v0.2.0.json'])).toMatchObject({
      version: 'v0.2.0',
      date: '2026-11-21',
      repository: REPO,
      previous: 'v0.1.0',
    });
  });

  it('updates the GitHub Release when it is there', () => {
    const w = world({ tags: ['v0.1.0', 'v0.2.0'], release: true });
    w.run(['v0.2.0']);
    expect(w.calls[1]).toMatch(/^edit v0\.2\.0\n/);
  });

  it('writes only the changelog with --no-github', () => {
    const w = world({ tags: ['v0.1.0', 'v0.2.0'] });
    w.run(['v0.2.0', '--no-github']);
    expect(w.calls).toHaveLength(1);
    expect(Object.keys(w.written)).toEqual([
      'CHANGELOG.md',
      'changelog/v0.2.0.json',
    ]);
  });

  it('puts the summary its commit holds first, and into the data', () => {
    const w = world({
      tags: ['v0.1.0', 'v0.2.0'],
      at: {
        'c2:release-notes/v0.2.0.md': 'Two things, see deploy/README.md.\n',
        'c2:release-notes/v0.2.0.de.md': 'Zwei Dinge.\n',
        'c2:deploy/README.md': '# Deploy',
      },
    });
    const notes = w.run(['v0.2.0']);
    expect(notes).toMatch(
      `Two things, see [deploy/README.md](${REPO}/blob/v0.2.0/deploy/README.md).\n\n### New`,
    );
    expect(notes.startsWith('Two things')).toBe(true);
    expect(JSON.parse(w.written['changelog/v0.2.0.json']).summary).toEqual({
      en: 'Two things, see deploy/README.md.',
      de: 'Zwei Dinge.',
    });
    expect(w.log[0]).toContain('a summary (English and German)');
  });

  it('refuses a summary linking to a file the release does not hold', () => {
    const w = world({
      tags: ['v0.1.0', 'v0.2.0'],
      at: { 'c2:release-notes/v0.2.0.md': 'See docs/gone.md.' },
    });
    expect(() => w.run(['v0.2.0'])).toThrow(
      'release-notes/v0.2.0.md links to docs/gone.md, which v0.2.0 does not hold',
    );
  });

  it('takes every pull request up to a first release', () => {
    const w = world({ tags: [] });
    const notes = w.run(['v0.2.0', '--dry-run', '--to', 'HEAD']);
    expect(w.calls).toEqual(['list']);
    expect(notes).toContain('In the last release');
    expect(notes).toContain('The first release');
  });
});
