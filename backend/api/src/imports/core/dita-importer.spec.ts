import type { ProjectConfig } from '@openfolia/content-model';
import { ConversionLimitError, convertDitaIsolated } from '@openfolia/dita';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { UnprocessableError } from '../../base/core/errors.js';
import { DitaImporter } from './dita-importer.js';

vi.mock('@openfolia/dita', async (original) => ({
  ...(await original<typeof import('@openfolia/dita')>()),
  convertDitaIsolated: vi.fn(),
}));

const settings = {
  maxMemoryMb: 256,
  timeoutMs: 5_000,
  maxDocumentBytes: 1_000_000,
};
const run = () =>
  new DitaImporter(settings).toBundle(
    { bytes: zipSync({ 'map.ditamap': strToU8('<map/>') }), fileName: 'p.zip' },
    {},
    { maxFiles: 10, maxUnpackedBytes: 1024 * 1024, maxPathDepth: 3 },
    { config: {} as ProjectConfig },
  );

describe('DitaImporter', () => {
  it('converts in a process of its own, within the settings', async () => {
    vi.mocked(convertDitaIsolated).mockResolvedValueOnce(new Map());
    await run();
    expect(convertDitaIsolated).toHaveBeenLastCalledWith(
      expect.any(Map),
      {},
      settings,
    );
  });

  it.each(['memory', 'timeout', 'size'] as const)(
    'refuses a conversion past its %s as a 422, never a 500',
    async (reason) => {
      vi.mocked(convertDitaIsolated).mockRejectedValueOnce(
        new ConversionLimitError(reason, 'past'),
      );
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableError);
      expect(error).toMatchObject({
        code: 'import-too-large',
        meta: { reason },
      });
    },
  );

  it('lets another failure through: a bug, not a large project', async () => {
    vi.mocked(convertDitaIsolated).mockRejectedValueOnce(new Error('bug'));
    await expect(run()).rejects.not.toBeInstanceOf(UnprocessableError);
  });
});
