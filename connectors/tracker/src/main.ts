#!/usr/bin/env node
import { runCli } from './lib/cli.js';

const stop = new AbortController();
// On a schedule, the first signal stops it after the run under way; a
// second one, or one during a single run, ends it at once.
// Listening for triggers, the same: the listener closes and the run under
// way finishes.
if (
  process.argv.some((a) =>
    ['--every', '--listen'].some((f) => a === f || a.startsWith(`${f}=`)),
  )
) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stop.signal.aborted) process.exit(130);
      stop.abort();
    });
  }
}

process.exitCode = await runCli(
  process.argv.slice(2),
  process.env,
  {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  { signal: stop.signal },
);
