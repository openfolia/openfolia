// Writes a scale report as JSON (everything) and Markdown (the tables), side by side, named
// by when the run started: `<reports>/<kind>-<time>.{json,md}`.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ms = (v) =>
  v === undefined || Number.isNaN(v)
    ? '–'
    : v >= 10_000
      ? `${(v / 1000).toFixed(1)} s`
      : `${Math.round(v)} ms`;
const both = (s) => (s?.n ? `${ms(s.median)} / ${ms(s.p95)} (${s.n})` : '–');
const size = (bytes) =>
  !bytes
    ? '–'
    : bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
      : `${Math.round(bytes / 1024)} KiB`;
const loadText = (load) =>
  `${load.start} → ${load.max}${load.busy ? ' **busy**' : ''}`;

export function writeReport(dir, kind, report) {
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const base = join(dir, `${kind}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${base}.md`, markdown(report));
  return `${base}.md`;
}

export function markdown(report) {
  const lines = [];
  const m = report.machine;
  lines.push(
    `# Scale report: ${report.kind === 'api' ? 'server' : 'editor'}, profile \`${report.profile}\``,
  );
  lines.push('');
  lines.push(
    `- Commit \`${report.commit}\`${report.dirty ? ' (with uncommitted changes)' : ''}; ${report.startedAt} to ${report.finishedAt}`,
  );
  lines.push(
    `- Machine: ${m.cpu}, ${m.cores} cores, ${m.memoryGiB} GiB, ${m.platform}, Node ${m.node}`,
  );
  const measured = [
    ...(report.rows ?? []),
    ...(report.screens ?? []),
    ...(report.concurrency ?? []),
  ];
  const busy = measured.filter((r) => r.load?.busy).length;
  lines.push(
    `- Load: a row is **busy** when the 1-minute load average went above ${report.cores} (the core count) while it ran; its times then measure the machine, not the code. ${busy} of ${measured.length} rows were busy.`,
  );
  if (report.counts) {
    const c = report.counts;
    lines.push(
      `- Profile: ${c.modules} modules (${c.snippets} snippets), ${c.manuals} manuals (the big one ${c.bigManualModules} modules), ${Object.keys(c.translations ?? {}).length + 1} languages, ${c.images} images, ${c.pdfs + c.attachments} attachments (${size(c.mediaBytes)}), ${c.commits} commits, ${c.tags} tags, ${c.changeSets} open change sets, ${c.database?.audit_events ?? '?'} audit events, ${c.database?.webhook_deliveries ?? '?'} webhook deliveries; Git ${size(c.gitBytes)}, database ${size(c.database?.databaseBytes)}`,
    );
  }
  lines.push('');
  if (report.startup?.n) {
    lines.push(
      `**Start-up** (spawn to \`/health/ready\` 200, over ${report.startup.n} starts): median ${ms(report.startup.median)}, p95 ${ms(report.startup.p95)}, max ${ms(report.startup.max)}.`,
    );
    lines.push('');
  }
  if (report.rows?.length) {
    lines.push(
      "**First**: the first request in a fresh server process. **Cold**: the first request for each of the row's keys in that process (median / p95 (n)). **Warm**: one of them repeated. **Load**: the 1-minute load average when the row started → the highest while it ran.",
    );
    lines.push('');
    lines.push(
      '| What | First | Cold median / p95 (n) | Warm median / p95 (n) | Largest answer | Load | Result |',
    );
    lines.push('| --- | ---: | ---: | ---: | ---: | --- | --- |');
    for (const r of report.rows) {
      const result = r.failures?.length
        ? `failed: ${r.failures[0].replace(/\|/g, '/').slice(0, 160)}`
        : r.note
          ? r.note
          : 'ok';
      lines.push(
        `| ${r.name} | ${ms(r.first)} | ${both(r.cold)} | ${both(r.warm)} | ${size(r.bytes)} | ${loadText(r.load)} | ${result} |`,
      );
    }
    lines.push('');
  }
  if (report.concurrency?.length) {
    lines.push(
      '**Concurrency** (readers loop over modules, previews, search, manuals, media, change sets and translation status; writers save a working copy every 200 ms):',
    );
    lines.push('');
    lines.push(
      '| Mix | Requests | Per second | Errors (5xx, network) | 4xx | Read median / p95 | Read p99 | Write median / p95 | RSS start → max → end | Load |',
    );
    lines.push(
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    );
    for (const c of report.concurrency) {
      const mib = (b) => `${Math.round(b / 2 ** 20)} MiB`;
      lines.push(
        `| ${c.name} | ${c.requests} | ${c.throughput} | ${c.errorRate} % | ${c.clientErrors} | ${both(c.read)} | ${ms(c.readP99)} | ${both(c.write)} | ${mib(c.rss.start)} → ${mib(c.rss.max)} → ${mib(c.rss.end)} | ${loadText(c.load)} |`,
      );
    }
    lines.push('');
    const backlog = report.concurrency.filter((c) => c.backlog);
    if (backlog.length) {
      lines.push(
        '**While a backlog renders** (#527; the mix above plus one reader asking for manuals’ PDFs and one looking at their previews, page images; RSS is the API’s and the worker’s together):',
      );
      lines.push('');
      lines.push(
        '| Role | Read median / p95 | PDF median / p95 | PDFs answered (refused) | Preview median / p95 | Previews answered (refused) | Release files done meanwhile | Rendered twice | Most of a release scheduled (cap 40) | Ready / running at start |',
      );
      lines.push(
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      );
      for (const c of backlog) {
        lines.push(
          `| ${c.backlog.role} | ${both(c.read)} | ${c.pdf ? both(c.pdf) : '–'} | ${c.pdf?.n ?? 0} (${c.pdfRefused ?? 0}) | ${c.preview ? both(c.preview) : '–'} | ${c.preview?.n ?? 0} (${c.previewRefused ?? 0}) | ${c.backlog.filesDone} | ${c.backlog.renderedTwice} | ${c.backlog.maxScheduled} | ${c.backlog.readyAtStart} / ${c.backlog.runningAtStart} |`,
        );
      }
      lines.push('');
    }
  }
  if (report.screens?.length) {
    lines.push(
      "**Load**: navigation to the screen until the network is idle. **Rows**: rows (table rows, list items) in the page once loaded. **Requests**: the API requests the screen made, and the largest `page[size]` asked for. **Heap**: the page's JavaScript heap once loaded.",
    );
    lines.push('');
    lines.push(
      '| Screen | Load | Interaction | Rows | DOM nodes | API requests (largest page) | Heap | Load avg | Result |',
    );
    lines.push('| --- | ---: | --- | ---: | ---: | --- | ---: | --- | --- |');
    for (const s of report.screens) {
      const interactions =
        (s.interactions ?? []).map((i) => `${i.name} ${ms(i.ms)}`).join('; ') ||
        '–';
      lines.push(
        `| ${s.name} | ${ms(s.loadMs)} | ${interactions} | ${s.rows ?? '–'} | ${s.domNodes ?? '–'} | ${s.apiRequests ?? '–'} (${s.largestPage ?? '–'}) | ${size(s.heapBytes)} | ${loadText(s.load)} | ${s.error ? `failed: ${s.error.slice(0, 160)}` : (s.findings ?? []).join('; ') || 'ok'} |`,
      );
    }
    lines.push('');
  }
  if (report.notes?.length) {
    lines.push('Notes:');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
