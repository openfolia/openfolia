// The suite's database: an empty in-memory PGlite (Postgres in WebAssembly, the API's own test
// database) served on a free loopback port, in a process of its own so its queries never wait
// for the test runner. Nothing is written to disk; it is gone when the process ends.
//
//   node stack/db.mjs   prints `ready <port>` once it listens, then serves until stopped
//
// The server is the sandbox image's embedded database (`backend/sandbox/src/database.ts`, run as
// it is): the same socket server and the same queue that keeps each connection's extended
// queries and transactions together.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..', '..');
const { startDatabase } = await import(
  pathToFileURL(join(root, 'backend/sandbox/src/database.ts')).href
);

const database = await startDatabase();

const stop = async () => {
  await database.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
// The runner went away without stopping us: stop too.
process.on('disconnect', () => void stop());

console.log(`ready ${database.port}`);
