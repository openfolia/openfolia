import { rmSync } from 'node:fs';
import { validatePageDesign } from '@openfolia/content-model';
import {
  addSampleNoticeLeaflet,
  addSamplePageDesigns,
  addSampleRtlLanguages,
  addSampleSafetyLeaflet,
  addSampleSnippets,
  addSampleTerms,
  createBareSampleRepo,
  SAMPLE_LEAFLET_DESIGN_ID,
  SAMPLE_LEAFLET_ID,
  SAMPLE_NOTICE_LEAFLET_ID,
} from '../testing.js';
import type { ResolvedEntry } from '@openfolia/content-model';
import { ContentRepo } from './snapshot.js';

describe('derived manuals (#451)', () => {
  let dir: string | undefined;
  let repo: ContentRepo | undefined;
  beforeAll(async () => {
    dir = createBareSampleRepo().dir;
    // In the local sample's order (`api:setup-local`).
    await addSampleSnippets(dir);
    await addSampleTerms(dir);
    await addSampleRtlLanguages(dir);
    await addSamplePageDesigns(dir);
    await addSampleSafetyLeaflet(dir);
    await addSampleNoticeLeaflet(dir);
    repo = ContentRepo.open(dir);
  });
  // Safe when `beforeAll` failed part way: it closes and removes only what it made.
  afterAll(() => {
    repo?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the stored manifest as it is, without entries', async () => {
    const snapshot = await repo!.at('main');
    const manifest = await snapshot?.manifest(SAMPLE_LEAFLET_ID);
    expect(manifest?.kind).toBe('derived');
    expect(manifest?.entries).toEqual([]);
  });

  it('gathers the safety modules of its source, each once, in its order', async () => {
    const snapshot = (await repo!.at('main'))!;
    const derived = await snapshot.derive(
      (await snapshot.manifest(SAMPLE_LEAFLET_ID))!,
    );
    expect(derived.manifest.entries).toEqual([
      { module: 'leaflet-intro' },
      { module: 'battery-hazards' },
      {
        module: 'crush-hazard',
        when: { op: 'in', attr: 'model', values: ['large'] },
      },
    ]);
    expect(derived.issues).toEqual([]);
    // The source's text attributes, to resolve it with.
    expect(Object.keys(derived.attributes)).toEqual(['product-name']);
  });

  it('resolves it per variant and language, with the source text attributes', async () => {
    const snapshot = (await repo!.at('main'))!;
    const small = await snapshot.resolve(
      SAMPLE_LEAFLET_ID,
      { model: 'small' },
      'de',
    );
    expect(
      small?.manual.entries.map((e) =>
        e.kind === 'module' ? [e.module, e.lang] : e.title,
      ),
    ).toEqual([
      ['leaflet-intro', 'en'],
      ['battery-hazards', 'de'],
    ]);
    const large = await snapshot.resolve(
      SAMPLE_LEAFLET_ID,
      { model: 'large' },
      'en',
    );
    expect(
      large?.manual.entries.map((e) => e.kind === 'module' && e.module),
    ).toEqual(['leaflet-intro', 'battery-hazards', 'crush-hazard']);
    expect(JSON.stringify(large?.manual.entries[0])).toContain('Model A');
    expect(
      large?.issues.filter((i) => i.code === 'missing-text-attribute'),
    ).toEqual([]);
  });

  it('is printed with the leaflet design: A5, the minimal preset, without issues (#668)', async () => {
    const snapshot = (await repo!.at('main'))!;
    const manifest = (await snapshot.manifest(SAMPLE_LEAFLET_ID))!;
    expect(manifest.design).toBe(SAMPLE_LEAFLET_DESIGN_ID);
    const design = await snapshot.pageDesign(SAMPLE_LEAFLET_DESIGN_ID);
    expect(design?.preset).toBe('minimal');
    expect(design?.page.size).toBe('a5');
    expect(design?.headings.pageBreakBeforeLevel1).toBe(false);
    expect(validatePageDesign(design!, await snapshot.config())).toEqual([]);
  });

  it('gives an assembled manifest back as it is', async () => {
    const snapshot = (await repo!.at('main'))!;
    const operating = (await snapshot.manifest('operating'))!;
    expect((await snapshot.derive(operating)).manifest).toBe(operating);
  });
});

describe('derived manuals gathering notices (#670)', () => {
  let dir: string | undefined;
  let repo: ContentRepo | undefined;
  beforeAll(async () => {
    dir = createBareSampleRepo().dir;
    await addSampleSafetyLeaflet(dir);
    await addSampleNoticeLeaflet(dir);
    repo = ContentRepo.open(dir);
  });
  // Safe when `beforeAll` failed part way: it closes and removes only what it made.
  afterAll(() => {
    repo?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** Each entry as `title: block IDs`, a group as `{ title: […] }`. */
  const outline = (entries: readonly ResolvedEntry[]): unknown[] =>
    entries.map((e) =>
      e.kind === 'group'
        ? { [e.title]: outline(e.entries) }
        : `${e.title}: ${e.blocks.map((b) => b.id).join(' ')}`,
    );

  it('gathers the modules holding notices, themselves or through a reference, whatever their type', async () => {
    const snapshot = (await repo!.at('main'))!;
    const derived = await snapshot.derive(
      (await snapshot.manifest(SAMPLE_NOTICE_LEAFLET_ID))!,
    );
    expect(
      derived.manifest.entries.map((e) => 'module' in e && e.module),
    ).toEqual([
      'leaflet-intro',
      'battery-hazards',
      // A procedure whose notice is in the module it refers to (`safety-note`).
      'charging',
      'crush-hazard',
      'hose-connection',
    ]);
    expect(derived.issues).toEqual([]);
  });

  it('resolves grouped by level per variant and language, the variant’s notices only', async () => {
    const snapshot = (await repo!.at('main'))!;
    const large = await snapshot.resolve(
      SAMPLE_NOTICE_LEAFLET_ID,
      { model: 'large' },
      'en',
    );
    expect(outline(large!.manual.entries)).toEqual([
      'About this leaflet: leaflet-intro--text',
      { DANGER: ['Crush hazard: crush-hazard--notice'] },
      {
        WARNING: [
          'Battery hazards: battery-hazards--notice',
          'Connecting the hose: hose-connection--overload',
        ],
      },
      {
        CAUTION: [
          'Charging: safety-note--hot',
          'Connecting the hose: hose-connection--pinch',
        ],
      },
    ]);
    const small = await snapshot.resolve(
      SAMPLE_NOTICE_LEAFLET_ID,
      { model: 'small' },
      'de',
    );
    expect(outline(small!.manual.entries)).toEqual([
      'About this leaflet: leaflet-intro--text',
      { WARNUNG: ['Gefahren durch die Batterie: battery-hazards--notice'] },
      {
        // `safety-note` has no German translation: its English is used, under `charging`'s title.
        VORSICHT: [
          'Laden: safety-note--hot',
          'Den Schlauch anschließen: hose-connection--pinch',
        ],
      },
    ]);
    expect(small!.hidden).toContainEqual(
      expect.objectContaining({
        kind: 'block',
        module: 'hose-connection',
        block: 'large-tank',
      }),
    );
  });
});
