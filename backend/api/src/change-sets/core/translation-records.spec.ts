import {
  type Manifest,
  type PageDesign,
  parsePageDesign,
  printConfig,
  printManifest,
  printPageDesign,
  ProjectConfig,
} from '@openfolia/content-model';
import { SAMPLE_PAGE_DESIGNS } from '@openfolia/content-repo/testing';
import {
  config as baseConfig,
  manifest,
  readable,
} from '../../../tests/fakes/fake-content.js';
import type { Actor } from '../../access/core/actor.js';
import type { Permission } from '../../access/core/permissions.js';
import { UnprocessableError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  type RecordHolder,
  refuseRecordChanges,
  refusedRecordLanguages,
} from './translation-records.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  languages: { source: 'en', targets: ['de', 'fr'] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});

const person = (
  ...roles: (readonly [Permission[], Actor['roles'][number]['scope']])[]
): Actor => ({
  kind: 'user',
  id: 'someone',
  roles: roles.map(([permissions, scope], i) => ({
    id: `r${i}`,
    name: `R${i}`,
    permissions,
    scope,
  })),
});
const EDIT: Permission[] = ['content.read', 'content.edit'];
const editor = person([EDIT, {}]);
const manager = person([[...EDIT, 'translation.manage'], {}]);
const german = person(
  [EDIT, {}],
  [['translation.manage'], { languages: ['de'] }],
);
/** Manages every language, for manuals up to `public` only. */
const publicOnly = person(
  [EDIT, {}],
  [['translation.manage'], { maxAudience: 'public' }],
);

const COMMIT = 'c'.repeat(40);
const entry = (hash: string) => ({
  sourceCommit: COMMIT,
  blocks: { 'coverImage.default': hash.repeat(64) },
});
const designEntry = (hash: string) => ({
  sourceCommit: COMMIT,
  blocks: { 'above-title.intro': hash.repeat(64) },
});

const minimal = parsePageDesign(SAMPLE_PAGE_DESIGNS['minimal'] as string, {
  id: 'minimal',
});
const design = (translations?: PageDesign['translations']): PageDesign => ({
  ...minimal,
  ...(translations && { translations }),
});
const manual = (
  translations?: Manifest['translations'],
  audience = 'public',
): Manifest => ({
  ...manifest('guide', ['a']),
  audience,
  ...(translations && { translations }),
});

const DESIGN = { type: 'design', designId: 'minimal' } as const;
const MANUAL = { type: 'manual', manualId: 'guide' } as const;

const at = (content: {
  design?: PageDesign;
  manual?: Manifest;
}): ReadableContent =>
  readable({
    config,
    manifests: content.manual ? [content.manual] : [],
    pageDesigns: content.design
      ? { minimal: printPageDesign(content.design) }
      : {},
  });

const sides = (head: ReadableContent, ...bases: ReadableContent[]) => ({
  head,
  bases: () => Promise.resolve(bases),
});

describe('refusedRecordLanguages (#663)', () => {
  const head = at({
    design: design({ de: designEntry('1') }),
    manual: manual({ de: entry('1') }),
  });

  it('lets anyone keep the record as the head has it', async () => {
    for (const actor of [editor, manager]) {
      expect(
        await refusedRecordLanguages(
          actor,
          DESIGN,
          design({ de: designEntry('1') }),
          sides(head),
        ),
      ).toEqual([]);
    }
  });

  it('refuses a language’s entry added, changed or removed without translation.manage', async () => {
    for (const next of [
      design({ de: designEntry('2') }),
      design(),
      design({ de: designEntry('1'), fr: designEntry('2') }),
    ]) {
      expect(
        await refusedRecordLanguages(editor, DESIGN, next, sides(head)),
      ).not.toEqual([]);
      expect(
        await refusedRecordLanguages(manager, DESIGN, next, sides(head)),
      ).toEqual([]);
    }
    expect(
      await refusedRecordLanguages(
        editor,
        MANUAL,
        manual({ de: entry('2'), fr: entry('2') }),
        sides(head),
      ),
    ).toEqual(['de', 'fr']);
  });

  it('lets a restricted manager change only their languages', async () => {
    expect(
      await refusedRecordLanguages(
        german,
        DESIGN,
        design({ de: designEntry('2'), fr: designEntry('2') }),
        sides(head),
      ),
    ).toEqual(['fr']);
    expect(
      await refusedRecordLanguages(
        german,
        MANUAL,
        manual({ de: entry('2') }),
        sides(head),
      ),
    ).toEqual([]);
  });

  it('judges a manual’s record by its audience, as committed and as written', async () => {
    // A design is every manual's look: a role limited by audience manages none.
    expect(
      await refusedRecordLanguages(
        publicOnly,
        DESIGN,
        design({ de: designEntry('2') }),
        sides(head),
      ),
    ).toEqual(['de']);
    expect(
      await refusedRecordLanguages(
        publicOnly,
        MANUAL,
        manual({ de: entry('2') }),
        sides(head),
      ),
    ).toEqual([]);
    expect(
      await refusedRecordLanguages(
        publicOnly,
        MANUAL,
        manual({ de: entry('2') }, 'internal'),
        sides(head),
      ),
    ).toEqual(['de']);
    const internal = at({ manual: manual({ de: entry('1') }, 'internal') });
    expect(
      await refusedRecordLanguages(
        publicOnly,
        MANUAL,
        manual({ de: entry('2') }),
        sides(internal),
      ),
    ).toEqual(['de']);
  });

  it('lets anyone put the base’s entry back', async () => {
    const base = at({ design: design({ de: designEntry('0') }) });
    expect(
      await refusedRecordLanguages(
        editor,
        DESIGN,
        design({ de: designEntry('0') }),
        sides(head, base),
      ),
    ).toEqual([]);
    expect(
      await refusedRecordLanguages(
        editor,
        DESIGN,
        design({ de: designEntry('9') }),
        sides(head, base),
      ),
    ).toEqual(['de']);
    // A base that cannot be opened holds no record.
    expect(
      await refusedRecordLanguages(
        editor,
        DESIGN,
        design({ de: designEntry('0') }),
        sides(head),
      ),
    ).toEqual(['de']);
  });

  it('reads a subject with no file, or a broken one, as holding no record', async () => {
    const none = at({});
    expect(
      await refusedRecordLanguages(
        editor,
        DESIGN,
        design({ de: designEntry('1') }),
        sides(none),
      ),
    ).toEqual(['de']);
    expect(
      await refusedRecordLanguages(editor, DESIGN, design(), sides(none)),
    ).toEqual([]);
    expect(
      await refusedRecordLanguages(
        editor,
        DESIGN,
        undefined as RecordHolder | undefined,
        sides(none),
      ),
    ).toEqual([]);
  });
});

describe('refuseRecordChanges (#663)', () => {
  const head = at({
    design: design({ de: designEntry('1') }),
    manual: manual({ de: entry('1') }),
  });

  it('checks the designs and manifests a commit writes, as their printed files', async () => {
    const refused = refuseRecordChanges(
      editor,
      [
        { path: 'modules/en/a.adoc', content: 'anything' },
        {
          path: 'manuals/guide.yaml',
          content: printManifest(manual({ de: entry('2') })),
        },
      ],
      sides(head),
    );
    await expect(refused).rejects.toBeInstanceOf(UnprocessableError);
    await expect(refused).rejects.toMatchObject({
      code: 'translation-record-protected',
      meta: { subject: MANUAL, languages: ['de'] },
    });
  });

  it('takes a deletion, and a file that keeps its record', async () => {
    await expect(
      refuseRecordChanges(
        editor,
        [
          { path: 'design/minimal.yaml', delete: true },
          {
            path: 'manuals/guide.yaml',
            content: printManifest({
              ...manual({ de: entry('1') }),
              title: 'Renamed',
            }),
          },
        ],
        sides(head),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('the configuration’s record (#731)', () => {
  const CONFIG = { type: 'config' } as const;
  const labelEntry = (hash: string) => ({
    sourceCommit: COMMIT,
    blocks: { 'audiences.public': hash.repeat(64) },
  });
  const labelled = (
    translations?: ProjectConfig['translations'],
  ): ProjectConfig => ({ ...config, ...(translations && { translations }) });
  const head = readable({ config: labelled({ de: labelEntry('1') }) });

  it('lets anyone keep it as the head has it, and only a manager of the language change it', async () => {
    expect(
      await refusedRecordLanguages(
        editor,
        CONFIG,
        labelled({ de: labelEntry('1') }),
        sides(head),
      ),
    ).toEqual([]);
    for (const next of [
      labelled({ de: labelEntry('2') }),
      labelled(),
      labelled({ de: labelEntry('1'), fr: labelEntry('2') }),
    ]) {
      expect(
        await refusedRecordLanguages(editor, CONFIG, next, sides(head)),
      ).not.toEqual([]);
      expect(
        await refusedRecordLanguages(manager, CONFIG, next, sides(head)),
      ).toEqual([]);
    }
    expect(
      await refusedRecordLanguages(
        german,
        CONFIG,
        labelled({ de: labelEntry('2'), fr: labelEntry('2') }),
        sides(head),
      ),
    ).toEqual(['fr']);
  });

  it('takes a manager only in a role restricting nothing but languages, as for a design', async () => {
    expect(
      await refusedRecordLanguages(
        publicOnly,
        CONFIG,
        labelled({ de: labelEntry('2') }),
        sides(head),
      ),
    ).toEqual(['de']);
  });

  it('reads the record from ccms.yaml where only that is there (#372)', async () => {
    const legacy = readable({
      config: labelled({ de: labelEntry('1') }),
      legacyConfigFile: true,
    });
    expect(
      await refusedRecordLanguages(
        editor,
        CONFIG,
        labelled({ de: labelEntry('1') }),
        sides(legacy),
      ),
    ).toEqual([]);
    await expect(
      refuseRecordChanges(
        editor,
        [{ path: 'openfolia.yaml', content: printConfig(labelled()) }],
        sides(legacy),
      ),
    ).rejects.toMatchObject({ code: 'translation-record-protected' });
  });

  it('lets anyone put the base’s entry back', async () => {
    const base = readable({ config: labelled({ de: labelEntry('0') }) });
    expect(
      await refusedRecordLanguages(
        editor,
        CONFIG,
        labelled({ de: labelEntry('0') }),
        sides(head, base),
      ),
    ).toEqual([]);
  });

  it('checks openfolia.yaml in a commit, as its printed file', async () => {
    const refused = refuseRecordChanges(
      editor,
      [{ path: 'openfolia.yaml', content: printConfig(labelled()) }],
      sides(head),
    );
    await expect(refused).rejects.toMatchObject({
      code: 'translation-record-protected',
      meta: { subject: CONFIG, languages: ['de'] },
    });
    await expect(
      refuseRecordChanges(
        editor,
        [
          {
            path: 'openfolia.yaml',
            content: printConfig({
              ...labelled({ de: labelEntry('1') }),
              audiences: [
                { id: 'public', label: { en: 'Public', de: 'Öffentlich' } },
                { id: 'internal', label: 'Internal' },
              ],
            }),
          },
        ],
        sides(head),
      ),
    ).resolves.toBeUndefined();
  });
});
