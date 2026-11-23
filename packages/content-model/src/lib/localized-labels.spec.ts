import { sampleConfig } from '../fixtures/config.js';
import { chargingProcedure } from '../fixtures/modules.js';
import { ProjectConfig, StrictProjectConfig } from './config.js';
import {
  compareConfigWithRecord,
  configSourceHashes,
  hasConfigTranslation,
  markConfigCurrent,
  mergeConfigTranslation,
} from './config-translation.js';
import {
  configUnits,
  labelOf,
  labelsIn,
  variantLabel,
} from './config-units.js';
import { parseConfig, printConfig } from './config-yaml.js';
import {
  ownTextIn,
  sourceTextOf,
  textIn,
  withTextIn,
} from './localized-text.js';
import { Manifest } from './manifest.js';
import { Module } from './module.js';
import { DEFAULT_PAGE_DESIGN } from './page-design.js';
import { resolvePageDesign } from './page-design-resolve.js';
import { resolveManual } from './resolve.js';
import { validateManifest } from './validate.js';

const COMMIT = 'c'.repeat(40);

/** The sample configuration with labels per language where #731 allows them. */
const labelled = () =>
  ProjectConfig.parse({
    ...sampleConfig,
    moduleTypes: [
      { id: 'concept', label: { en: 'Concept', de: 'Konzept' } },
      { id: 'procedure', label: 'Procedure' },
    ],
    audiences: [
      { id: 'public', label: 'Public' },
      { id: 'customer', label: { en: 'Customers', de: 'Kunden' } },
    ],
    variantAttributes: [
      {
        id: 'model',
        label: { en: 'Model', de: 'Modell' },
        kind: 'enum',
        values: [
          { id: 'l-200', label: 'L-200' },
          { id: 'l-400', label: { en: 'L-400 long', de: 'L-400 lang' } },
        ],
      },
      {
        id: 'software',
        label: { en: 'Software', de: 'Software' },
        kind: 'version',
      },
    ],
  });

describe('a text per language', () => {
  it('falls back to the source language, then its first version', () => {
    const text = { en: 'Operating manual', de: 'Betriebsanleitung' };
    expect(textIn(text, 'de', 'en')).toBe('Betriebsanleitung');
    expect(textIn(text, 'fr', 'en')).toBe('Operating manual');
    expect(textIn('One text', 'de', 'en')).toBe('One text');
    expect(textIn({ de: 'Nur' }, 'fr', 'en')).toBe('Nur');
    expect(ownTextIn('One text', 'en', 'en')).toBe('One text');
    expect(ownTextIn('One text', 'de', 'en')).toBeUndefined();
    expect(sourceTextOf({ de: 'Nur' }, 'en')).toBeUndefined();
  });

  it('turns one text into a map when a language gets its own, and back', () => {
    const de = withTextIn('Task', 'de', 'en', 'Handlung');
    expect(de).toEqual({ en: 'Task', de: 'Handlung' });
    expect(withTextIn(de, 'en', 'en', 'Tasks')).toEqual({
      en: 'Tasks',
      de: 'Handlung',
    });
    expect(withTextIn(de, 'de', 'en', '')).toBe('Task');
    expect(withTextIn('Task', 'en', 'en', 'Tasks')).toBe('Tasks');
    // The source language's is never removed.
    expect(withTextIn(de, 'en', 'en', undefined)).toBe(de);
  });
});

describe('labels per language in openfolia.yaml (#731)', () => {
  it('prints one label as it was written, and a label per language sorted', () => {
    const plain = ProjectConfig.parse(sampleConfig);
    const text = printConfig(plain);
    expect(text).toContain('- id: concept\n    label: Concept\n');
    expect(printConfig(parseConfig(text))).toBe(text);

    const config = labelled();
    const printed = printConfig(config);
    expect(printed).toContain(
      '- id: concept\n    label:\n      de: Konzept\n      en: Concept\n',
    );
    expect(parseConfig(printed)).toEqual(config);
    expect(printConfig(parseConfig(printed))).toBe(printed);
  });

  it('refuses a label per language without the source language’s when it is stored', () => {
    const input = {
      ...sampleConfig,
      audiences: [{ id: 'public', label: { de: 'Öffentlich' } }],
    };
    expect(ProjectConfig.safeParse(input).success).toBe(true);
    const strict = StrictProjectConfig.safeParse(input);
    expect(strict.success).toBe(false);
    expect(strict.error?.issues[0]?.path).toEqual(['audiences', 'public']);
  });

  it('shows labels in a language, falling back to the source language', () => {
    const config = labelled();
    const de = labelsIn(config, 'de');
    expect(de.moduleTypes.map((t) => t.label)).toEqual([
      'Konzept',
      'Procedure',
    ]);
    const fr = labelsIn(config, 'fr');
    expect(fr.audiences.map((a) => a.label)).toEqual(['Public', 'Customers']);
    expect(labelOf(config, 'audiences', 'customer', 'de')).toBe('Kunden');
    expect(labelOf(config, 'audiences', 'nobody', 'de')).toBeUndefined();
    expect(
      variantLabel({ model: 'l-400', software: '2.3' }, config, 'de'),
    ).toBe('L-400 lang · Software 2.3');
    expect(variantLabel({ model: 'l-900' }, config, 'de')).toBe('l-900');
  });

  it('lists every label as a unit, values after their attribute', () => {
    const keys = configUnits(labelled(), 'en').map((u) => u.blockId);
    expect(keys.slice(0, 4)).toEqual([
      'moduleTypes.concept',
      'moduleTypes.procedure',
      'audiences.public',
      'audiences.customer',
    ]);
    expect(keys).toContain('facets.product-line.tuggers');
    expect(keys.indexOf('variantAttributes.model.l-400')).toBe(
      keys.indexOf('variantAttributes.model') + 2,
    );
  });

  it('merges, compares and marks current a translation of the labels', () => {
    const config = labelled();
    const states = compareConfigWithRecord(config, 'de');
    expect(states.find((s) => s.blockId === 'moduleTypes.concept')?.state).toBe(
      'outdated',
    );
    expect(
      states.find((s) => s.blockId === 'moduleTypes.procedure')?.state,
    ).toBe('missing');
    expect(hasConfigTranslation(config, 'de')).toBe(true);
    expect(hasConfigTranslation(config, 'fr')).toBe(false);

    const hash = configSourceHashes(config).get('moduleTypes.procedure') ?? '';
    const merged = mergeConfigTranslation(
      config,
      'de',
      COMMIT,
      new Map([['moduleTypes.procedure', { text: 'Handlung', hash }]]),
    );
    expect(merged.moduleTypes[1]?.label).toEqual({
      en: 'Procedure',
      de: 'Handlung',
    });
    expect(merged.translations).toEqual({
      de: { sourceCommit: COMMIT, blocks: { 'moduleTypes.procedure': hash } },
    });
    expect(
      compareConfigWithRecord(merged, 'de').find(
        (s) => s.blockId === 'moduleTypes.procedure',
      )?.state,
    ).toBe('up-to-date');
    // Printed and read back with its record.
    expect(parseConfig(printConfig(merged))).toEqual(merged);

    const marked = markConfigCurrent(merged, 'de', COMMIT);
    expect(marked.units).toBe(6);
    expect(
      compareConfigWithRecord(marked.config, 'de')
        .filter((s) => s.state === 'outdated')
        .map((s) => s.blockId),
    ).toEqual([]);
    expect(
      mergeConfigTranslation(
        config,
        'de',
        COMMIT,
        new Map([['moduleTypes.gone', { text: 'X', hash }]]),
      ),
    ).toBe(config);
  });
});

describe('a manual’s title per language (#731)', () => {
  const config = labelled();
  const manifest = Manifest.parse({
    schemaVersion: 1,
    id: 'operating-manual',
    title: { en: 'Operating manual', de: 'Betriebsanleitung' },
    audience: 'customer',
    variants: [{ model: 'l-400', software: '2.3' }],
    entries: [
      {
        title: { en: 'Operation', de: 'Bedienung' },
        entries: [{ module: 'battery-charging' }],
      },
    ],
  });
  const module = Module.parse(chargingProcedure);
  const loadModule = (id: string, lang: string) =>
    id === module.id && lang === 'en' ? module : undefined;

  it('resolves the title and the groups’ titles in the manual’s language', () => {
    const de = resolveManual({
      manifest,
      variant: { model: 'l-400', software: '2.3' },
      lang: 'de',
      config,
      loadModule,
    }).manual;
    expect(de.title).toBe('Betriebsanleitung');
    expect(de.entries[0]).toMatchObject({ kind: 'group', title: 'Bedienung' });
    const fr = resolveManual({
      manifest,
      variant: { model: 'l-400', software: '2.3' },
      lang: 'fr',
      config,
      loadModule,
    }).manual;
    expect(fr.title).toBe('Operating manual');
    expect(fr.entries[0]).toMatchObject({ title: 'Operation' });
  });

  it('fills the title page’s title, variant and audience in the manual’s language', () => {
    const { design } = resolvePageDesign({
      design: DEFAULT_PAGE_DESIGN,
      manifest,
      variant: { model: 'l-400', software: '2.3' },
      lang: 'de',
      config,
    });
    expect(design.placeholders).toMatchObject({
      title: 'Betriebsanleitung',
      variant: 'L-400 lang · Software 2.3',
      audience: 'Kunden',
    });
  });

  it('reports a title without the source language’s, and a language not configured', () => {
    const issues = validateManifest(
      Manifest.parse({
        ...manifest,
        title: { de: 'Betriebsanleitung', ja: '取扱説明書' },
        entries: [
          { title: { en: 'Operation', xx: 'X' }, entries: [{ module: 'a' }] },
        ],
      }),
      config,
    );
    expect(issues.map((i) => [i.code, i.at])).toEqual([
      ['missing-source-title', 'title'],
      ['unknown-language', 'title.ja'],
      ['unknown-language', 'Operation.xx'],
    ]);
  });
});
