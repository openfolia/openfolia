// A PDF worker's resident memory over a fixed number of compilations (#436), for the README's
// "Memory" section. Runs the built package (`pnpm nx build render-typst` first) on a pool of one
// worker that is never replaced, one compilation at a time, and prints the worker's resident
// memory as `ps` reports it. Run it nice'd, on an otherwise quiet machine:
//
//   nice node packages/render-typst/scripts/worker-memory.mjs [compilations=200] [sections=30]
//
// `sections` 0 is a one-line document; 30 is a manual of 30 sections of running text.
import { execFileSync } from 'node:child_process';
import {
  closeWorkerPool,
  compilePdfInWorker,
  configureWorkerPool,
} from '../dist/index.js';

const compilations = Number(process.argv[2] ?? 200);
const sections = Number(process.argv[3] ?? 30);

const source = [
  '#set document(title: "Memory")',
  '#set text(lang: "en")',
  sections === 0 ? '= One line\nA short document.' : '',
  ...Array.from(
    { length: sections },
    (_, i) => `= Section ${i + 1}\n#lorem(400)\n\n#lorem(200)`,
  ),
].join('\n');

/** This process's only worker: its pid and resident memory in MB. */
function worker() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    // `ps` itself is a child too, and exited ones show as `(node)` until they are reaped.
    .filter(
      ([, ppid, , comm]) =>
        Number(ppid) === process.pid &&
        !comm.endsWith('ps') &&
        !comm.startsWith('('),
    );
  if (rows.length !== 1)
    throw new Error(`expected one worker, found ${rows.length}`);
  return { pid: rows[0][0], rssMb: Math.round(Number(rows[0][2]) / 1024) };
}

/**
 * macOS only: the process's physical footprint in MB, which counts the pages macOS compressed
 * (resident memory does not, so it falls when the system compresses the worker's idle pages).
 */
function footprintMb(pid) {
  if (process.platform !== 'darwin') return undefined;
  const out = execFileSync('footprint', [pid], { encoding: 'utf8' });
  const [, value, unit] = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(out) ?? [];
  if (value === undefined) return undefined;
  return Math.round(Number(value) * { KB: 1 / 1024, MB: 1, GB: 1024 }[unit]);
}

configureWorkerPool({ size: 1, jobsPerWorker: compilations + 1 });
const marks = new Set([1, 10, 25, 50, 100, 150, 200, 250, 300, compilations]);
let peak = 0;
let first = 0;
for (let i = 1; i <= compilations; i++) {
  await compilePdfInWorker(
    { source, creationTimestamp: 0 },
    { timeoutMs: 120_000 },
  );
  // Sampled after every compilation: resident memory moves (macOS compresses idle pages).
  const { pid, rssMb: rss } = worker();
  if (i === 1) first = rss;
  peak = Math.max(peak, rss);
  if (marks.has(i)) {
    const footprint = footprintMb(pid);
    console.log(
      `after ${String(i).padStart(3)} compilations: resident ${rss} MB (peak so far ${peak} MB)` +
        (footprint === undefined ? '' : `, footprint ${footprint} MB`),
    );
  }
}
console.log(
  `resident peak ${peak} MB over ${compilations} compilations, first ${first} MB:` +
    ` ${((peak - first) / (compilations - 1)).toFixed(2)} MB per compilation at the peak`,
);
await closeWorkerPool();
