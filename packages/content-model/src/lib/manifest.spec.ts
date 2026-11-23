import { readFileSync } from 'node:fs';
import { sampleConfig } from '../fixtures/config.js';
import { ProjectConfig } from './config.js';
import {
  ManifestParseError,
  parseManifest,
  printManifest,
} from './manifest-yaml.js';
import { validateManifest } from './validate.js';

const yaml = readFileSync(
  new URL('../fixtures/operating-manual.yaml', import.meta.url),
  'utf8',
);
const config = ProjectConfig.parse(sampleConfig);

describe('manifest YAML', () => {
  it('parses conditions into trees', () => {
    const manifest = parseManifest(yaml, { id: 'operating-manual' });
    expect(manifest.entries[1]).toEqual({
      module: 'battery-disposal',
      when: { op: 'in', attr: 'market', values: ['eu'] },
    });
    expect(manifest.variants[2]).toEqual({
      market: 'us',
      model: 'l-400',
      software: '2.10.1',
    });
  });

  it('prints the fixture back exactly', () => {
    expect(printManifest(parseManifest(yaml, { id: 'operating-manual' }))).toBe(
      yaml,
    );
  });

  it('reports schema problems with their path', () => {
    expect(() =>
      parseManifest('schemaVersion: 1\ntitle: T\nvariants: []\nentries: []\n', {
        id: 'm',
      }),
    ).toThrow(/variants: Too small.*entries: at least one entry/);
    expect(() =>
      parseManifest(
        'schemaVersion: 1\ntitle: T\nvariants: [{}]\nentries:\n  - module: a\n    when: model ==\n',
        { id: 'm' },
      ),
    ).toThrow(ManifestParseError);
    expect(() => parseManifest('- a list', { id: 'm' })).toThrow(
      /must be a YAML mapping/,
    );
  });
});

describe('manifest deprecation', () => {
  const base = parseManifest(yaml, { id: 'operating-manual' });

  it('prints and reads it back after the audience', () => {
    const manifest = {
      ...base,
      deprecated: { reason: 'Superseded.', replacedBy: 'service-manual' },
    };
    const printed = printManifest(manifest);
    expect(printed).toMatch(
      /deprecated:\n {2}reason: Superseded\.\n {2}replacedBy: service-manual\nvariants:/,
    );
    expect(parseManifest(printed, { id: 'operating-manual' })).toEqual(
      manifest,
    );
  });

  it('refuses unknown members in it', () => {
    expect(() =>
      parseManifest(
        printManifest({ ...base, deprecated: { reason: 'Old.' } }).replace(
          'reason: Old.',
          'reason: Old.\n  since: 2',
        ),
        { id: 'operating-manual' },
      ),
    ).toThrow(ManifestParseError);
  });

  it('warns when it names itself as its replacement', () => {
    const issues = validateManifest(
      {
        ...base,
        deprecated: { reason: 'Old.', replacedBy: 'operating-manual' },
      },
      config,
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'unknown-replacement',
        severity: 'warning',
      }),
    );
  });
});

describe('validateManifest', () => {
  it('accepts the fixture', () => {
    expect(
      validateManifest(parseManifest(yaml, { id: 'operating-manual' }), config),
    ).toEqual([]);
  });

  it('checks variants, attributes, conditions and audience against the configuration', () => {
    const manifest = parseManifest(
      [
        'schemaVersion: 1',
        'title: T',
        'audience: partners',
        'variants:',
        '  - { model: l-900, software: latest }',
        '  - { model: l-200, colour: red }',
        'attributes:',
        '  max-speed: 2 m/s',
        'entries:',
        '  - module: a',
        '    when: market in (mars)',
      ].join('\n'),
      { id: 'm' },
    );
    expect(validateManifest(manifest, config).map((i) => i.code)).toEqual([
      'unknown-audience',
      'unknown-variant-value',
      'invalid-version-value',
      'unknown-variant-attribute',
      'inconsistent-variants',
      'unknown-text-attribute',
      'unknown-variant-value',
    ]);
  });
});
