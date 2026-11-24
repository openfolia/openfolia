// The embedded database as a process of its own (`database.ts`), so its queries never wait for
// another process's work:
//
//   node dist/db-server.js [--data <folder>] [--port <n>]
//
// It listens on 127.0.0.1 only, prints `ready <port>` once it does, and serves until SIGTERM or
// SIGINT (or its parent's IPC channel closing). Then it waits for its clients to leave, at most
// GRACE_MS (the sandbox stops every process at once: the API still writes as it shuts down),
// closes the database, writing a data folder out first, and ends.
import { parseArgs } from 'node:util';
import { startDatabase } from './database.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    port: { type: 'string', default: '0' },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`db-server: --port must be 0-65535, not ${values.port}`);
  process.exit(64);
}

const database = await startDatabase({
  ...(values.data !== undefined && { dataDir: values.data }),
  port,
});

/** How long a stop waits for the clients to leave. */
const GRACE_MS = 5_000;

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const end = Date.now() + GRACE_MS;
  const left = async () => {
    while (database.connections() > 0 && Date.now() < end)
      await new Promise((done) => setTimeout(done, 50));
  };
  left()
    .then(() => database.stop())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`db-server: closing failed: ${String(error)}`);
        process.exit(1);
      },
    );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// A parent that went away without stopping us (the browser tests' runner): stop too.
process.on('disconnect', stop);

console.log(`ready ${database.port}`);
