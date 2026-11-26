import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { printModule, type Block, type Module } from '@openfolia/content-model';
import {
  SAMPLE_UPDATE_STEPS,
  SAMPLE_UPDATE_VERSIONS,
} from '@openfolia/content-repo/testing';

/**
 * Words that appear only in the internal and the restricted modules and manuals (their titles,
 * keywords, text, alternative texts, in English and German). A public build must hold neither,
 * an internal build only the internal one: the tests look for them in every built file and in
 * the search index.
 */
export const INTERNAL_CANARY = 'quokkaseven';
export const RESTRICTED_CANARY = 'narwhalnine';

/** A public word every build holds, to prove the search index is searched at all. */
export const PUBLIC_WORD = 'chargingdock';

/**
 * Older releases (#896): a public word only alpha's older releases hold (a module the newest
 * dropped), the revisions they were cut as, oldest first (one long enough to wrap), and the
 * newest's, which every product has.
 */
export const OLDER_WORD = 'latchlever';
export const OLDER_REVISIONS = [
  '0.8',
  '0.9-maintenance-for-cluster-setups-with-the-large-model-and-the-mains-adapter',
] as const;
export const NEWEST_REVISION = '1.0';

/**
 * The authored start page (#897): the manual that is it, in the newest releases only, and the
 * portal's address its links are written with. `UNRELEASED_WORD` is in its text only after the
 * releases were cut: no build may hold it.
 */
export const START_MANUAL = 'portal-start';
/** The internal audience's own, which its site takes before the public one. */
export const INTERNAL_START = 'portal-start-internal';
export const PORTAL_ORIGIN = 'https://docs.example.com';
export const UNRELEASED_WORD = 'walrustwelve';
/** Its featured links that a public build has no page for (the internal one has the first two). */
export const INTERNAL_LINKS = ['Service the drive unit', 'Update the software'];
export const DEAD_LINKS = ['Reset the master key', 'The manual that moved'];

/** The products of the fixture's product facet. */
export const FIXTURE_PRODUCTS = ['alpha', 'beta'] as const;

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
export const PNG_HASH = createHash('sha256').update(PNG).digest('hex');

/**
 * A safety symbol's artwork as SVG with a script in it: the portal never writes an SVG into a
 * site (it would run at the site's origin when opened on its own), so the build turns it into
 * a PNG and the tests check no `<script` and no `.svg` reached the output.
 */
const HOSTILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><script>alert(document.domain)</script><path d="M12 2 L22 21 L2 21 Z" fill="#f5c400" stroke="#000"/></svg>`;

/** An attached file (JSON), linked for download. */
const ATTACHMENT = Buffer.from('{"setting":"default"}\n');
export const ATTACHMENT_HASH = createHash('sha256')
  .update(ATTACHMENT)
  .digest('hex');

const CONFIG = `languages:
  source: en
  targets: [de]
moduleTypes:
  - { id: concept, label: Concept }
  - { id: procedure, label: Procedure }
audiences:
  - { id: public, label: Public }
  - { id: internal, label: Internal }
  - { id: restricted, label: Restricted }
facets:
  - id: product
    label: Product
    values:
      - { id: alpha, label: Alpha }
      - { id: beta, label: Beta }
release:
  productFacet: product
variantAttributes:
  - id: model
    label: Model
    kind: enum
    values:
      - { id: small, label: Small }
      - { id: large, label: Large }
  - id: power
    label: { en: Power supply, de: Stromversorgung }
    kind: enum
    values:
      - { id: battery, label: { en: Battery, de: Akku } }
      - { id: mains, label: { en: Mains adapter, de: Netzteil } }
  - { id: software, label: Software, kind: version }
  - id: cluster
    label: { en: Cluster setup, de: Cluster-Betrieb }
    kind: enum
    values:
      - { id: "yes", label: { en: "Yes", de: "Ja" } }
      - { id: "no", label: { en: "No", de: "Nein" } }
textAttributes:
  - { id: product-name, label: Product name }
safetySymbols:
  - { id: w001, label: General warning }
`;

const TERM = `schemaVersion: 1
status: approved
domain: power
languages:
  en:
    preferred: battery
    definition: The rechargeable energy store that powers the vehicle.
  de:
    preferred: Akku
    definition: Der aufladbare Energiespeicher des Fahrzeugs.
`;

const text = (value: string) => ({ type: 'text' as const, text: value });
const paragraph = (id: string, value: string): Block => ({
  type: 'paragraph',
  id,
  content: [text(value)],
});

/** A paragraph whose last word is the battery term. */
const termParagraph = (id: string): Block => ({
  type: 'paragraph',
  id,
  content: [
    text('Store the '),
    { ...text('battery'), marks: [{ type: 'term', termId: 'battery' }] },
  ],
});

interface Texts {
  readonly title: string;
  readonly keywords: string[];
  readonly blocks: Block[];
}

function module(
  id: string,
  lang: 'en' | 'de',
  type: string,
  audience: string,
  { title, keywords, blocks }: Texts,
): Module {
  return {
    schemaVersion: 1,
    id,
    meta: { title, type, lang, audience, facets: {}, keywords },
    blocks,
  };
}

const MODULES: Module[] = [
  module('welcome', 'en', 'concept', 'public', {
    title: 'Welcome',
    keywords: ['introduction'],
    blocks: [
      {
        type: 'paragraph',
        id: 'intro',
        content: [
          text('The '),
          { type: 'attribute', name: 'product-name' },
          text(' docks itself at the '),
          text(PUBLIC_WORD),
          text('. Keep the '),
          { ...text('battery'), marks: [{ type: 'term', termId: 'battery' }] },
          text(' charged. See '),
          { type: 'xref', module: 'charging' },
          text('.'),
        ],
      },
      {
        type: 'image',
        id: 'photo',
        asset: `sha256:${PNG_HASH}`,
        alt: 'The vehicle at its dock',
      },
      {
        type: 'attachment',
        id: 'settings',
        asset: `sha256:${ATTACHMENT_HASH}`,
        name: 'Default settings',
        fileName: 'settings.json',
        mediaType: 'application/json',
        size: ATTACHMENT.length,
      },
    ],
  }),
  module('welcome', 'de', 'concept', 'public', {
    title: 'Willkommen',
    keywords: ['Einführung'],
    blocks: [
      {
        type: 'paragraph',
        id: 'intro',
        content: [
          text('Das '),
          { type: 'attribute', name: 'product-name' },
          text(' dockt selbst an der '),
          text(PUBLIC_WORD),
          text(' an. Halten Sie den '),
          { ...text('Akku'), marks: [{ type: 'term', termId: 'battery' }] },
          text(' geladen.'),
        ],
      },
      {
        type: 'image',
        id: 'photo',
        asset: `sha256:${PNG_HASH}`,
        alt: 'Das Fahrzeug an der Station',
      },
    ],
  }),
  module('charging', 'en', 'procedure', 'public', {
    title: 'Charging',
    keywords: ['battery'],
    blocks: [
      {
        type: 'safety',
        id: 'hot',
        severity: 'caution',
        hazard: [text('Hot surface')],
        symbols: ['w001'],
        blocks: [paragraph('cool', 'Let the contacts cool down.')],
      },
      // A term where an ancestor clips: a notice, a table's last row and an FAQ answer (#891).
      {
        type: 'safety',
        id: 'pack',
        severity: 'danger',
        hazard: [text('Pack under load')],
        symbols: [],
        blocks: [termParagraph('pack-term')],
      },
      {
        type: 'table',
        id: 'specs',
        columns: [{ width: 1 }],
        header: false,
        rows: [
          { cells: [{ blocks: [paragraph('spec-1', 'Rated at 48 V.')] }] },
          { cells: [{ blocks: [termParagraph('spec-2')] }] },
        ],
      },
      {
        type: 'faq',
        id: 'faq',
        question: [text('How is it stored?')],
        blocks: [termParagraph('faq-term')],
      },
      {
        type: 'procedure',
        id: 'steps',
        title: [text('Charge manually')],
        steps: [
          { id: 's1', content: [text('Park the vehicle.')], blocks: [] },
          { id: 's2', content: [text('Connect the cable.')], blocks: [] },
        ],
      },
      // Literal blocks for the copy button: one with indentation and blank lines, one long line.
      {
        type: 'literal',
        id: 'config',
        language: 'sh',
        text: 'charger:\n  mode: fast\n\n  limit: 80',
      },
      {
        type: 'literal',
        id: 'long',
        text: `export CHARGER_URL=https://charger.example.com/${'very-long-path/'.repeat(12)}end`,
      },
      // Internal content brought into a public module: never in a public build.
      { type: 'moduleRef', id: 'code', module: 'service-code' },
    ],
  }),
  module('charging', 'de', 'procedure', 'public', {
    title: 'Laden',
    keywords: ['Akku'],
    blocks: [
      {
        type: 'safety',
        id: 'hot',
        severity: 'caution',
        hazard: [text('Heiße Oberfläche')],
        symbols: ['w001'],
        blocks: [paragraph('cool', 'Lassen Sie die Kontakte abkühlen.')],
      },
      {
        type: 'procedure',
        id: 'steps',
        title: [text('Von Hand laden')],
        steps: [
          { id: 's1', content: [text('Parken Sie das Fahrzeug.')], blocks: [] },
          {
            id: 's2',
            content: [text('Stecken Sie das Kabel ein.')],
            blocks: [],
          },
        ],
      },
      {
        type: 'literal',
        id: 'config',
        language: 'sh',
        text: 'charger:\n  mode: fast\n\n  limit: 80',
      },
      {
        type: 'literal',
        id: 'long',
        text: `export CHARGER_URL=https://charger.example.com/${'very-long-path/'.repeat(12)}end`,
      },
      { type: 'moduleRef', id: 'code', module: 'service-code' },
    ],
  }),
  module('service-code', 'en', 'concept', 'internal', {
    title: `Service code ${INTERNAL_CANARY}`,
    keywords: [INTERNAL_CANARY],
    blocks: [
      paragraph(
        'code',
        `Enter the service code ${INTERNAL_CANARY} on the panel.`,
      ),
      {
        type: 'image',
        id: 'panel',
        asset: `sha256:${PNG_HASH}`,
        alt: `Panel ${INTERNAL_CANARY}`,
      },
    ],
  }),
  module('service-code', 'de', 'concept', 'internal', {
    title: `Servicecode ${INTERNAL_CANARY}`,
    keywords: [INTERNAL_CANARY],
    blocks: [
      paragraph('code', `Geben Sie den Servicecode ${INTERNAL_CANARY} ein.`),
    ],
  }),
  module('master-key', 'en', 'concept', 'restricted', {
    title: `Master key ${RESTRICTED_CANARY}`,
    keywords: [RESTRICTED_CANARY],
    blocks: [paragraph('key', `The master key is ${RESTRICTED_CANARY}.`)],
  }),
  module('master-key', 'de', 'concept', 'restricted', {
    title: `Generalschlüssel ${RESTRICTED_CANARY}`,
    keywords: [RESTRICTED_CANARY],
    blocks: [
      paragraph('key', `Der Generalschlüssel ist ${RESTRICTED_CANARY}.`),
    ],
  }),
];

type Runs = Extract<Block, { type: 'paragraph' }>['content'];
const linked = (value: string, href: string): Runs[number] => ({
  ...text(value),
  marks: [{ type: 'link', href }],
});
const linkTo = (value: string, path: string) =>
  linked(value, `${PORTAL_ORIGIN}/${path}`);
const links = (id: string, items: Runs[]): Block => ({
  type: 'list',
  id,
  ordered: false,
  items: items.map((content, i) => ({ id: `${id}-${i}`, content, blocks: [] })),
});

/**
 * The start page's modules (#897): its heading, introduction, notice and featured links (a
 * section, a manual, a search, an address elsewhere, an internal manual and guide, a restricted
 * module and a manual that is not there), a second group with a long title written in English
 * only, and an internal one.
 */
const startModules = (
  heading: readonly [string, string] = [
    'Find the right page the first time',
    'Finden Sie die richtige Seite auf Anhieb',
  ],
): Module[] => [
  module('start-welcome', 'en', 'concept', 'public', {
    title: heading[0],
    keywords: [],
    blocks: [
      paragraph(
        'lead',
        'Everything about operating and charging your vehicle. Search, or start with one of the pages most readers need.',
      ),
      {
        type: 'admonition',
        id: 'news',
        kind: 'note',
        blocks: [
          {
            type: 'paragraph',
            id: 'news-text',
            content: [
              text(
                'New in this release: the large model on the mains adapter. See ',
              ),
              { type: 'xref', module: 'charging' },
              text('. The '),
              linkTo('old page', 'en/alpha/gone/'),
              text(' has moved; see the '),
              linkTo('manual', 'en/alpha/operating/'),
              text(' and '),
              { type: 'xref', module: 'start-more' },
              text('. Check the '),
              {
                ...text('battery'),
                marks: [{ type: 'term', termId: 'battery' }],
              },
              text('.'),
            ],
          },
        ],
      },
      links('featured', [
        [
          {
            type: 'xref',
            module: 'charging',
            text: [text('Charge the vehicle')],
          },
          text(
            ': At the dock or by hand, and what to do when it does not start.',
          ),
        ],
        [
          linkTo(
            'Operating manual',
            'en/alpha/operating/model=large,power=mains/',
          ),
          text(' – For the large model on the mains adapter'),
        ],
        [
          linkTo('Everything about the battery', 'en/search/?q=battery'),
          text(': In every manual.'),
        ],
        [
          linked(
            'Spare parts and support',
            'https://support.example.org/parts',
          ),
          text(': Order a part or ask a question.'),
        ],
        [
          linkTo(INTERNAL_LINKS[0]!, 'en/alpha/service/'),
          text(': For trained staff.'),
        ],
        [
          linkTo(
            INTERNAL_LINKS[1]!,
            'en/alpha/software-update/?from=1.0&to=4.0',
          ),
          text(': Only the steps for your versions.'),
        ],
        [
          {
            type: 'xref',
            module: 'master-key',
            text: [text(DEAD_LINKS[0]!)],
          },
        ],
        [linkTo(DEAD_LINKS[1]!, 'en/alpha/gone/')],
      ]),
    ],
  }),
  module('start-welcome', 'de', 'concept', 'public', {
    title: heading[1],
    keywords: [],
    blocks: [
      paragraph(
        'lead',
        'Alles über Betrieb und Laden Ihres Fahrzeugs. Suchen Sie, oder beginnen Sie mit einer der Seiten, die die meisten brauchen.',
      ),
      {
        type: 'admonition',
        id: 'news',
        kind: 'note',
        blocks: [
          {
            type: 'paragraph',
            id: 'news-text',
            content: [
              text(
                'Neu in dieser Version: das große Modell am Netzteil. Siehe ',
              ),
              { type: 'xref', module: 'charging' },
              text('. Die '),
              linkTo('alte Seite', 'de/alpha/gone/'),
              text(' ist umgezogen; siehe die '),
              // Copied from the English site, without its variant.
              linkTo('Anleitung', 'en/alpha/operating/'),
              text(' und '),
              { type: 'xref', module: 'start-more' },
              text('. Prüfen Sie den '),
              { ...text('Akku'), marks: [{ type: 'term', termId: 'battery' }] },
              text('.'),
            ],
          },
        ],
      },
      links('featured', [
        [
          { type: 'xref', module: 'charging', text: [text('Fahrzeug laden')] },
          text(
            ': An der Station oder von Hand, und was zu tun ist, wenn es nicht beginnt.',
          ),
        ],
        // Copied from the English site: it leads to this language's page.
        [
          linkTo(
            'Betriebsanleitung',
            'en/alpha/operating/model=large,power=mains/',
          ),
          text(' – Für das große Modell am Netzteil'),
        ],
        [
          linkTo('Alles über den Akku', 'de/search/?q=Akku'),
          text(': In allen Anleitungen.'),
        ],
        [
          linked(
            'Ersatzteilbestellung und Kundendienst',
            'https://support.example.org/parts',
          ),
          text(': Ein Teil bestellen oder eine Frage stellen.'),
        ],
        [
          linkTo('Antriebseinheit warten', 'de/alpha/service/'),
          text(': Für geschultes Personal.'),
        ],
        [
          linkTo(
            'Software aktualisieren',
            'de/alpha/software-update/?from=1.0&to=4.0',
          ),
          text(': Nur die Schritte für Ihre Versionen.'),
        ],
        [
          {
            type: 'xref',
            module: 'master-key',
            text: [text('Generalschlüssel zurücksetzen')],
          },
        ],
        [linkTo('Die umgezogene Anleitung', 'de/alpha/gone/')],
      ]),
    ],
  }),
  module('start-more', 'en', 'concept', 'public', {
    title:
      'Before the first start: what to check on the vehicle, the dock and the charging contacts',
    keywords: [],
    blocks: [
      termParagraph('more-term'),
      links('more', [
        [
          linkTo(
            'Beta: the operating manual for the battery-powered small model, from unpacking to the first charge',
            'en/beta/operating/',
          ),
        ],
        [linkTo('All manuals', 'en/manuals/')],
      ]),
    ],
  }),
  module('start-service', 'en', 'concept', 'internal', {
    title: `For service staff ${INTERNAL_CANARY}`,
    keywords: [],
    blocks: [
      paragraph('note', `Keep the service code ${INTERNAL_CANARY} at hand.`),
      links('service', [
        [
          linkTo('The release before', `en/alpha/v/${OLDER_REVISIONS[0]}/`),
          text(': For vehicles not updated yet.'),
        ],
      ]),
    ],
  }),
];

const START = `schemaVersion: 1
title: Start page
audience: public
variants:
  - model: large
attributes:
  product-name: Model A
entries:
  - module: start-welcome
  - module: start-more
  - module: start-service
  - module: master-key
`;

/** The internal one: the same page, with what its audience alone may read. */
const START_INTERNAL = START.replace('audience: public', 'audience: internal');

/**
 * The public manual lists modules of every audience: only the public ones may reach a public build.
 * It is published in three of the four Model × Power supply combinations (no small one on mains),
 * so its variant switch has options that change the other attribute too (#844).
 */
const OPERATING = `schemaVersion: 1
title: Operating manual
audience: public
glossary: true
variants:
  - { model: small, power: battery }
  - { model: large, power: battery }
  - { model: large, power: mains }
attributes:
  product-name:
    - value: Model A
      when: model in (large)
    - value: Model B
entries:
  - module: welcome
  - module: charging
  - module: service-code
  - module: master-key
`;

const SERVICE = `schemaVersion: 1
title: Service manual ${INTERNAL_CANARY}
audience: internal
variants:
  - model: large
attributes:
  product-name: Model A
entries:
  - module: service-code
  - module: charging
`;

const VAULT = `schemaVersion: 1
title: Vault manual ${RESTRICTED_CANARY}
audience: restricted
variants:
  - model: large
attributes:
  product-name: Model A
entries:
  - module: master-key
`;

/** The fixture's update guide (#907): `manuals/<id>.yaml`, for the internal audience. */
export const UPDATE_GUIDE_ID = 'software-update';

/** Its versions, oldest first: the sample guide's (`@openfolia/content-repo/testing`). */
export const UPDATE_VERSIONS = SAMPLE_UPDATE_VERSIONS;

/** A step title long enough to wrap on a phone, in English and German. */
export const LONG_STEP_TITLE = [
  'Confirm that every scheduled export, report and backup job still runs on the new version',
  'Prüfen Sie, ob alle geplanten Exporte, Berichte und Sicherungsaufträge in der neuen Version weiterlaufen',
] as const;

/**
 * The update guide's steps (#907), in manifest order: the sample guide's twelve (two for the
 * `internal` level only, two for a cluster setup only), then a step with a long title and 27
 * maintenance steps at 1.1, so the jump from 1.0 to 4.0 at the internal level with a cluster
 * holds 40 steps. Module ID, version, phase, level, condition, then the English and German title
 * and text, as `SAMPLE_UPDATE_STEPS`.
 */
export const UPDATE_STEPS: typeof SAMPLE_UPDATE_STEPS = [
  ...SAMPLE_UPDATE_STEPS,
  [
    'check-jobs',
    '4.0',
    'after',
    undefined,
    undefined,
    LONG_STEP_TITLE[0],
    'Open the job list and check the time each job last ran.',
    LONG_STEP_TITLE[1],
    'Öffnen Sie die Auftragsliste und prüfen Sie, wann jeder Auftrag zuletzt lief.',
  ],
  ...Array.from({ length: 27 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return [
      `check-component-${n}`,
      '1.1',
      'after',
      undefined,
      undefined,
      `Check component ${n}`,
      `Open the status page and check that component ${n} reports “ready”.`,
      `Komponente ${n} prüfen`,
      `Öffnen Sie die Statusseite und prüfen Sie, ob Komponente ${n} „bereit“ meldet.`,
    ] as const;
  }),
];

/** The guide's manifest: internal, so its readers pick the public or the internal level. */
const UPDATE_GUIDE = [
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
  `  versions: [${UPDATE_VERSIONS.map((v) => `"${v}"`).join(', ')}]`,
  '  steps:',
  ...UPDATE_STEPS.map(([id, version, phase, level, when]) =>
    [
      `    - module: ${id}`,
      `      version: "${version}"`,
      `      phase: ${phase}`,
      ...(level ? [`      level: ${level}`] : []),
      ...(when ? [`      when: ${when}`] : []),
    ].join('\n'),
  ),
  '',
].join('\n');

/** The module only the older releases hold (#896), in English and German. */
const LEGACY_MODULES: Module[] = [
  module('legacy-latch', 'en', 'procedure', 'public', {
    title: 'Release the transport latch',
    keywords: [OLDER_WORD],
    blocks: [
      paragraph(
        'text',
        `Pull the ${OLDER_WORD} before the first start: later models have none.`,
      ),
    ],
  }),
  module('legacy-latch', 'de', 'procedure', 'public', {
    title: 'Transportsicherung lösen',
    keywords: [OLDER_WORD],
    blocks: [
      paragraph(
        'text',
        `Ziehen Sie den ${OLDER_WORD} vor dem ersten Start: Spätere Modelle haben keinen.`,
      ),
    ],
  }),
];

/**
 * The public manual as the older releases have it (#896): the legacy module where the newest has
 * the charging one, and no large model on mains yet, so a release switch meets a missing section
 * and a missing variant.
 */
const OPERATING_OLDER = `schemaVersion: 1
title: Operating manual
audience: public
glossary: true
variants:
  - { model: small, power: battery }
  - { model: large, power: battery }
attributes:
  product-name:
    - value: Model A
      when: model in (large)
    - value: Model B
entries:
  - module: welcome
  - module: legacy-latch
  - module: service-code
  - module: master-key
`;

/** A procedure module per step, in English and German. */
const STEP_MODULES: Module[] = UPDATE_STEPS.flatMap(
  ([id, , , , , enTitle, enText, deTitle, deText]) => [
    module(id, 'en', 'procedure', 'public', {
      title: enTitle,
      keywords: [],
      blocks: [paragraph('text', enText)],
    }),
    module(id, 'de', 'procedure', 'public', {
      title: deTitle,
      keywords: [],
      blocks: [paragraph('text', deText)],
    }),
  ],
);

/** The fixture content repository (`createFixtureRepo`). */
export interface FixtureRepo {
  /** The bare repository's directory. */
  readonly dir: string;
  /** Moves `main` from the older content to the newest (#896): cut the older releases before. */
  advance(): void;
  /** Moves `main` past it, to an edit of the start page that no release holds (#897). */
  edit(): void;
}

/**
 * Creates the portal's fixture content repository (bare, as a server that writes tags needs) in
 * a new temporary directory: three audiences, two products, English and German, one manual per
 * audience, the public one listing modules of all three, and an internal update guide (#907).
 * `main` starts at the content alpha's older releases are cut from (#896); `advance` moves it to
 * the newest content (a commit after it), from which every product's newest release is cut, and
 * `edit` to a change of the start page that no release holds (#897).
 */
export function createFixtureRepo(): FixtureRepo {
  const work = mkdtempSync(join(tmpdir(), 'openfolia-portal-work-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim();
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  };
  git(work, 'init', '-q', '-b', 'main');
  write('openfolia.yaml', CONFIG);
  for (const m of [...MODULES, ...STEP_MODULES, ...LEGACY_MODULES])
    write(`modules/${m.meta.lang}/${m.id}.adoc`, printModule(m));
  write('manuals/operating.yaml', OPERATING_OLDER);
  write('manuals/service.yaml', SERVICE);
  write('manuals/vault.yaml', VAULT);
  write(`manuals/${UPDATE_GUIDE_ID}.yaml`, UPDATE_GUIDE);
  write('terms/battery.yaml', TERM);
  write(`assets/${PNG_HASH}`, PNG);
  write(`assets/${ATTACHMENT_HASH}`, ATTACHMENT);
  write('symbols/w001.svg', HOSTILE_SVG);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Older content');
  const older = git(work, 'rev-parse', 'HEAD');
  write('manuals/operating.yaml', OPERATING);
  for (const m of LEGACY_MODULES)
    execFileSync('rm', [join(work, `modules/${m.meta.lang}/${m.id}.adoc`)]);
  write(`manuals/${START_MANUAL}.yaml`, START);
  write(`manuals/${INTERNAL_START}.yaml`, START_INTERNAL);
  for (const m of startModules())
    write(`modules/${m.meta.lang}/${m.id}.adoc`, printModule(m));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Fixture content');
  const newest = git(work, 'rev-parse', 'HEAD');
  for (const m of startModules([
    `An unreleased heading ${UNRELEASED_WORD}`,
    `Eine unveröffentlichte Überschrift ${UNRELEASED_WORD}`,
  ]))
    write(`modules/${m.meta.lang}/${m.id}.adoc`, printModule(m));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'An edit not released yet');
  const edited = git(work, 'rev-parse', 'HEAD');
  const bare = mkdtempSync(join(tmpdir(), 'openfolia-portal-repo-'));
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { env });
  git(bare, 'remote', 'remove', 'origin');
  git(bare, 'update-ref', 'refs/heads/main', older);
  execFileSync('rm', ['-rf', work]);
  return {
    dir: bare,
    advance: () => git(bare, 'update-ref', 'refs/heads/main', newest, older),
    edit: () => git(bare, 'update-ref', 'refs/heads/main', edited, newest),
  };
}
