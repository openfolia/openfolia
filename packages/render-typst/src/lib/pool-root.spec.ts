import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeWorkerPool,
  compilePdfInWorker,
  configureWorkerPool,
} from './compile.js';

const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';
/** Waits until `check` holds; directories go when their worker's thread has exited. */
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(check()).toBe(true);
}

const poolDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('openfolia-typst-pool-'));

// A private temp directory, so other test files' pools stay out of sight.
const privateTmp = mkdtempSync(join(tmpdir(), 'openfolia-pool-root-test-'));
// tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
const saved = {
  TMPDIR: process.env['TMPDIR'],
  TEMP: process.env['TEMP'],
  TMP: process.env['TMP'],
};
for (const name of Object.keys(saved)) process.env[name] = privateTmp;
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(privateTmp, { recursive: true, force: true });
});

describe('worker pool directory', () => {
  const ours = poolDirs;

  it(
    'replaces a pool directory that was deleted or opened up',
    { timeout: 60_000 },
    async () => {
      // One long-lived worker: it stays idle on the old directory, so the
      // pool must notice the change before handing it the next job.
      configureWorkerPool({ size: 1 });
      expect(
        isPdf(
          await compilePdfInWorker({
            source: '#set document(title: "T")\n= One',
          }),
        ),
      ).toBe(true);

      const first = ours()[0] ?? '';
      rmSync(join(tmpdir(), first), { recursive: true });
      expect(
        isPdf(
          await compilePdfInWorker({
            source: '#set document(title: "T")\n= Two',
          }),
        ),
      ).toBe(true);

      const second = ours()[0] ?? '';
      expect(first).not.toBe('');
      expect(second).not.toBe('');
      expect(second).not.toBe(first);
      if (process.platform !== 'win32') {
        chmodSync(join(tmpdir(), second), 0o777);
        expect(
          isPdf(
            await compilePdfInWorker({
              source: '#set document(title: "T")\n= Three',
            }),
          ),
        ).toBe(true);
        await eventually(() => !ours().includes(second));
      }
    },
  );

  it('refuses jobs once closed and removes its directories', async () => {
    await closeWorkerPool();
    expect(ours()).toEqual([]);
    await expect(
      compilePdfInWorker({ source: '#set document(title: "T")\n= Late' }),
    ).rejects.toThrow(/closed/);
    // A new configuration starts a new pool.
    configureWorkerPool({ size: 1 });
    expect(
      isPdf(
        await compilePdfInWorker({
          source: '#set document(title: "T")\n= Again',
        }),
      ),
    ).toBe(true);
    await closeWorkerPool();
    expect(ours()).toEqual([]);
  });
});
