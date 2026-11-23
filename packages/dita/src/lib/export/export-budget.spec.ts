import type { Module } from '@openfolia/content-model';
import { describe, expect, it, vi } from 'vitest';
import {
  SAMPLE_MANUAL,
  SAMPLE_MODULES,
  sampleInput,
} from '../../testing/export-sample.js';
import { DitaExportTooLargeError, exportDita } from './export.js';
import * as xml from './xml.js';

vi.mock('./xml.js', async (original) => {
  const actual = await original<typeof import('./xml.js')>();
  return { ...actual, ditaFile: vi.fn(actual.ditaFile) };
});

describe('exportDita’s character bound', () => {
  it('refuses a topic past it before writing the topic’s text', () => {
    const huge: Module = {
      ...(SAMPLE_MODULES[1] as Module),
      id: 'huge',
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: '"'.repeat(200_000) }],
        },
      ],
    };
    const ditaFile = vi.mocked(xml.ditaFile);
    ditaFile.mockClear();
    expect(() =>
      exportDita(
        sampleInput({
          languages: ['en'],
          manifest: { ...SAMPLE_MANUAL, entries: [{ module: 'huge' }] },
          module: (id) => (id === 'huge' ? huge : undefined),
          limits: { maxChars: 100_000 },
        }),
      ),
    ).toThrow(DitaExportTooLargeError);
    const written = ditaFile.mock.calls.map(([root]) => root.name);
    expect(written).not.toContain('topic');
  });

  it('stops while writing once the escaped text passes it', () => {
    const quotes: Module = {
      ...(SAMPLE_MODULES[1] as Module),
      id: 'quotes',
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: '"'.repeat(50_000) }],
        },
      ],
    };
    // 50,000 characters before escaping, 300,000 after.
    expect(() =>
      exportDita(
        sampleInput({
          languages: ['en'],
          manifest: { ...SAMPLE_MANUAL, entries: [{ module: 'quotes' }] },
          module: (id) => (id === 'quotes' ? quotes : undefined),
          limits: { maxChars: 200_000 },
        }),
      ),
    ).toThrow(DitaExportTooLargeError);
  });
});
