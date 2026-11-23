import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeWorkerPool,
  compilePdfInWorker,
  configureWorkerPool,
  TypstClosedError,
} from './compile.js';

// Own test file: no pool exists until this test makes one.
// A private temp directory, so the pool's folders can be checked.
const privateTmp = mkdtempSync(join(tmpdir(), 'openfolia-pool-closed-test-'));
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
it('refuses jobs after closing before any pool started, until reconfigured', async () => {
  await closeWorkerPool();
  await expect(
    compilePdfInWorker({ source: '#set document(title: "T")\n= Late' }),
  ).rejects.toBeInstanceOf(TypstClosedError);
  configureWorkerPool({ size: 1, maxQueue: 1 });
  // A job that times out while waiting behind a slow one counts as load.
  const slow = compilePdfInWorker({
    source:
      '#set document(title: "T")\n#for i in range(1200) { for j in range(1200) { let x = i * j } }',
  });
  await expect(
    compilePdfInWorker(
      { source: '#set document(title: "T")\n= Waiting' },
      { timeoutMs: 20 },
    ),
  ).rejects.toMatchObject({ name: 'TypstTimeoutError', queued: true });
  await slow;
  const pdf = await compilePdfInWorker({
    source: '#set document(title: "T")\n= Again',
  });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  // Concurrent callers all wait for the same, complete shutdown.
  // Expectation attached first: the job is rejected during the close.
  const running = expect(
    compilePdfInWorker({ source: '#set document(title: "T")\n= Running' }),
  ).rejects.toBeInstanceOf(TypstClosedError);
  const first = closeWorkerPool();
  // The second caller only returns once the first close removed everything.
  await closeWorkerPool();
  expect(readdirSync(privateTmp)).toEqual([]);
  await first;
  await running;
  await closeWorkerPool();
}, 60_000);
