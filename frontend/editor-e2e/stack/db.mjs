// The suite's database: an empty in-memory PGlite (Postgres in WebAssembly, the API's own test
// database) served on a free loopback port, in a process of its own so its queries never wait
// for the test runner. Nothing is written to disk; it is gone when the process ends.
//
//   node stack/db.mjs   prints `ready <port>` once it listens, then serves until stopped
//
// PGlite runs one statement at a time; `@electric-sql/pglite-socket` lets several connections
// (the API's pool, the job queue's) take turns. Its own queue keeps a transaction's statements
// together but hands out single protocol messages, so one connection's extended query
// (Parse, Bind, Describe, Execute, Sync) could be interleaved with another's, and rows came back
// to the wrong query. `SessionQueue` keeps each connection's messages together up to its Sync.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const apiRequire = createRequire(join(root, 'backend/api/package.json'));
const { PGlite } = apiRequire('@electric-sql/pglite');
// The migrations create pg_trgm (#54).
const { pg_trgm } = apiRequire('@electric-sql/pglite/contrib/pg_trgm');
const { PGLiteSocketServer } = apiRequire('@electric-sql/pglite-socket');

/** Message types of the extended query protocol, which a Sync ('S') ends. */
const EXTENDED = new Set(
  ['P', 'B', 'D', 'E', 'C', 'H'].map((c) => c.charCodeAt(0)),
);

/**
 * The socket server's query queue (same interface as its own `QueryQueueManager`): one message
 * at a time, but never another connection's while a connection is inside an extended query or
 * a transaction.
 */
class SessionQueue {
  queue = [];
  processing = false;
  /** The connection whose turn it is until its Sync, or its transaction's end. */
  owner = null;

  constructor(db) {
    this.db = db;
  }

  enqueue(handlerId, message, onData) {
    return new Promise((resolve, reject) => {
      this.queue.push({ handlerId, message, onData, resolve, reject });
      void this.process();
    });
  }

  next() {
    if (this.owner === null) return this.queue.shift();
    const index = this.queue.findIndex((item) => item.handlerId === this.owner);
    return index === -1 ? undefined : this.queue.splice(index, 1)[0];
  }

  async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      for (let item = this.next(); item; item = this.next()) {
        const type = item.message[0];
        let bytes = 0;
        try {
          await this.db.runExclusive(() =>
            this.db.execProtocolRawStream(item.message, {
              onRawData: (data) => {
                bytes += data.length;
                item.onData(data);
              },
            }),
          );
        } catch (error) {
          item.reject(error);
          continue;
        }
        // Inside an extended query: this connection's turn until its Sync. After a Sync or a
        // simple query: still its turn while its transaction is open.
        this.owner =
          EXTENDED.has(type) || this.db.isInTransaction()
            ? item.handlerId
            : null;
        item.resolve(bytes);
      }
    } finally {
      this.processing = false;
    }
  }

  getQueueLength() {
    return this.queue.length;
  }

  clearQueueForHandler(handlerId) {
    this.queue = this.queue.filter((item) => {
      if (item.handlerId !== handlerId) return true;
      item.reject(new Error('Handler disconnected'));
      return false;
    });
  }

  async clearTransactionIfNeeded(handlerId) {
    if (this.owner !== handlerId) return;
    if (this.db.isInTransaction()) await this.db.exec('ROLLBACK');
    this.owner = null;
    await this.process();
  }
}

const pglite = await PGlite.create({ extensions: { pg_trgm } });
const server = new PGLiteSocketServer({
  db: pglite,
  host: '127.0.0.1',
  port: 0,
  // The API's pool, the job queue's and the one-off migrate and seed runs.
  maxConnections: 64,
});
// Every connection's handler is made with the server's queue: ours, before any connects.
server.queryQueue = new SessionQueue(pglite);
await server.start();

const stop = async () => {
  await server.stop();
  await pglite.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
// The runner went away without stopping us: stop too.
process.on('disconnect', () => void stop());

const port = server.getServerConn().split(':').pop();
console.log(`ready ${port}`);
