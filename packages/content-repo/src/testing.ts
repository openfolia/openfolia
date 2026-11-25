import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PageDesign,
  parsePageDesign,
  printPageDesign,
  printModule,
  printTranslationRecord,
  translationRecordOf,
  type Module,
} from '@openfolia/content-model';
import { refsMoved } from './lib/git.js';

/**
 * Test helper: creates a content repository, in a new temporary directory
 * unless `target` names one (which must not exist yet or be empty).
 * History: commit 1 (tagged `v1`), then commit 2 on `main` changing the
 * intro text and adding the German translation's record (made from commit
 * 1's English text, so its intro is outdated and its image up to date); branch `draft` adds a broken module and one without an
 * audience on top, and lists both and the safety note in the manual (the
 * module without an audience in a group, under a condition on an attribute
 * that is not configured). Two manuals: the operating manual (public) and the
 * service manual (internal), so there is one to switch to.
 */
export function createSampleRepo(target?: string): {
  dir: string;
  commits: { v1: string; main: string; draft: string };
} {
  let dir: string;
  if (target === undefined) {
    dir = mkdtempSync(join(tmpdir(), 'openfolia-repo-'));
  } else {
    if (existsSync(target) && readdirSync(target).length > 0) {
      throw new Error(`${target} already exists and is not empty`);
    }
    mkdirSync(target, { recursive: true });
    dir = target;
  }
  const template = sampleTemplate();
  cpSync(sampleWorkTree(template), dir, { recursive: true });
  return { dir, commits: { ...template.commits } };
}

/**
 * The sample repository, bare, and a work tree cloned from it once one is asked for, built once
 * per process and copied by `createSampleRepo` and `createBareSampleRepo`: many tests make one
 * each, and on a loaded machine every `git` process is a noticeable wait (#615), so the bare one
 * takes four (`git init`, a `git fast-import` per commit) and the work tree three more. A copy is the
 * same repository, so its commits are the same too, as they already were for two repositories
 * made in the same second. Its folder names the process (`openfolia-sample-<pid>-…`): Vitest stops
 * its workers with a signal, so no exit handler runs there, and the next process to build one
 * removes those of processes that are gone; an exit handler removes it otherwise.
 */
let template:
  | {
      root: string;
      bare: string;
      work?: string;
      commits: { v1: string; main: string; draft: string };
    }
  | undefined;

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sampleTemplate(): NonNullable<typeof template> {
  if (template !== undefined) return template;
  removeOrphanTemplates();
  const root = mkdtempSync(join(tmpdir(), `openfolia-sample-${process.pid}-`));
  try {
    const bare = join(root, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], {
      env: { ...process.env, ...GIT_ENV },
    });
    template = { root, bare, commits: buildSampleRepo(bare) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  return template;
}

/** The template's work tree: `main` checked out, `draft` a local branch too, no remote. */
function sampleWorkTree(sample: NonNullable<typeof template>): string {
  if (sample.work !== undefined) return sample.work;
  const work = join(sample.root, 'work');
  const env = { ...process.env, ...GIT_ENV };
  execFileSync('git', ['clone', '-q', sample.bare, work], { env });
  execFileSync(
    'git',
    ['-C', work, 'branch', '-q', '--no-track', 'draft', 'origin/draft'],
    { env },
  );
  // A repository of its own, not a clone that follows the template it came from.
  execFileSync('git', ['-C', work, 'remote', 'remove', 'origin'], { env });
  sample.work = work;
  return work;
}

/** Removes the sample templates of processes that are gone (`sampleTemplate`). */
function removeOrphanTemplates(): void {
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    const pid = /^openfolia-sample-(\d+)-/.exec(name)?.[1];
    if (pid === undefined || Number(pid) === process.pid) continue;
    try {
      process.kill(Number(pid), 0);
      continue; // still running
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
    }
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {
      // Another user's, in a shared temporary folder: not ours to remove, and no reason to fail.
    }
  }
}

/** Builds the sample repository of `createSampleRepo` in `dir`, an empty bare repository. */
function buildSampleRepo(dir: string): {
  v1: string;
  main: string;
  draft: string;
} {
  let files: { path: string; content: string | Buffer }[] = [];
  const write = (path: string, content: string | Buffer) => {
    files.push({ path, content });
  };
  const commit = (
    message: string,
    branch: string,
    parent: string | null,
    tag?: { name: string; message: string },
  ) => {
    const { commit: made } = sampleCommit(dir, {
      branch,
      parent,
      changes: files,
      message,
      author: { name: 'Test', email: 'test@example.com' },
      tag,
    });
    files = [];
    return made;
  };

  write('openfolia.yaml', CONFIG);
  write(
    'modules/en/charging.adoc',
    printModule(charging('The {product-name} charges itself.')),
  );
  write(
    'modules/de/charging.adoc',
    printModule({
      ...charging('Das {product-name} lädt sich selbst.'),
      meta: {
        ...charging('').meta,
        title: 'Laden',
        lang: 'de',
        keywords: ['Wartung', 'Akku'],
      },
    }),
  );
  write('modules/en/safety-note.adoc', printModule(safetyNote));
  write('modules/en/internals.adoc', printModule(internals));
  write('manuals/operating.yaml', MANUAL);
  write('manuals/service.yaml', SERVICE_MANUAL);
  write(`assets/${PNG_HASH}`, PNG);
  write('symbols/w001.svg', SYMBOL_SVG);
  const v1 = commit('first', 'main', null, {
    name: 'v1',
    message: 'release 1',
  });

  write(
    'modules/en/charging.adoc',
    printModule(charging('The {product-name} charges automatically.')),
  );
  // The German translation was made from the first commit's English text:
  // its intro is outdated now, its image's alt text up to date.
  write(
    'modules/de/charging.translation.yaml',
    printTranslationRecord(
      translationRecordOf(charging('The {product-name} charges itself.'), v1),
    ),
  );
  const main = commit('second', 'main', v1);

  write('modules/en/broken.adoc', ':schema-version: 1\nthis is not a module\n');
  write('modules/en/unlabelled.adoc', printModule(unlabelled));
  write(
    'manuals/operating.yaml',
    MANUAL.replace(
      '  - module: charging',
      [
        '  - module: charging',
        '  - module: broken',
        '  - module: safety-note',
        '  - title: Service',
        '    entries:',
        '      - module: unlabelled',
        '        when: colour in (red)',
      ].join('\n'),
    ),
  );
  const draft = commit('draft', 'draft', main);

  return { v1, main, draft };
}

/**
 * The same repository as `createSampleRepo`, but bare (no working tree, so
 * no branch is checked out): what a server that writes to the repository
 * uses, since `GitWriter` refuses to move a checked-out branch. In a new
 * temporary directory unless `target` names one (which must not exist yet
 * or be empty).
 */
export function createBareSampleRepo(target?: string): {
  dir: string;
  commits: { v1: string; main: string; draft: string };
} {
  if (target !== undefined && existsSync(target)) {
    if (readdirSync(target).length > 0) {
      throw new Error(`${target} already exists and is not empty`);
    }
    rmSync(target, { recursive: true });
  }
  const template = sampleTemplate();
  const dir = target ?? mkdtempSync(join(tmpdir(), 'openfolia-bare-'));
  cpSync(template.bare, dir, { recursive: true });
  return { dir, commits: { ...template.commits } };
}

/**
 * A commit of `changes` on `branch`, on top of `parent`, as the sample helpers below make it:
 * one `git fast-import` instead of the writer's two dozen `git` processes, which on a loaded
 * machine made a fixture of a few commits take longer than a test hook may (#615). The branch
 * moves only if the new commit follows on from where it points (fast-import refuses anything
 * else). Content only, no deletions; the sample's paths need no quoting. Unlike the writer it
 * would move a branch checked out in a work tree: the helpers are for bare repositories.
 */
function sampleCommit(
  dir: string,
  request: {
    branch: string;
    /** `null`: the first commit of the branch. */
    parent: string | null;
    changes: readonly { path: string; content: string | Uint8Array }[];
    message: string;
    author: { name: string; email: string };
    /** An annotated tag on the new commit. */
    tag?: { name: string; message: string };
  },
): { commit: string } {
  const { name, email } = request.author;
  const who = `${name} <${email}> ${Math.floor(Date.now() / 1000)} +0000`;
  const parts: Buffer[] = [];
  const line = (text: string) => parts.push(Buffer.from(`${text}\n`));
  const data = (content: string | Uint8Array) => {
    const bytes = Buffer.from(content);
    line(`data ${bytes.length}`);
    parts.push(bytes);
    line('');
  };
  line('feature get-mark');
  line(`commit refs/heads/${request.branch}`);
  line('mark :1');
  line(`author ${who}`);
  line(`committer ${who}`);
  data(`${request.message}\n`);
  if (request.parent !== null) line(`from ${request.parent}`);
  for (const { path, content } of request.changes) {
    if (!/^[\w./-]+$/.test(path)) throw new Error(`unsupported path ${path}`);
    line(`M 100644 inline ${path}`);
    data(content);
  }
  if (request.tag) {
    if (!/^[\w.-]+$/.test(request.tag.name)) {
      throw new Error(`unsupported tag ${request.tag.name}`);
    }
    line(`tag ${request.tag.name}`);
    line('from :1');
    line(`tagger ${who}`);
    data(`${request.tag.message}\n`);
  }
  line('get-mark :1');
  let commit: string;
  try {
    commit = execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], {
      input: Buffer.concat(parts),
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    }).trim();
  } finally {
    // As the writer does: a read after this write, in this process, sees it.
    refsMoved(dir);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`fast-import gave no commit: ${commit}`);
  }
  return { commit };
}

/** The snippet type `addSampleSnippets` adds to the sample's configuration. */
export const SAMPLE_SNIPPET_TYPE = 'snippet';

/**
 * Adds snippets to a sample repository (bare or not) in one commit on
 * `main`: a module type marked `snippet: true` in `openfolia.yaml`, a public
 * snippet in English and German (`wear-gloves`) and an internal one in
 * English (`trained-staff`). Kept out of `createSampleRepo`, whose content
 * many tests count; the local sample (`setup-local`) has them. Resolves to
 * the new commit.
 */
export async function addSampleSnippets(dir: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  const config = git('show', 'main:openfolia.yaml');
  const types = '  - { id: procedure, label: Procedure }\n';
  if (!config.includes(types)) throw new Error('not the sample configuration');
  const snippet = (
    id: string,
    lang: string,
    title: string,
    text: string,
    audience: string,
  ): { path: string; content: string } => ({
    path: `modules/${lang}/${id}.adoc`,
    content: printModule({
      schemaVersion: 1,
      id,
      meta: { title, type: SAMPLE_SNIPPET_TYPE, lang, audience, facets: {} },
      blocks: [
        {
          type: 'paragraph',
          id: 'text',
          content: [{ type: 'text', text }],
        },
      ],
    }),
  });
  const { commit } = sampleCommit(dir, {
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'openfolia.yaml',
        content:
          config.replace(
            types,
            `${types}  - { id: ${SAMPLE_SNIPPET_TYPE}, label: Snippet, snippet: true }\n`,
          ) + '\n',
      },
      snippet(
        'wear-gloves',
        'en',
        'Wear gloves',
        'Wear protective gloves when you touch the battery terminals.',
        'public',
      ),
      snippet(
        'wear-gloves',
        'de',
        'Handschuhe tragen',
        'Tragen Sie Schutzhandschuhe, wenn Sie die Batteriepole berühren.',
        'public',
      ),
      snippet(
        'trained-staff',
        'en',
        'Trained staff only',
        'Only trained service staff may open the housing.',
        'internal',
      ),
    ],
    message: 'Add snippets',
    author: { name: 'Test', email: 'test@example.com' },
  });
  return commit;
}

/**
 * The style rules `addSampleTerms` adds to `openfolia.yaml` (#55): English, a phrase the sample's
 * `storage` module uses, a pattern and the longest sentence.
 */
export const SAMPLE_STYLE_RULES = `styleRules:
  en:
    maxSentenceWords: 30
    rules:
      - id: dry-place
        words: in a dry place
        message: Name the storage conditions, such as the temperature range.
      - id: utilise
        pattern: '\\butili[sz]e\\b'
        message: Write “use”.
        replacement: use
`;

/** The terms `addSampleTerms` adds, by ID: `terms/<id>.yaml` as stored. */
export const SAMPLE_TERMS: Readonly<Record<string, string>> = {
  battery: `schemaVersion: 1
status: approved
domain: power
languages:
  de:
    preferred: Akku
    allowed:
      - term: Batterie
    definition: Der aufladbare Energiespeicher des Fahrzeugs.
  en:
    preferred: battery
    forbidden:
      - term: accumulator
    definition: The rechargeable energy store that powers the vehicle.
`,
  charger: `schemaVersion: 1
status: approved
domain: charging
languages:
  de:
    preferred: Ladegerät
    forbidden:
      - term: Lader
    definition: Das Gerät, das den **Akku** lädt.
  en:
    preferred: charger
    allowed:
      - term: charging unit
    forbidden:
      - term: loader
        note: Reads as a machine that loads goods.
    definition: The device that charges the **battery**.
    usage: Name it in full on first use.
  fr:
    preferred: chargeur
`,
  housing: `schemaVersion: 1
status: proposed
domain: mechanics
languages:
  en:
    preferred: housing
    forbidden:
      - term: casing
    definition: The outer shell around the electronics.
`,
  'power-pack': `schemaVersion: 1
status: deprecated
domain: power
replacedBy: battery
languages:
  en:
    preferred: power pack
    definition: An older name for the battery.
`,
};

/**
 * Adds terms to a sample repository (bare or not) in one commit on `main`:
 * `SAMPLE_TERMS` (an approved, a proposed and a deprecated one, replaced by
 * another) and a public English module, `storage`, whose text uses a
 * forbidden variant ("loader", of `charger`) and links two terms (#245);
 * the operating manual includes it and has a glossary; and the English
 * style rules `SAMPLE_STYLE_RULES` in `openfolia.yaml` (#55), one of which the
 * `storage` text matches ("in a dry place"). Kept out of
 * `createSampleRepo`, whose content many tests count; the local sample
 * (`setup-local`) has them. Resolves to the new commit.
 */
/**
 * The page designs `addSamplePageDesigns` adds (#390), by ID: `design/<id>.yaml` as stored.
 * `classic` is complete and valid (its logo is not stored: the API's checks report it);
 * `minimal` is the least a design file holds.
 */
export const SAMPLE_PAGE_DESIGNS: Readonly<Record<string, string>> = {
  classic: printPageDesign(
    PageDesign.parse({
      schemaVersion: 1,
      id: 'classic',
      name: 'Classic',
      preset: 'classic',
      colours: { primary: '#1f4e79', accent: '#b45309', text: '#1f2328' },
      logo: { light: `sha256:${'1'.repeat(64)}` },
      titlePage: { fields: ['title', 'variant', 'language', 'date'] },
      regions: {
        'above-title': {
          en: [
            {
              type: 'paragraph',
              id: 'intro',
              content: [
                { type: 'text', text: 'Instructions for ' },
                { type: 'attribute', name: 'product-name' },
              ],
            },
          ],
          de: [
            {
              type: 'paragraph',
              id: 'intro',
              content: [
                { type: 'text', text: 'Anleitung für ' },
                { type: 'attribute', name: 'product-name' },
              ],
            },
          ],
        },
        footer: [
          {
            type: 'paragraph',
            id: 'release',
            content: [{ type: 'placeholder', key: 'release' }],
          },
        ],
      },
      backPage: {},
    }),
  ),
  minimal: [
    'schemaVersion: 1',
    'name: Minimal',
    'preset: minimal',
    'colours:',
    '  primary: "#333333"',
    '  accent: "#555555"',
    '  text: "#111111"',
    '',
  ].join('\n'),
};

/**
 * Invented manufacturer details (#395) for a sample configuration's `manufacturer`: what the
 * `classic` sample design's back page prints once a test sets them.
 */
export const SAMPLE_MANUFACTURER = {
  name: 'Example Works Ltd',
  address: ['1 Sample Street', '12345 Sample Town'],
  contact: 'info@example.com',
  website: 'https://example.com',
};

/** The page design `addSampleSafetyLeaflet` adds and the leaflet names (#668): `design/<id>.yaml`. */
export const SAMPLE_LEAFLET_DESIGN_ID = 'leaflet';

/**
 * A leaflet's page design (#668), `design/leaflet.yaml` as stored: A5 portrait, the `minimal`
 * preset (the title and its fields only), small type and margins, unnumbered headings and no
 * page break before each module, so a few safety messages share a page; safety messages are kept
 * whole on a page, as in every design. English, German and French texts.
 */
export const SAMPLE_LEAFLET_DESIGN = printPageDesign(
  parsePageDesign(
    [
      'schemaVersion: 1',
      'name: Safety leaflet',
      'preset: minimal',
      'page:',
      '  size: a5',
      '  margins: { top: 15, right: 13, bottom: 15, left: 13 }',
      'colours:',
      '  primary: "#1f4e79"',
      '  accent: "#b45309"',
      '  text: "#1f2328"',
      'titlePage:',
      '  fields: [title, variant, language, release, date]',
      'regions:',
      '  footer:',
      '    en: |-',
      '      [#keep]',
      '      Keep this leaflet with the product and read it before you use it.',
      '    de: |-',
      '      [#keep]',
      '      Bewahren Sie dieses Blatt beim Produkt auf und lesen Sie es vor dem Gebrauch.',
      '    fr: |-',
      '      [#keep]',
      '      Conservez cette notice avec le produit et lisez-la avant de l’utiliser.',
      'header:',
      '  default:',
      '    left: placeholder:title[]',
      '    right: placeholder:variant[]',
      'footer:',
      '  default:',
      '    right:',
      '      en: Page placeholder:page[] of placeholder:page-count[]',
      '      de: Seite placeholder:page[] von placeholder:page-count[]',
      '      fr: Page placeholder:page[] sur placeholder:page-count[]',
      'headings:',
      '  numbering: [none]',
      '  sizes: [xl, lg, base]',
      '  colour: primary',
      '  pageBreakBeforeLevel1: false',
      'body:',
      '  fontSize: 8.5',
      '  lineHeight: 1.35',
      '  paragraphSpacing: 4',
      '',
    ].join('\n'),
    { id: SAMPLE_LEAFLET_DESIGN_ID },
  ),
);

/** The safety module type `addSampleSafetyLeaflet` adds to the sample's configuration (`safety: true`). */
export const SAMPLE_SAFETY_TYPE = 'safety';

/** The derived manual `addSampleSafetyLeaflet` adds (#451): `manuals/<id>.yaml`. */
export const SAMPLE_LEAFLET_ID = 'safety-leaflet';

/**
 * Adds a safety leaflet (#451) to a sample repository (bare or not) in one commit on `main`: a
 * module type `safety` marked `safety: true` in `openfolia.yaml`, two safety modules in English and
 * German (`crush-hazard`, only for the large model, and `battery-hazards`, included twice), the
 * operating manual including them, a front matter module (`leaflet-intro`), the leaflet's page
 * design (`SAMPLE_LEAFLET_DESIGN`, A5, #668) and the derived manual `safety-leaflet` gathering
 * them from the operating manual and printed with that design. Kept out of
 * `createSampleRepo`, whose content many tests count. Resolves to the new commit.
 */
export async function addSampleSafetyLeaflet(dir: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  const config = git('show', 'main:openfolia.yaml');
  const types = '  - { id: procedure, label: Procedure }\n';
  if (!config.includes(types)) throw new Error('not the sample configuration');
  const manual = git('show', 'main:manuals/operating.yaml');
  const module = (
    id: string,
    lang: string,
    title: string,
    type: string,
    blocks: Module['blocks'],
  ): { path: string; content: string } => ({
    path: `modules/${lang}/${id}.adoc`,
    content: printModule({
      schemaVersion: 1,
      id,
      meta: { title, type, lang, audience: 'public', facets: {} },
      blocks,
    }),
  });
  const notice = (
    severity: 'danger' | 'warning' | 'caution',
    hazard: string,
    text: string,
  ): Module['blocks'] => [
    {
      type: 'safety',
      id: 'notice',
      severity,
      hazard: [{ type: 'text', text: hazard }],
      symbols: ['w001'],
      blocks: [
        { type: 'paragraph', id: 'text', content: [{ type: 'text', text }] },
      ],
    },
  ];
  const { commit } = sampleCommit(dir, {
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'openfolia.yaml',
        content:
          config.replace(
            types,
            `${types}  - { id: ${SAMPLE_SAFETY_TYPE}, label: Safety, safety: true }\n`,
          ) + '\n',
      },
      module(
        'crush-hazard',
        'en',
        'Crush hazard',
        SAMPLE_SAFETY_TYPE,
        notice(
          'danger',
          'Crushing at the hose reel',
          'Keep your hands clear of the hose reel while it winds up.',
        ),
      ),
      module(
        'crush-hazard',
        'de',
        'Quetschgefahr',
        SAMPLE_SAFETY_TYPE,
        notice(
          'danger',
          'Quetschen an der Schlauchtrommel',
          'Halten Sie Ihre Hände von der Schlauchtrommel fern, während sie aufrollt.',
        ),
      ),
      module(
        'battery-hazards',
        'en',
        'Battery hazards',
        SAMPLE_SAFETY_TYPE,
        notice(
          'warning',
          'Battery acid',
          'Wear protective gloves and goggles when you handle the battery.',
        ),
      ),
      module(
        'battery-hazards',
        'de',
        'Gefahren durch die Batterie',
        SAMPLE_SAFETY_TYPE,
        notice(
          'warning',
          'Batteriesäure',
          'Tragen Sie Schutzhandschuhe und eine Schutzbrille, wenn Sie mit der Batterie arbeiten.',
        ),
      ),
      module('leaflet-intro', 'en', 'About this leaflet', 'concept', [
        {
          type: 'paragraph',
          id: 'text',
          content: [
            { type: 'text', text: 'The safety instructions for the ' },
            { type: 'attribute', name: 'product-name' },
            {
              type: 'text',
              text: ', taken from its operating manual. Read them before you use it.',
            },
          ],
        },
      ]),
      {
        path: 'manuals/operating.yaml',
        content:
          manual.replace(
            '  - module: charging\n',
            [
              '  - module: battery-hazards',
              '  - module: charging',
              '  - module: crush-hazard',
              '    when: model in (large)',
              '  - title: Battery',
              '    entries:',
              '      - module: battery-hazards',
              '',
            ].join('\n'),
          ) + '\n',
      },
      {
        path: `design/${SAMPLE_LEAFLET_DESIGN_ID}.yaml`,
        content: SAMPLE_LEAFLET_DESIGN,
      },
      {
        path: `manuals/${SAMPLE_LEAFLET_ID}.yaml`,
        content: [
          'schemaVersion: 1',
          'kind: derived',
          'title: Safety leaflet',
          'audience: public',
          `design: ${SAMPLE_LEAFLET_DESIGN_ID}`,
          'variants:',
          '  - model: small',
          '  - model: large',
          'rule:',
          '  source: operating',
          '  front:',
          '    - leaflet-intro',
          '',
        ].join('\n'),
      },
    ],
    message: 'Add a safety leaflet',
    author: { name: 'Test', email: 'test@example.com' },
  });
  return commit;
}

/** The derived manual `addSampleNoticeLeaflet` adds (#670): `manuals/<id>.yaml`. */
export const SAMPLE_NOTICE_LEAFLET_ID = 'safety-notices';

/**
 * Adds a leaflet of safety notices (#670) to a sample repository that has the safety leaflet
 * (`addSampleSafetyLeaflet`), in one commit on `main`: a procedure module `hose-connection` in English
 * and German holding two notices of its own (a caution in a step, and a warning in a variant
 * block for the large model only), included in the operating manual, and the derived manual
 * `safety-notices` gathering the operating manual's safety notices (its modules', whatever
 * their type, and those of the modules they refer to, such as `charging`'s `safety-note`),
 * grouped by hazard level, after the leaflet's front matter, on the leaflet's page design.
 * Resolves to the new commit.
 */
export async function addSampleNoticeLeaflet(dir: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  const manual = git('show', 'main:manuals/operating.yaml');
  const entry = '  - module: crush-hazard\n    when: model in (large)\n';
  if (!manual.includes(entry)) throw new Error('no safety leaflet yet');
  const text = (t: string) => [{ type: 'text' as const, text: t }];
  const hoseConnection = (
    lang: string,
    t: {
      title: string;
      intro: string;
      step: string;
      pinch: [string, string];
      overload: [string, string];
    },
  ) => ({
    path: `modules/${lang}/hose-connection.adoc`,
    content: printModule({
      schemaVersion: 1,
      id: 'hose-connection',
      meta: {
        title: t.title,
        type: 'procedure',
        lang,
        audience: 'public',
        facets: {},
      },
      blocks: [
        { type: 'paragraph', id: 'intro', content: text(t.intro) },
        {
          type: 'procedure',
          id: 'steps',
          steps: [
            {
              id: 'tighten',
              content: text(t.step),
              blocks: [
                {
                  type: 'safety',
                  id: 'pinch',
                  severity: 'caution',
                  hazard: text(t.pinch[0]),
                  symbols: ['w001'],
                  blocks: [
                    {
                      type: 'paragraph',
                      id: 'pinch-text',
                      content: text(t.pinch[1]),
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'variant',
          id: 'large-tank',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: [
            {
              type: 'safety',
              id: 'overload',
              severity: 'warning',
              hazard: text(t.overload[0]),
              symbols: ['w001'],
              blocks: [
                {
                  type: 'paragraph',
                  id: 'overload-text',
                  content: text(t.overload[1]),
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  const { commit } = sampleCommit(dir, {
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      hoseConnection('en', {
        title: 'Connecting the hose',
        intro: 'Use only hoses rated for the maximum pressure.',
        step: 'Tighten the hose clamp.',
        pinch: [
          'Pinching at the hose clamp',
          'Keep your fingers away from the clamp while you tighten it.',
        ],
        overload: [
          'Overpressure in the large tank',
          'Never set the pressure switch above the maximum pressure shown on the type plate.',
        ],
      }),
      hoseConnection('de', {
        title: 'Den Schlauch anschließen',
        intro:
          'Verwenden Sie nur Schläuche, die für den Höchstdruck ausgelegt sind.',
        step: 'Ziehen Sie die Schlauchschelle fest.',
        pinch: [
          'Einklemmen an der Schlauchschelle',
          'Halten Sie Ihre Finger von der Schelle fern, während Sie sie festziehen.',
        ],
        overload: [
          'Überdruck im großen Druckbehälter',
          'Stellen Sie den Druckschalter nie über den Höchstdruck auf dem Typenschild ein.',
        ],
      }),
      {
        path: 'manuals/operating.yaml',
        content:
          manual.replace(entry, `${entry}  - module: hose-connection\n`) + '\n',
      },
      {
        path: `manuals/${SAMPLE_NOTICE_LEAFLET_ID}.yaml`,
        content: [
          'schemaVersion: 1',
          'kind: derived',
          'title: Safety notices',
          'audience: public',
          `design: ${SAMPLE_LEAFLET_DESIGN_ID}`,
          'variants:',
          '  - model: small',
          '  - model: large',
          'rule:',
          '  source: operating',
          '  front:',
          '    - leaflet-intro',
          '  notices:',
          '    groupBy: level',
          '',
        ].join('\n'),
      },
    ],
    message: 'Add a leaflet of safety notices',
    author: { name: 'Test', email: 'test@example.com' },
  });
  return commit;
}

/** The update guide `addSampleUpdateGuide` adds (#906): `manuals/<id>.yaml`. */
export const SAMPLE_UPDATE_GUIDE_ID = 'software-update';

/** The versions of `SAMPLE_UPDATE_GUIDE_ID`, oldest first. */
export const SAMPLE_UPDATE_VERSIONS = [
  '1.0',
  '1.1',
  '2.0',
  '2.1',
  '3.0',
  '3.1',
  '4.0',
] as const;

/**
 * The steps of `SAMPLE_UPDATE_GUIDE_ID`, in manifest order: module ID, version, phase, level,
 * condition, then the module's title and text in English and German.
 */
export const SAMPLE_UPDATE_STEPS: readonly (readonly [
  string,
  string,
  'before' | 'during' | 'after',
  string | undefined,
  string | undefined,
  string,
  string,
  string,
  string,
])[] = [
  [
    'install-package',
    '1.1',
    'during',
    undefined,
    undefined,
    'Install the update package',
    'Run the update package on the server and follow the prompts.',
    'Das Update-Paket installieren',
    'Führen Sie das Update-Paket auf dem Server aus und folgen Sie den Anweisungen.',
  ],
  [
    'check-version',
    '1.1',
    'after',
    undefined,
    undefined,
    'Check the installed version',
    'Open About and check that the new version is shown.',
    'Installierte Version prüfen',
    'Öffnen Sie „Info“ und prüfen Sie, ob die neue Version angezeigt wird.',
  ],
  [
    'back-up-settings',
    '2.0',
    'before',
    undefined,
    undefined,
    'Back up the settings',
    'Export the settings to a file and keep it until the update is done.',
    'Einstellungen sichern',
    'Exportieren Sie die Einstellungen in eine Datei und bewahren Sie sie bis nach dem Update auf.',
  ],
  [
    'stop-service',
    '2.0',
    'before',
    undefined,
    undefined,
    'Stop the service',
    'Stop the service so that no data changes during the update.',
    'Dienst anhalten',
    'Halten Sie den Dienst an, damit sich während des Updates keine Daten ändern.',
  ],
  [
    'migrate-database',
    '2.0',
    'during',
    'internal',
    undefined,
    'Migrate the database',
    'Run the migration tool once and wait until it reports success.',
    'Datenbank migrieren',
    'Führen Sie das Migrationswerkzeug einmal aus und warten Sie, bis es Erfolg meldet.',
  ],
  [
    'renew-licence',
    '2.0',
    'after',
    undefined,
    undefined,
    'Renew the licence key',
    'Enter the new licence key under Settings.',
    'Lizenzschlüssel erneuern',
    'Geben Sie den neuen Lizenzschlüssel unter „Einstellungen“ ein.',
  ],
  [
    'reconnect-nodes',
    '2.1',
    'after',
    undefined,
    'cluster in (yes)',
    'Reconnect the cluster nodes',
    'Restart each node one after the other and check that it joins the cluster.',
    'Cluster-Knoten neu verbinden',
    'Starten Sie die Knoten nacheinander neu und prüfen Sie, ob jeder dem Cluster beitritt.',
  ],
  [
    'check-requirements',
    '3.0',
    'before',
    undefined,
    undefined,
    'Check the system requirements',
    'Make sure the server has at least 8 GB of memory.',
    'Systemvoraussetzungen prüfen',
    'Stellen Sie sicher, dass der Server mindestens 8 GB Arbeitsspeicher hat.',
  ],
  [
    'convert-configuration',
    '3.0',
    'during',
    'internal',
    undefined,
    'Convert the configuration',
    'Run the converter on the old configuration file.',
    'Konfiguration umwandeln',
    'Wenden Sie den Konverter auf die alte Konfigurationsdatei an.',
  ],
  [
    'sign-in-again',
    '3.0',
    'after',
    undefined,
    undefined,
    'Sign in again',
    'Every user signs in again once after the update.',
    'Erneut anmelden',
    'Alle Benutzer melden sich nach dem Update einmal neu an.',
  ],
  [
    'drain-cluster',
    '4.0',
    'before',
    undefined,
    'cluster in (yes)',
    'Drain the cluster',
    'Move the work off each node before you update it.',
    'Cluster leeren',
    'Verlagern Sie die Arbeit von jedem Knoten, bevor Sie ihn aktualisieren.',
  ],
  [
    'remove-old-files',
    '4.0',
    'after',
    undefined,
    undefined,
    'Remove the old files',
    'Delete the folder of the previous version once everything works.',
    'Alte Dateien entfernen',
    'Löschen Sie den Ordner der vorigen Version, sobald alles funktioniert.',
  ],
];

/**
 * Adds an update guide (#906) to a sample repository (bare or not) in one commit on `main`: a
 * version attribute `software` and an enum attribute `cluster` (`yes`, `no`: the reader's option)
 * in `openfolia.yaml`, a procedure module per step in English and German, and the update guide
 * `software-update` for versions 1.0 to 4.0 with twelve steps over the three phases, two of them
 * for the `internal` level only and two for a cluster setup only (`SAMPLE_UPDATE_STEPS`). Kept out
 * of `createSampleRepo`, whose content many tests count. Resolves to the new commit.
 */
export async function addSampleUpdateGuide(dir: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  const config = git('show', 'main:openfolia.yaml');
  const before = 'textAttributes:\n';
  if (!config.includes(before)) throw new Error('not the sample configuration');
  const attributes = [
    '  - { id: software, label: Software, kind: version }',
    '  - id: cluster',
    '    label: Cluster setup',
    '    kind: enum',
    '    values:',
    '      - { id: "yes", label: "Yes" }',
    '      - { id: "no", label: "No" }',
    '',
  ].join('\n');
  const module = (
    id: string,
    lang: string,
    title: string,
    text: string,
  ): { path: string; content: string } => ({
    path: `modules/${lang}/${id}.adoc`,
    content: printModule({
      schemaVersion: 1,
      id,
      meta: { title, type: 'procedure', lang, audience: 'public', facets: {} },
      blocks: [
        { type: 'paragraph', id: 'text', content: [{ type: 'text', text }] },
      ],
    }),
  });
  const step = ([
    id,
    version,
    phase,
    level,
    when,
  ]: (typeof SAMPLE_UPDATE_STEPS)[number]) =>
    [
      `    - module: ${id}`,
      `      version: "${version}"`,
      `      phase: ${phase}`,
      ...(level ? [`      level: ${level}`] : []),
      ...(when ? [`      when: ${when}`] : []),
    ].join('\n');
  const { commit } = sampleCommit(dir, {
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'openfolia.yaml',
        content: config.replace(before, attributes + before) + '\n',
      },
      ...SAMPLE_UPDATE_STEPS.flatMap((s) => [
        module(s[0], 'en', s[5], s[6]),
        module(s[0], 'de', s[7], s[8]),
      ]),
      {
        path: `manuals/${SAMPLE_UPDATE_GUIDE_ID}.yaml`,
        content: [
          'schemaVersion: 1',
          'kind: update-guide',
          'title: { en: Software update guide, de: Leitfaden für Software-Updates }',
          'audience: internal',
          'variants:',
          '  - model: large',
          'attributes:',
          '  product-name: Model A',
          'guide:',
          '  attribute: software',
          `  versions: [${SAMPLE_UPDATE_VERSIONS.map((v) => `"${v}"`).join(', ')}]`,
          '  steps:',
          ...SAMPLE_UPDATE_STEPS.map(step),
          '',
        ].join('\n'),
      },
    ],
    message: 'Add an update guide',
    author: { name: 'Test', email: 'test@example.com' },
  });
  return commit;
}

/**
 * Adds a commit on `main` with the page designs of `SAMPLE_PAGE_DESIGNS` (`design/<id>.yaml`,
 * #390), kept out of the base sample whose content many tests count. Returns the commit.
 */
export async function addSamplePageDesigns(dir: string): Promise<string> {
  const head = execFileSync(
    'git',
    ['-C', dir, 'rev-parse', 'refs/heads/main'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
  const { commit } = sampleCommit(dir, {
    branch: 'main',
    parent: head,
    changes: Object.entries(SAMPLE_PAGE_DESIGNS).map(([id, content]) => ({
      path: `design/${id}.yaml`,
      content,
    })),
    message: 'Add page designs',
    author: { name: 'Test', email: 'test@example.com' },
  });
  return commit;
}

/**
 * Adds a commit on `main` with page design templates (#396): `templates` by template ID, each its
 * files by path in its folder (`manual.typ`, `parts/notice.typ`), as `templates/<id>/<path>`.
 * Written with Git's plumbing, as a project file is pushed: the API's writer writes no template.
 * Returns the commit.
 */
export function addSampleTemplates(
  dir: string,
  templates: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string {
  const scratch = mkdtempSync(join(tmpdir(), 'openfolia-templates-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_INDEX_FILE: join(scratch, 'index'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args: string[], input?: string) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env,
      ...(input !== undefined && { input }),
    }).trim();
  try {
    const head = git(['rev-parse', 'refs/heads/main']);
    git(['read-tree', head]);
    for (const [id, files] of Object.entries(templates)) {
      for (const [path, text] of Object.entries(files)) {
        const blob = git(['hash-object', '-w', '--stdin'], text);
        git([
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${blob},templates/${id}/${path}`,
        ]);
      }
    }
    const tree = git(['write-tree']);
    const commit = git([
      'commit-tree',
      tree,
      '-p',
      head,
      '-m',
      'Add page design templates',
    ]);
    git(['update-ref', 'refs/heads/main', commit, head]);
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function addSampleTerms(dir: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  const head = git('rev-parse', 'refs/heads/main');
  const config = git('show', 'main:openfolia.yaml');
  if (config.includes('\nstyleRules:')) {
    throw new Error('the configuration has style rules already');
  }
  const { commit } = sampleCommit(dir, {
    branch: 'main',
    parent: head,
    changes: [
      { path: 'openfolia.yaml', content: `${config}\n${SAMPLE_STYLE_RULES}` },
      ...Object.entries(SAMPLE_TERMS).map(([id, content]) => ({
        path: `terms/${id}.yaml`,
        content,
      })),
      {
        path: 'modules/en/storage.adoc',
        content: printModule({
          schemaVersion: 1,
          id: 'storage',
          meta: {
            title: 'Storage',
            type: 'concept',
            lang: 'en',
            audience: 'public',
            facets: {},
          },
          blocks: [
            {
              type: 'paragraph',
              id: 'dry',
              content: [
                { type: 'text', text: 'Store the loader in a dry place.' },
              ],
            },
            {
              type: 'paragraph',
              id: 'charge',
              content: [
                { type: 'text', text: 'Before storing it, charge the ' },
                {
                  type: 'text',
                  text: 'battery',
                  marks: [{ type: 'term', termId: 'battery' }],
                },
                { type: 'text', text: ' with the ' },
                {
                  type: 'text',
                  text: 'charger',
                  marks: [{ type: 'term', termId: 'charger' }],
                },
                { type: 'text', text: '.' },
              ],
            },
          ],
        }),
      },
      // The operating manual includes it and ends with a glossary of the terms it links (#245).
      {
        path: 'manuals/operating.yaml',
        content: MANUAL.replace(
          'audience: public\n',
          'audience: public\nglossary: true\n',
        ).replace(
          '  - module: internals\n',
          '  - module: internals\n  - module: storage\n',
        ),
      },
    ],
    message: 'Add terms',
    author: { name: 'Test', email: 'test@example.com' },
  });
  return commit;
}

const CONFIG = `languages:
  source: en
  targets: [de, fr]
moduleTypes:
  - { id: concept, label: Concept }
  - { id: procedure, label: Procedure }
audiences:
  - { id: public, label: Public }
  - { id: internal, label: Internal }
facets:
  - id: region
    label: Region
    values:
      - { id: north, label: North }
      - { id: south, label: South }
variantAttributes:
  - id: model
    label: Model
    kind: enum
    values:
      - { id: small, label: Small }
      - { id: large, label: Large }
textAttributes:
  - { id: product-name, label: Product name }
safetySymbols:
  - { id: w001, label: General warning }
`;

const MANUAL = `schemaVersion: 1
title: Operating manual
audience: public
variants:
  - model: small
  - model: large
attributes:
  product-name:
    - value: Model A
      when: model in (large)
    - value: Model B
entries:
  - module: charging
  - module: internals
`;

/** A second manual, for internal readers: one variant, a chapter. */
const SERVICE_MANUAL = `schemaVersion: 1
title: Service manual
audience: internal
variants:
  - model: large
attributes:
  product-name: Model A
entries:
  - module: internals
  - title: Charging
    entries:
      - module: charging
`;

function charging(intro: string): Module {
  const [before = '', after = ''] = intro.split('{product-name}');
  return {
    schemaVersion: 1,
    id: 'charging',
    meta: {
      title: 'Charging',
      type: 'procedure',
      lang: 'en',
      audience: 'public',
      facets: {},
      keywords: ['maintenance', 'battery'],
    },
    blocks: [
      {
        type: 'paragraph',
        id: 'intro',
        content: [
          { type: 'text', text: before },
          { type: 'attribute', name: 'product-name' },
          { type: 'text', text: after },
        ],
      },
      { type: 'moduleRef', id: 'note', module: 'safety-note' },
      {
        type: 'image',
        id: 'photo',
        asset: `sha256:${PNG_HASH}`,
        alt: 'The charger',
      },
    ],
  };
}

const safetyNote: Module = {
  schemaVersion: 1,
  id: 'safety-note',
  meta: {
    title: 'Safety note',
    type: 'concept',
    lang: 'en',
    audience: 'public',
    facets: { region: ['north'] },
  },
  blocks: [
    {
      type: 'safety',
      id: 'hot',
      severity: 'caution',
      hazard: [{ type: 'text', text: 'Hot surface' }],
      symbols: ['w001'],
      blocks: [
        {
          type: 'paragraph',
          id: 'cool',
          content: [{ type: 'text', text: 'Let it cool down.' }],
        },
      ],
    },
  ],
};

const internals: Module = {
  schemaVersion: 1,
  id: 'internals',
  meta: {
    title: 'Internals',
    type: 'concept',
    lang: 'en',
    audience: 'internal',
    facets: {},
    // Shared with `charging`: a reader without internal content finds only that one.
    keywords: ['maintenance', 'internal wiring'],
  },
  blocks: [
    {
      type: 'paragraph',
      id: 'secret',
      content: [{ type: 'text', text: 'Internal only.' }],
    },
  ],
};

/** No audience: the most restricted level applies. */
const unlabelled: Module = {
  schemaVersion: 1,
  id: 'unlabelled',
  meta: { title: 'Unlabelled', type: 'concept', lang: 'en', facets: {} },
  blocks: [
    {
      type: 'paragraph',
      id: 'text',
      content: [{ type: 'text', text: 'No audience given.' }],
    },
  ],
};

/**
 * A small picture (480×300, a flat drawing of a charging station and a vehicle): the sample's
 * image, so a local preview shows a real picture.
 */
export const PNG = Buffer.from(
  [
    'iVBORw0KGgoAAAANSUhEUgAAAeAAAAEsCAMAAAAsIJBoAAAAG1BMVEXu8vbV3eY6SlwqNkSP',
    '0Z71tysfJzDDzdiaqLhqJRJlAAAE7klEQVR42u3dC5KiShBAURs1cf8rfjEx82b8gPKpAio9',
    'dwEZDaeJVoqiTydJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkqSV',
    'dYVzRlPzIk7Pizi/L+HsvoSz+xLO7ksYsJr2JQxYTfsSBizAAqxtgM8vOcuABViABRgwYMCA',
    'AQM+NvBlQYCbAb4sDHAbwJfLKmHAgLUn8OWyThgwYAEWYNUCvv4KcG5gV3Be4Cvg1MBvfAEn',
    'AL4CTg381hcwYB0b+L0v4NaBr4BTA3/yBdw28BVwauDPvoAB67DAE3wBNwx8HQxwFuBJvoCb',
    'BZ7mCzgXsL/BaYAn+gJuFHiqL+A2gSf7Am4SeLov4KbvZE242wE4CbA7WbmB3arMCmy58BuA',
    'LTakBbaa9AXANp/lBf7oC7h5YNtHcwPbH5wZ+LMv4LaB7fBPDTzBF3DrNzoAAwYMWLsCe5Uh',
    'YMBNA3udcHZgLwRPD+yV/oABAwYMWIAFWIABAwYMGDBgwAIswAIswIABAwYMWEcFPk8IcLPA',
    '54kBbhP4fF4kDBiwjgB8Pi8TBgxYgAVYgAUYcHvA/Q4Bzqx7ZONkwP2uAc7te0jhVMB9Tzgz',
    'cN8TngHc3GJD3xNeDxyHBe57wvOAB6jiVwdd8Ac8G/gVawj4II/s9D3h+cBPxe8O+dAdYMCA',
    'GwZ+PMe3BSUV7ooL7w98WxjgNoBvt52FAQMGvBz4dttbGDDgowJPEQYMGDBgwIABAwY8e4f/',
    'Z2HAgAEDBgwYMGDA81+j9FF4P+C4C3A+4IjVwoAPDByxXhjwX+AAnBS4A/wdwAE4KXAH+DuA',
    'A3BS4A7wdwAH4KTAHeDvAA7ASYE7wN8BHICTAndHA44iiw22rky5hPcAjiiyXAh4yiW8A3D8',
    'BrZ9tDxwHAE4noBtAC8APC68OXC8AnuHw3rg7ijAAbgqcOwMHIArAY8Jbwr891Mz4HrAsR9w',
    'AK4IPCK8HfDd194T4ArAw8JbAd/f1jgBrgLc7Qj86Au4DvCQ8DbAj7yn0+1AZQIeEN4E+NkX',
    'cG3g2BL4hRdwNeBX4erAMeALuBrwi3Bt4CFewBWBn4XrAsewL+CKwP+EozZwjPkCrgn8KFwP',
    'eJwXcF3gB+FawPHOF3Bd4HvhOsDveQHXBr4TrgAcn3gBVwe+E46ywM/POw/6Aq4O/EAcxYCn',
    '8X4CjsKE8ZXAD8JRAjim8r4BXv1qpfnz0gI/Csc64IgZvKPABbazzJ+XF7h7FlkKHDN5x4Aj',
    'ygpPm5cY+EU4lgDP5x0BHhhT1nd4XmbgQeLquiPAg6PK+g7Oyw3c/fkntHORYrRJxzHVY4Xw',
    '5HnpgceIR60iVvIOAY9OLOs7MO8LgMeJ5zX9OABvDLzeeN5xTPdYKDxj3rcAryEuvTqxfnjV',
    'H7ZV4KXE5ZefAFcCXmBc4+kAwBWB/3wP3goW8E7Ab09S+eMq/bu05e9mu8Bb5gquJQwYMOCW',
    'hQEDBtyy8EGAi39kb9a3tDDg5MJHAT6V9mjXt6zwYYBPpT0q+v5Urybwz14NeBxq3t9OW5yN',
    'hMA/pT0q+W4DnLLSHnV8AZchOeQ8wEVUDj4PcPIAAxZgARZgARZgAQYswAIswAIswAIMWIAF',
    'WIAFWIAFWIABC7AAC7AAC7AAAxZgARZgARZgAQYswAIswAIswAKs//sPnTt34sRiMGsAAAAA',
    'SUVORK5CYII=',
  ].join(''),
  'base64',
);
/** The SHA-256 of `PNG`: its name under `assets/`. */
export const PNG_HASH =
  'c991b5a30f5bff4af8bf4bb16238eee51acca1b533313fa00f05168deac80f57';

/**
 * The sample's safety symbol artwork: a general warning sign (a yellow
 * triangle with an exclamation mark), drawn here, so PDFs of the sample show
 * a real sign rather than a placeholder.
 */
const SYMBOL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 90">' +
  '<path d="M50 5 L95 85 H5 Z" fill="#f9c900" stroke="#000" stroke-width="7" stroke-linejoin="round"/>' +
  '<rect x="45" y="32" width="10" height="32" rx="3"/><circle cx="50" cy="73" r="5.5"/></svg>\n';

/**
 * The texts of `display`, the module `addSampleRtlLanguages` adds (#458), per language: English
 * (the source), Arabic and Hebrew. Neutral content with mixed-direction text in it: numbers and
 * units, a Latin product name (the `product-name` attribute), a code span, a table of codes.
 */
const DISPLAY_TEXTS = {
  en: {
    title: 'Display',
    intro: ['The ', ' shows the battery level on its display.'],
    level:
      'Charge the battery when the level falls below 20 %. A full charge takes about 3 hours at 230 V.',
    code: ['If the display shows ', 'E-104', ', restart the charger.'],
    items: [
      'Press the button to turn the display on.',
      'The display turns off after 30 seconds.',
    ],
    table: 'Error codes',
    head: ['Code', 'Meaning'],
    rows: ['The battery is too warm.', 'The charger is not connected.'],
    hazard: 'Hot surface',
    cool: 'Let the device cool down before you touch it.',
  },
  ar: {
    title: 'الشاشة',
    intro: ['يعرض ', ' مستوى شحن البطارية على شاشته.'],
    level:
      'اشحن البطارية عندما ينخفض المستوى إلى أقل من 20 %. يستغرق الشحن الكامل نحو 3 ساعات عند 230 V.',
    code: ['إذا ظهر الرمز ', 'E-104', ' على الشاشة، فأعد تشغيل الشاحن.'],
    items: ['اضغط على الزر لتشغيل الشاشة.', 'تنطفئ الشاشة بعد 30 ثانية.'],
    table: 'رموز الأخطاء',
    head: ['الرمز', 'المعنى'],
    rows: ['البطارية ساخنة جدًا.', 'الشاحن غير موصول.'],
    hazard: 'سطح ساخن',
    cool: 'اترك الجهاز حتى يبرد قبل لمسه.',
  },
  he: {
    title: 'תצוגה',
    intro: ['', ' מציג את רמת הטעינה של הסוללה בתצוגה.'],
    level:
      'טענו את הסוללה כשהרמה יורדת מתחת ל־20 %. טעינה מלאה נמשכת כ־3 שעות ב־230 V.',
    code: ['אם בתצוגה מופיע הקוד ', 'E-104', ', הפעילו מחדש את המטען.'],
    items: [
      'לחצו על הלחצן כדי להפעיל את התצוגה.',
      'התצוגה נכבית אחרי 30 שניות.',
    ],
    table: 'קודי שגיאה',
    head: ['קוד', 'משמעות'],
    rows: ['הסוללה חמה מדי.', 'המטען אינו מחובר.'],
    hazard: 'משטח חם',
    cool: 'הניחו למכשיר להתקרר לפני שנוגעים בו.',
  },
} as const;

/** The languages `addSampleRtlLanguages` adds as targets: both written right to left. */
export const SAMPLE_RTL_LANGUAGES = ['ar', 'he'] as const;

/**
 * `display` in English (the source), Arabic or Hebrew: the module `addSampleRtlLanguages` adds,
 * with the same block IDs in every language.
 */
export function sampleDisplayModule(lang: keyof typeof DISPLAY_TEXTS): Module {
  const x = DISPLAY_TEXTS[lang];
  const paragraph = (id: string, text: string) => ({
    type: 'paragraph' as const,
    id,
    content: [{ type: 'text' as const, text }],
  });
  const cell = (id: string, text: string) => ({
    blocks: [paragraph(id, text)],
  });
  return {
    schemaVersion: 1,
    id: 'display',
    meta: {
      title: x.title,
      type: 'concept',
      lang,
      audience: 'public',
      facets: {},
    },
    blocks: [
      {
        type: 'paragraph',
        id: 'intro',
        content: [
          ...(x.intro[0] ? [{ type: 'text' as const, text: x.intro[0] }] : []),
          { type: 'attribute', name: 'product-name' },
          { type: 'text', text: x.intro[1] },
        ],
      },
      paragraph('level', x.level),
      {
        type: 'paragraph',
        id: 'code',
        content: [
          { type: 'text', text: x.code[0] },
          { type: 'text', text: x.code[1], marks: [{ type: 'code' }] },
          { type: 'text', text: x.code[2] },
        ],
      },
      {
        type: 'list',
        id: 'buttons',
        ordered: false,
        items: x.items.map((text, i) => ({
          id: `button-${i + 1}`,
          content: [{ type: 'text', text }],
          blocks: [],
        })),
      },
      {
        type: 'table',
        id: 'codes',
        title: [{ type: 'text', text: x.table }],
        columns: [{ width: 1 }, { width: 3 }],
        header: true,
        rows: [
          {
            cells: [
              cell('code-head', x.head[0]),
              cell('meaning-head', x.head[1]),
            ],
          },
          { cells: [cell('e101', 'E-101'), cell('e101-meaning', x.rows[0])] },
          { cells: [cell('e104', 'E-104'), cell('e104-meaning', x.rows[1])] },
        ],
      },
      {
        type: 'safety',
        id: 'hot',
        severity: 'caution',
        hazard: [{ type: 'text', text: x.hazard }],
        symbols: ['w001'],
        blocks: [paragraph('cool', x.cool)],
      },
    ],
  };
}

/** The manual `addSampleRtlLanguages` adds: `display` alone, for the Model A. */
export const SAMPLE_QUICK_START = `schemaVersion: 1
title: Quick start
audience: public
variants:
  - model: large
attributes:
  product-name: Model A
entries:
  - module: display
`;

/**
 * Adds two right-to-left languages to a sample repository (bare or not), in two commits on
 * `main` (#458): Arabic and Hebrew as translation languages in `openfolia.yaml` (their direction from
 * their script, nothing else configured), a public English module, `display`, with numbers, a
 * Latin product name and a code span in its text, and a manual, `quick-start`, of it; then the
 * module's Arabic and Hebrew translations, each with its record (up to date). Kept out of
 * `createSampleRepo`, whose content many tests count; the local sample (`setup-local`) has them.
 * Resolves to the last commit.
 */
export async function addSampleRtlLanguages(dir: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  const config = git('show', 'main:openfolia.yaml');
  const targets = '  targets: [de, fr]\n';
  if (!config.includes(targets))
    throw new Error('not the sample configuration');
  const author = { name: 'Test', email: 'test@example.com' };
  const source = sampleDisplayModule('en');
  const first = sampleCommit(dir, {
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'openfolia.yaml',
        content:
          config.replace(
            targets,
            `  targets: [de, fr, ${SAMPLE_RTL_LANGUAGES.join(', ')}]\n`,
          ) + '\n',
      },
      { path: 'modules/en/display.adoc', content: printModule(source) },
      { path: 'manuals/quick-start.yaml', content: SAMPLE_QUICK_START },
    ],
    message: 'Add right-to-left languages',
    author,
  });
  const { commit } = sampleCommit(dir, {
    branch: 'main',
    parent: first.commit,
    changes: SAMPLE_RTL_LANGUAGES.flatMap((lang) => [
      {
        path: `modules/${lang}/display.adoc`,
        content: printModule(sampleDisplayModule(lang)),
      },
      {
        path: `modules/${lang}/display.translation.yaml`,
        content: printTranslationRecord(
          translationRecordOf(source, first.commit),
        ),
      },
    ]),
    message: 'Translate the display module',
    author,
  });
  return commit;
}
