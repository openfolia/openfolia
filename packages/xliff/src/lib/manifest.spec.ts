import {
  coverUnitKey,
  groupUnitKey,
  Manifest,
  ProjectConfig,
  textIn,
} from '@openfolia/content-model';
import { xliffSchemaErrors } from '../testing/validate.js';
import { readXliff } from './read.js';
import { targetParts } from './target.js';
import { xliffUnitsOfConfig, xliffUnitsOfManifest } from './units.js';
import { writeXliff } from './write.js';

const ASSET = 'sha256:' + 'a'.repeat(64);

/** A manual with its own cover image and a variant's, its alternative text holding markup-like text. */
const manifest = Manifest.parse({
  schemaVersion: 1,
  id: 'operating',
  title: 'Operating manual',
  variants: [{ model: 'l-200' }, { model: 'l-400' }],
  coverImage: {
    default: { asset: ASSET, alt: 'The <b>vehicle</b> & "#set" text' },
    variants: [
      { variant: { model: 'l-400' }, asset: ASSET, alt: { en: 'The L-400' } },
    ],
  },
  entries: [{ module: 'battery-charging' }],
});

const variantKey = coverUnitKey({ model: 'l-400' });

const xml = () =>
  writeXliff({
    srcLang: 'en',
    trgLang: 'de',
    meta: { job: 'job-1', commit: 'a'.repeat(40) },
    modules: [
      {
        moduleId: 'manual.operating',
        title: textIn(manifest.title, 'en', 'en'),
        original: 'manuals/operating.yaml',
        units: xliffUnitsOfManifest(manifest, 'en'),
      },
    ],
  });

const withTarget = (id: string, target: string) =>
  xml().replace(
    new RegExp(`(<unit id="${id.replace('.', '\\.')}"[\\s\\S]*?</source>)`),
    `$1\n        <target>${target}</target>`,
  );

describe('a manifest’s cover image alternative text in XLIFF (#656)', () => {
  it('writes a file of its own, a unit per cover image, its text escaped, schema-valid', async () => {
    const out = xml();
    expect(await xliffSchemaErrors(out)).toEqual([]);
    expect(out).toContain(
      '<file id="manual.operating" original="manuals/operating.yaml">',
    );
    expect(out).toContain('<unit id="coverImage.default"');
    expect(out).toContain(`<unit id="${variantKey}"`);
    expect(out).toContain('ccms:kind="image"');
    expect(out).toContain('<segment id="alt">');
    expect(out).toContain('The &lt;b&gt;vehicle&lt;/b&gt; &amp; "#set" text');
    expect(out).toContain(
      '<note category="ccms:path">coverImage#model=l-400</note>',
    );
  });

  it('reads a translation back as plain text', () => {
    const read = readXliff(withTarget(variantKey, 'Der L-400 &lt;i&gt;'));
    const unit = read.files[0]?.units.find((u) => u.blockId === variantKey);
    const sent = xliffUnitsOfManifest(manifest, 'en', new Set([variantKey]))[0];
    expect(targetParts(sent as never, unit as never)).toEqual({
      ok: true,
      parts: [
        { field: 'alt', content: [{ type: 'text', text: 'Der L-400 <i>' }] },
      ],
    });
  });

  it('refuses inline codes in the target, as the source has none', () => {
    const read = readXliff(
      withTarget(
        'coverImage.default',
        'Das <pc id="1" type="fmt" subType="xlf:b">Fahrzeug</pc>',
      ),
    );
    const unit = read.files[0]?.units.find(
      (u) => u.blockId === 'coverImage.default',
    );
    const sent = xliffUnitsOfManifest(
      manifest,
      'en',
      new Set(['coverImage.default']),
    )[0];
    expect(targetParts(sent as never, unit as never).ok).toBe(false);
  });
});

describe('a manual’s title, its groups and the configured labels in XLIFF (#731)', () => {
  const grouped = Manifest.parse({
    ...manifest,
    title: { en: 'Operating manual', de: 'Betriebsanleitung' },
    entries: [
      { title: 'Operation', entries: [{ module: 'battery-charging' }] },
    ],
  });
  const config = ProjectConfig.parse({
    languages: { source: 'en', targets: ['de'] },
    moduleTypes: [{ id: 'task', label: { en: 'Task', de: 'Handlung' } }],
    audiences: [{ id: 'owner', label: 'Owners' }],
    variantAttributes: [
      {
        id: 'market',
        label: 'Market',
        kind: 'enum',
        values: [{ id: 'eu', label: 'EU (left-hand drive)' }],
      },
    ],
  });

  it('writes the title and each group as a title segment, schema-valid', async () => {
    const units = xliffUnitsOfManifest(grouped, 'en');
    expect(units.slice(0, 2).map((u) => [u.blockId, u.path])).toEqual([
      ['title', ['title#manual']],
      [
        groupUnitKey('Operation'),
        [`group#${groupUnitKey('Operation').slice(6)}`],
      ],
    ]);
    const out = writeXliff({
      srcLang: 'en',
      trgLang: 'de',
      meta: { job: 'job-1', commit: 'a'.repeat(40) },
      modules: [
        {
          moduleId: 'manual.operating',
          title: 'Operating manual',
          original: 'manuals/operating.yaml',
          units,
        },
        {
          moduleId: 'config.project',
          title: 'Project labels',
          original: 'openfolia.yaml',
          units: xliffUnitsOfConfig(config),
        },
      ],
    });
    expect(await xliffSchemaErrors(out)).toEqual([]);
    expect(out).toContain('<unit id="title"');
    expect(out).toContain('<segment id="title">');
    expect(out).toContain('<unit id="variantAttributes.market.eu"');
    expect(out).toContain(
      '<note category="ccms:path">label#audiences.owner</note>',
    );
    expect(out).toContain('EU (left-hand drive)');
  });
});
