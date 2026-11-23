import { describe, expect, it } from 'vitest';
import { fixtureConfig, fixtureFiles } from '../testing/fixture.js';
import { bundleFiles, convertDita } from './convert.js';
import { ConversionLimitError, convertDitaIsolated } from './isolated.js';

const config = fixtureConfig();
const encode = (text: string) => new TextEncoder().encode(text);
const limits = { maxMemoryMb: 512, timeoutMs: 60_000 };

describe('convertDitaIsolated', () => {
  it('makes in its own process the bundle the conversion makes', async () => {
    const files = await convertDitaIsolated(fixtureFiles(), config, limits);
    const here = bundleFiles(await convertDita(fixtureFiles(), config));
    expect([...files.keys()].sort()).toEqual([...here.keys()].sort());
    const decode = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
    expect(decode(files.get('import.json'))).toBe(
      decode(here.get('import.json')),
    );
  }, 60_000);

  it('brings back a bundle far past a pipe’s buffer whole', async () => {
    const files = new Map([
      [
        'map.ditamap',
        encode('<map><title>M</title><topicref href="t.dita"/></map>'),
      ],
      [
        't.dita',
        encode(
          `<topic id="t"><title>T</title><body>${'<p>some text</p>'.repeat(40_000)}</body></topic>`,
        ),
      ],
    ]);
    for (let i = 0; i < 5; i++) {
      const out = await convertDitaIsolated(files, config, limits);
      expect(out.get('import.json')?.length).toBeGreaterThan(1_000_000);
    }
  }, 120_000);

  it('refuses in the child an answer past the largest document', async () => {
    // Quotes double when written as JSON: a small archive, a large answer.
    const files = new Map([
      [
        'map.ditamap',
        encode('<map><title>M</title><topicref href="t.dita"/></map>'),
      ],
      [
        't.dita',
        encode(
          `<topic id="t"><title>T</title><body><codeblock>${'"'.repeat(2_000_000)}</codeblock></body></topic>`,
        ),
      ],
    ]);
    await expect(
      convertDitaIsolated(files, config, {
        ...limits,
        maxDocumentBytes: 1_000_000,
      }),
    ).rejects.toMatchObject({ reason: 'size' });
  }, 60_000);

  it('kills a conversion past its time', async () => {
    const files = new Map([
      [
        'map.ditamap',
        encode('<map><title>M</title><topicref href="t.dita"/></map>'),
      ],
      [
        't.dita',
        encode(
          `<topic id="t"><title>T</title><body>${'<p>x</p>'.repeat(200_000)}</body></topic>`,
        ),
      ],
    ]);
    const started = Date.now();
    await expect(
      convertDitaIsolated(files, config, { ...limits, timeoutMs: 300 }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('stops a conversion past its memory, the server unharmed', async () => {
    // Plain content in many files: no budget of the conversion's own bounds it, the heap does.
    const body = '<p>x</p>'.repeat(500_000);
    const files = new Map<string, Uint8Array>();
    const refs: string[] = [];
    for (let i = 0; i < 12; i++) {
      files.set(
        `t${i}.dita`,
        encode(
          `<topic id="t${i}"><title>T</title><body>${body}</body></topic>`,
        ),
      );
      refs.push(`<topicref href="t${i}.dita"/>`);
    }
    files.set(
      'map.ditamap',
      encode(`<map><title>M</title>${refs.join('')}</map>`),
    );
    const error = await convertDitaIsolated(files, config, {
      maxMemoryMb: 128,
      timeoutMs: 60_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversionLimitError);
    expect((error as ConversionLimitError).reason).toBe('memory');
  }, 60_000);
});
