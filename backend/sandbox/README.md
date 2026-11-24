# @openfolia/sandbox

The embedded database of the sandbox image (#827; `deploy/README.md`, "The sandbox image"):
[PGlite](https://pglite.dev) (Postgres compiled to WebAssembly, `@electric-sql/pglite`, Apache-2.0)
served on a loopback port over the Postgres protocol (`@electric-sql/pglite-socket`), so the API
connects to it as to any Postgres server, with `pg_trgm` loaded for the migrations.

Three users:

- the **sandbox image**, which runs `dist/db-server.js` on a copy of the baked data folder in
  its tmpfs (`deploy/docker/sandbox/entrypoint.sh`);
- the **demo's bake** (`scripts/demo/bake.mjs`), which makes that data folder at image build: the
  migrations, the demo seed and the demo's finished state, through the API;
- the **editor's browser tests** (`frontend/editor-e2e/stack/db.mjs`), which run it in memory.
  They import `src/database.ts` as it is (Node strips the types), so that file has no relative
  imports.

## API

```ts
import { startDatabase } from '@openfolia/sandbox';

const database = await startDatabase({ dataDir: '/tmp/pgdata', port: 5432 });
// database.url: postgres://postgres@127.0.0.1:5432/postgres
database.connections(); // clients connected now
await database.stop(); // stops listening, closes the database (the data folder written out); idempotent
```

- `dataDir`: a folder on disk (made when missing, opened when it holds a database). Left out, the
  database lives in memory.
- `host` (default `127.0.0.1`: never another machine's), `port` (default 0: one the operating
  system picks), `maxConnections` (default 64).

`SessionQueue` is the socket server's query queue. PGlite runs one statement at a time, and the
server's own queue could interleave one connection's extended query (Parse, Bind, Describe,
Execute, Sync) with another's, so rows came back to the wrong query. `SessionQueue` keeps each
connection's messages together up to its Sync, and for as long as its transaction is open.

## The process

```sh
node --liftoff-only dist/db-server.js --data <folder> --port <n>
```

It prints `ready <port>` once it listens. On SIGTERM or SIGINT (or when the parent's IPC channel
closes) it waits up to 5 seconds for its clients to leave (the sandbox stops every process at
once, and the API still writes as it shuts down), then closes the database and ends.

`--liftoff-only` keeps V8 on its baseline WebAssembly compiler: optimising PGlite's module took
about 1.3 GB of memory at its peak, more than a sandbox's limit, and the baseline code starts
faster. With it the process stays at about 270 MB.

## Tests

`pnpm nx test sandbox`: a connection over the loopback with `pg_trgm`, concurrent extended
queries beside a transaction, a data folder that persists across a restart, and a second `stop`.
