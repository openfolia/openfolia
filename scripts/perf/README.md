# Performance at scale

Tooling to find out how the product behaves at a realistic large size, and where it stops
scaling: a generator for thousands of modules, media and manuals (`pnpm perf:seed`), the server
benchmarks (`api:perf-scale`) and the editor timings (`editor:perf-scale`). None of it is part
of `pnpm check`; the speed criteria that are (`api:perf`, `tests/perf/*.perf.ts`, see
`backend/api/README.md`, "Speed criteria") stay on small fixtures.

Everything generated lives in `.local/perf/<profile>/` (git-ignored) and in a database of its
own on the compose Postgres. All content is invented and neutral.

## 1. Generate a profile

```sh
docker compose up -d                 # the compose Postgres (compose.yaml)
pnpm perf:seed --profile large       # builds the API first, then the profile from nothing
```

| Profile | Modules | Manuals              | Languages | Media                 | Commits | Releases | Open change sets | Audit events |
| ------- | ------: | -------------------- | --------: | --------------------- | ------: | -------: | ---------------- | -----------: |
| `small` |     400 | 20 (one of 120)      |         4 | 170                   |   1,000 |        5 | 15               |        5,000 |
| `large` |   5,000 | 300 (one of 400)     |         8 | 3,000 (about 650 MiB) |  20,000 |       50 | 200 (one of 300) |      100,000 |
| `xl`    |  20,000 | 1,200 (one of 1,600) |         8 | 12,000                |  80,000 |      200 | 800 (one of 900) |      400,000 |

`small` is for working on the tooling; `large` is the size the product must stay fast at; `xl`
is about four times that, to find the breaking points. The counts are in `profiles.mjs`.

What it makes, in order (`seed.mjs`):

1. **Media** (`media.mjs`): images of realistic sizes (photos as JPEG and WebP up to 3200 × 2400,
   screenshots and drawings as PNG), PDFs and other attachments (CSV, plain text), made with
   sharp and stored by the API's own `FsBlobStore` in `blobs/`.
2. **Content** (`content.mjs`, `git-import.mjs`): a bare repository `content.git` with the
   configuration (8 languages, module types with a snippet type, audiences, a product facet,
   variant attributes, safety symbols), terms, snippets, modules using every block type (module
   references, cross-references, variant blocks, images, attachments, tables, procedures, safety
   messages), manuals with chapters, variants and text attributes, and partial translations with
   their translation records. The first manual is the big one. Then the history, written with
   `git fast-import`: edits of source modules, translations brought up to date, manuals
   reordered, modules added. Every module and manual is checked with the content model's schema
   and validator before it is written; a unit test (`scripts/__tests__/perf-content.test.ts`)
   reads a small profile back with the content model's parsers.
3. **Database** `ccms_perf_<profile>` (`ccms_perf_<slot>_<profile>` in an agent slot), dropped
   and made again (it stays for the benchmarks; a benchmark run drops it when it ends, see
   below), migrated, roles and users seeded with the API's own `db-seed`, a read-only
   service account for the MCP server (`service-token`).
4. **Through the API** (the built server, on a free port, in demo mode): a release after each
   part of the history, the open change sets (locks, working copies, save points, some submitted
   for review; one big change set), review comments, webhooks, translation export jobs.
5. **Directly in the database**: the audit log's history and the webhook deliveries (a hundred
   thousand API calls would take hours, and these rows have no Git side).
6. The module index for every branch and tag (`index-rebuild`), and `git gc`.

The content and its history are deterministic: the same profile makes the same files and commit
IDs. What the API writes carries the time it ran (release tags, change sets, comments).
`profile.json` holds the counts, the time of every step, the token of the profile's server and
the IDs the benchmarks use; it is the profile's own, never a checkout's settings.

**Run time** of `pnpm perf:seed --profile large`: **37 minutes** (2,219 s of steps) on a
16-core arm64 laptop (64 GiB, darwin, Node 24), shared with other work at a load of 30 to
60, so on a quiet machine expect less. By step: media 127 s, the first commits 24 s, the history
with its 50 releases 273 s, the 200 change sets 251 s, the 2,000 comments 296 s, the module
index of the 64 commits the branches and tags point at **1,189 s** (one `index-rebuild`), `git
gc` 21 s, the rest under 15 s each. The result: 5,542 modules in 8 languages, 20,000 commits,
95 MiB of Git, 627 MiB of media, a 587 MiB database (1.2 million module index rows, 105,000
audit events, 20,000 deliveries). `small` takes about two minutes. Every step's time is in
`profile.json` (`timings`).

## 2. Server benchmarks

```sh
pnpm nx run api:perf-scale -- --profile large
pnpm nx run api:perf-scale -- --profile large --wait-quiet 30   # wait up to 30 min for a quiet machine before each row
pnpm nx run api:perf-scale -- --profile large --only "GET /search|GET /modules"
```

Options: `--only` and `--skip` (row names containing any of `|`-separated texts), `--warm-runs`
(default 15), `--concurrency-seconds` (default 30), `--readers` (the concurrency rows' reader
counts, default `20,50`), `--wait-quiet <minutes>` (default 0), and `--node-options=<options>`
for every measured server, handed to it as `NODE_OPTIONS`: to profile a row, e.g.
`--only concurrency --readers 20 "--node-options=--cpu-prof --cpu-prof-dir=/tmp/prof"` (the
profile is written when the server stops), or `--heap-prof` for what is still in memory then.

Every row runs on a **server process started for it alone** (`dist/main.js` on the profile,
`scripts/perf/server.mjs`), so nothing an earlier row read is in memory:

- **First**: the first request in that fresh process: the cold case a reader meets after a deploy
  or restart (the module index in Postgres and Git's files on disk are warm, as in production).
- **Cold**: the first request for each of the row's keys (other modules, pages, filters, refs).
- **Warm**: one of them repeated (`--warm-runs` times). Median and p95 (nearest rank) each.

Then: **start-up** (spawn to `/health/ready` 200, over every start), the import dry run (a
bundle of 1,000 new modules), the XLIFF round trip (the big job's file, every unit filled in, as
an import dry run), planning a release's outputs, the **MCP tools** (the MCP server over stdio,
as an assistant runs it), and **concurrency**: 20 and then 50 readers looping over a mix of
routes plus 3 writers saving working copies, with error rate, latency and the server's RSS
sampled every second. The readers loop without pauses (a closed-loop saturation test, not a
model of real traffic), in this one Node process; only answered reads (2xx, 3xx) count as read
times, refusals are counted apart. Planning a release's outputs is measured only while the
newest release has none (planning is kept: re-seed to measure it again).

**A run changes the profile a little**: the concurrency writers' change sets (abandoned at the
end) and their audit events. For runs to compare, re-seed in between.

**A run drops the profile's database when it ends** (`api:perf-scale` and `editor:perf-scale`
alike; never with FORCE: one still in use stays, with a note), so a profile's few hundred MiB
don't stay behind; the next run asks for a seed. Pass `--keep` to keep it for another run, e.g.
`pnpm nx run api:perf-scale -- --profile large --keep` before the editor timings. An agent
slot's profiles are also dropped by `pnpm slot remove`.

The report goes to `.local/perf/<profile>/reports/api-<time>.md` and `.json`.

## 3. Editor timings

```sh
pnpm nx run editor:perf-scale -- --profile large
```

Builds the editor (production) and the API, serves the build with `/api` proxied to the API on
the profile (the token added in the proxy, as the dev server does), and opens each screen in a
headless Chromium (Playwright, `playwright-core`; the browser is the one Playwright installed,
`npx playwright-core install chromium` once): the content browser, a module, the media library,
the manual builder on the big manual, the manuals list, the translations matrix and jobs, the
audit tab, the review screen of the big change set and the releases. Per screen: the time to its
last API answer, rows and DOM nodes rendered, API requests (and the largest `page[size]`, and how
many pages of one list it read), the JavaScript heap, and a scroll, a filter and an open where
the screen has them. A screen rendering more than 500 rows, asking for more than 200 items at
once or reading more than 10 pages of one list is flagged. The report goes to
`.local/perf/<profile>/reports/editor-<time>.md`. The screens share one API process (the
first screen is opened once to warm it), an interaction's time is to its last API answer (one
that asks for nothing shows as 0), and the heap is read without forcing a garbage collection.
Like the server benchmarks, it drops the profile's database when it ends; `--keep` keeps it.

## Which machine, and reading a result

**Measure on a quiet machine.** A time taken while the 1-minute load average is above the core
count measures the machine, not the code (a request waits for a CPU): the rule of
`expectWithin()` in `tests/perf/budget.ts`. Every row records the load when it started and the
highest while it ran, and is marked **busy** past the core count. Use `--wait-quiet` on a
shared machine; report busy rows as busy, never as the product's numbers. For numbers to
compare over time, use the same machine (a developer laptop of 8 or more cores with an SSD, or
a dedicated CI runner), nothing else running, the API built from the commit the report names.

**On a GitHub-hosted Linux runner** (#527): the `perf-backlog` workflow
(`.github/workflows/perf-backlog.yml`) seeds a profile on a runner of its own and runs
`api:perf-scale` there, by hand only (`gh workflow run perf-backlog.yml --ref <branch>`, inputs
`profile` (default `large`), `only` (default `backlog`, the readers beside a release backlog, by
role) and `backlog-workers` (default 1)); never on a push or a pull request, since the `large`
seed alone takes most of an hour or more. The report is the run's summary and an artifact
(`perf-backlog-<profile>`, kept 30 days). GitHub runs a `workflow_dispatch` workflow only once
the file is on the default branch; from there `--ref` picks the branch to measure. A
GitHub-hosted runner has fewer cores than a developer laptop, so compare its rows with each other,
not with a laptop's.

Reading a row: compare **first** and **warm**. A large first with a small warm is a cache being
built (the module index of a commit, the search index, a parsed snapshot): what one reader
meets after every save point, merge or restart. A large warm is work done on every request.
p95 far above the median on warm runs is usually the machine (garbage collection, another
process), unless the row's keys differ in size. A deep page as slow as page 1 means the list is
built whole before paging. Concurrency: errors should be 0; read p95 under load against the
single-reader warm p95 says how much requests wait for each other (one event loop per process).
