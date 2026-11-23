import { ProjectConfig } from './config.js';
import {
  DEFAULT_OUTPUT_LABELS,
  formatFileSize,
  OUTPUT_LABEL_KEYS,
  resolveOutputLabels,
} from './labels.js';

describe('resolveOutputLabels', () => {
  it('ships a complete English set', () => {
    for (const key of OUTPUT_LABEL_KEYS) {
      expect(DEFAULT_OUTPUT_LABELS.en[key]).toBeTruthy();
    }
    expect(resolveOutputLabels('en').missing).toEqual([]);
  });

  it('uses the shipped German labels for German and its regions', () => {
    for (const lang of ['de', 'de-AT']) {
      const { labels, missing } = resolveOutputLabels(lang);
      expect(missing).toEqual([]);
      expect(labels.danger).toBe('GEFAHR');
      expect(labels.contents).toBe('Inhalt');
    }
  });

  it('lets the configuration override a label, for the exact tag before the base language', () => {
    const { labels } = resolveOutputLabels('de-CH', {
      de: { contents: 'Inhaltsverzeichnis' },
      'de-CH': { tip: 'Tipp (CH)' },
    });
    expect(labels.contents).toBe('Inhaltsverzeichnis');
    expect(labels.tip).toBe('Tipp (CH)');
    expect(labels.danger).toBe('GEFAHR');
  });

  it('falls back to English per key and lists what is missing', () => {
    const { labels, missing } = resolveOutputLabels('nl', {
      nl: { danger: 'GEVAAR' },
    });
    expect(labels.danger).toBe('GEVAAR');
    expect(labels.warning).toBe('WARNING');
    expect(missing).not.toContain('danger');
    expect(missing).toContain('warning');
    expect(missing).toHaveLength(OUTPUT_LABEL_KEYS.length - 1);
  });

  it('is part of the configuration, which refuses unknown keys', () => {
    const base = {
      languages: { source: 'en', targets: [] },
      moduleTypes: [{ id: 'topic', label: 'Topic' }],
      audiences: [{ id: 'internal', label: 'Internal' }],
    };
    expect(ProjectConfig.parse(base).outputLabels).toEqual({});
    expect(
      ProjectConfig.parse({ ...base, outputLabels: { nl: { tip: 'Tip' } } })
        .outputLabels,
    ).toEqual({ nl: { tip: 'Tip' } });
    expect(
      ProjectConfig.safeParse({
        ...base,
        outputLabels: { nl: { banner: 'x' } },
      }).success,
    ).toBe(false);
    expect(
      ProjectConfig.safeParse({ ...base, outputLabels: { 'not a tag': {} } })
        .success,
    ).toBe(false);
  });
});

describe('formatFileSize', () => {
  it('formats in decimal units in the language given', () => {
    expect(formatFileSize(0, 'en')).toBe('0 bytes');
    expect(formatFileSize(1, 'en')).toBe('1 byte');
    // A plural where English has one (#690).
    expect(formatFileSize(68, 'en')).toBe('68 bytes');
    expect(formatFileSize(68, 'de')).toBe('68 Byte');
    expect(formatFileSize(999, 'en')).toBe('999 bytes');
    expect(formatFileSize(12_345, 'en')).toBe('12.3 kB');
    expect(formatFileSize(12_345_678, 'de')).toBe('12,3 MB');
    expect(formatFileSize(2e9, 'en')).toBe('2 GB');
    // A backup store or a storage limit (#690).
    expect(formatFileSize(2.5e12, 'en')).toBe('2.5 TB');
  });

  it('falls back to English for a tag Intl does not take', () => {
    expect(formatFileSize(1500, 'not a tag')).toBe('1.5 kB');
  });
});
