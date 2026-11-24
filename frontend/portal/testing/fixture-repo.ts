import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { printModule, type Block, type Module } from '@openfolia/content-model';

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
      {
        type: 'procedure',
        id: 'steps',
        title: [text('Charge manually')],
        steps: [
          { id: 's1', content: [text('Park the vehicle.')], blocks: [] },
          { id: 's2', content: [text('Connect the cable.')], blocks: [] },
        ],
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

/**
 * Creates the portal's fixture content repository (bare, as a server that writes tags needs) in
 * a new temporary directory: three audiences, two products, English and German, one manual per
 * audience, the public one listing modules of all three. Returns its directory.
 */
export function createFixtureRepo(): string {
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
  for (const m of MODULES)
    write(`modules/${m.meta.lang}/${m.id}.adoc`, printModule(m));
  write('manuals/operating.yaml', OPERATING);
  write('manuals/service.yaml', SERVICE);
  write('manuals/vault.yaml', VAULT);
  write('terms/battery.yaml', TERM);
  write(`assets/${PNG_HASH}`, PNG);
  write(`assets/${ATTACHMENT_HASH}`, ATTACHMENT);
  write('symbols/w001.svg', HOSTILE_SVG);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Fixture content');
  const bare = mkdtempSync(join(tmpdir(), 'openfolia-portal-repo-'));
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { env });
  git(bare, 'remote', 'remove', 'origin');
  execFileSync('rm', ['-rf', work]);
  return bare;
}
