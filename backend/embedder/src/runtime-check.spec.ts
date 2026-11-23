import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesWithTelemetry } from './runtime-check.js';

describe('filesWithTelemetry', () => {
  it('finds no usage-data client in the installed ONNX Runtime', async () => {
    expect(await filesWithTelemetry()).toEqual([]);
  });

  it('finds a library that holds one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'embedder-runtime-'));
    try {
      await writeFile(path.join(dir, 'clean.so'), 'nothing here');
      await writeFile(path.join(dir, 'chatty.so'), 'xx OneCollector/1.0 xx');
      expect(await filesWithTelemetry(dir)).toEqual(['chatty.so']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
