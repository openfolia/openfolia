// Converts one very large page in a process of its own, whose heap the
// spec caps (`--max-old-space-size`): past the cap V8 aborts the process,
// and the spec sees it. Started by `large-page.spec.ts` from the TypeScript
// sources (`source-hooks.mjs`); answers over IPC with what the page became.
import { convertWikiPages } from '../src/lib/convert.js';
import { WikiMapping } from '../src/lib/mapping.js';
import { LARGE_PAGES, type LargePage } from './large-pages.js';

const kind = process.argv[2] as LargePage;
const bytes = Number(process.argv[3]);
const markup = LARGE_PAGES[kind](bytes);
const started = performance.now();
const { document } = convertWikiPages(
  [{ id: 'p1', title: 'Large', markup }],
  WikiMapping.parse({ language: 'en', moduleType: 'concept' }),
);
const ms = Math.round(performance.now() - started);
const blocks = document.modules[0]?.blocks ?? [];
process.send?.(
  {
    types: blocks.map((b) => b.type),
    rawIsMarkup: blocks[0]?.type === 'passthrough' && blocks[0].raw === markup,
    codes: (document.report ?? []).map(
      (e) => /^\[([a-z-]+)\]/.exec(e.message)?.[1],
    ),
    ms,
    // Peak resident set, in MiB (`maxRSS` is in KiB).
    rssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  },
  () => process.exit(0),
);
