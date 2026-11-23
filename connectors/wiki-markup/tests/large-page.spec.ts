import { fork } from 'node:child_process';
import { LARGE_PAGES, type LargePage } from './large-pages.js';

/** The heap (old space) the conversion of one very large page may take, in MiB (#785). */
const MAX_HEAP_MB = 300;
/** About 5 MB of markup a page. */
const PAGE_BYTES = 5_000_000;

interface Answer {
  readonly types: string[];
  readonly rawIsMarkup: boolean;
  readonly codes: (string | undefined)[];
  readonly ms: number;
  readonly rssMb: number;
}

/** Converts one page of `kind` in a child process whose heap is capped at `MAX_HEAP_MB`. */
function convertCapped(kind: LargePage): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const child = fork(
      new URL('./large-page.child.ts', import.meta.url),
      [kind, String(PAGE_BYTES)],
      {
        execArgv: [
          '--experimental-transform-types',
          '--conditions=@openfolia/source',
          '--import',
          new URL('./source-hooks.mjs', import.meta.url).href,
          `--max-old-space-size=${MAX_HEAP_MB}`,
          '--no-warnings',
        ],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      },
    );
    let answer: Answer | undefined;
    child.on('message', (message: Answer) => (answer = message));
    child.on('error', reject);
    // `close`, after the IPC channel is drained. V8 out of memory aborts (SIGABRT, 134).
    child.on('close', (code, signal) =>
      answer
        ? resolve(answer)
        : reject(
            new Error(
              signal === 'SIGABRT' || code === 134
                ? `The page "${kind}" took more than ${MAX_HEAP_MB} MiB of heap.`
                : `The child converting "${kind}" ended with ${signal ?? code}.`,
            ),
          ),
    );
  });
}

describe('a very large page', () => {
  it.each(Object.keys(LARGE_PAGES) as LargePage[])(
    'of %s goes verbatim within a bounded heap',
    async (kind) => {
      const answer = await convertCapped(kind);
      expect(answer).toMatchObject({
        types: ['passthrough'],
        rawIsMarkup: true,
        codes: ['page-too-large'],
      });
    },
    60_000,
  );
});
