// The embedded database: PGlite (Postgres compiled to WebAssembly) served on a loopback port over
// the Postgres protocol, so the API connects to it as to any Postgres server. The sandbox image
// runs it on a copy of the baked data folder (deploy/docker/sandbox/), the demo's bake makes that
// folder with it (scripts/demo/bake.mjs), and the editor's browser tests run it in memory
// (frontend/editor-e2e/stack/db.mjs).
//
// One file with no relative imports: Node runs it as it is (type stripping) from the browser
// tests, and `tsc` builds it for the image.
//
// PGlite runs one statement at a time; `@electric-sql/pglite-socket` lets several connections
// (the API's pool, the job queue's) take turns. Its own queue keeps a transaction's statements
// together but hands out single protocol messages, so one connection's extended query (Parse,
// Bind, Describe, Execute, Sync) could be interleaved with another's, and rows came back to the
// wrong query. `SessionQueue` keeps each connection's messages together up to its Sync.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/** Message types of the extended query protocol, which a Sync ('S') ends. */
const EXTENDED = new Set(
  ['P', 'B', 'D', 'E', 'C', 'H'].map((c) => c.charCodeAt(0)),
);

interface QueuedMessage {
  readonly handlerId: number;
  readonly message: Uint8Array;
  readonly onData: (data: Uint8Array) => void;
  readonly resolve: (bytes: number) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The socket server's query queue (the same interface as its own `QueryQueueManager`): one
 * message at a time, but never another connection's while a connection is inside an extended
 * query or a transaction.
 */
export class SessionQueue {
  #queue: QueuedMessage[] = [];
  #processing = false;
  /** The connection whose turn it is until its Sync, or its transaction's end. */
  #owner: number | null = null;
  readonly #db: PGlite;

  constructor(db: PGlite) {
    this.#db = db;
  }

  enqueue(
    handlerId: number,
    message: Uint8Array,
    onData: (data: Uint8Array) => void,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ handlerId, message, onData, resolve, reject });
      void this.#process();
    });
  }

  #next(): QueuedMessage | undefined {
    if (this.#owner === null) return this.#queue.shift();
    const index = this.#queue.findIndex(
      (item) => item.handlerId === this.#owner,
    );
    return index === -1 ? undefined : this.#queue.splice(index, 1)[0];
  }

  async #process(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      for (let item = this.#next(); item; item = this.#next()) {
        const type = item.message[0] ?? 0;
        let bytes = 0;
        const current = item;
        try {
          await this.#db.runExclusive(() =>
            this.#db.execProtocolRawStream(current.message, {
              onRawData: (data: Uint8Array) => {
                bytes += data.length;
                current.onData(data);
              },
            }),
          );
        } catch (error) {
          current.reject(error);
          continue;
        }
        // Inside an extended query: this connection's turn until its Sync. After a Sync or a
        // simple query: still its turn while its transaction is open.
        this.#owner =
          EXTENDED.has(type) || this.#db.isInTransaction()
            ? current.handlerId
            : null;
        current.resolve(bytes);
      }
    } finally {
      this.#processing = false;
    }
  }

  getQueueLength(): number {
    return this.#queue.length;
  }

  clearQueueForHandler(handlerId: number): void {
    this.#queue = this.#queue.filter((item) => {
      if (item.handlerId !== handlerId) return true;
      item.reject(new Error('Handler disconnected'));
      return false;
    });
  }

  async clearTransactionIfNeeded(handlerId: number): Promise<void> {
    if (this.#owner !== handlerId) return;
    if (this.#db.isInTransaction()) await this.#db.exec('ROLLBACK');
    this.#owner = null;
    await this.#process();
  }
}

export interface DatabaseOptions {
  /**
   * The data folder, kept on disk (PGlite's NodeFS): made when missing, opened when it holds a
   * database. Left out, the database lives in memory and is gone when it stops.
   */
  readonly dataDir?: string;
  /** The address to listen on (default 127.0.0.1: never another machine's). */
  readonly host?: string;
  /** The port (default 0: one the operating system picks). */
  readonly port?: number;
  /** The most connections at once (default 64: the API's pool, the job queue's, a migration). */
  readonly maxConnections?: number;
}

export interface Database {
  /** The port it listens on. */
  readonly port: number;
  /** The connection string, for `CCMS_DATABASE_URL`. */
  readonly url: string;
  /** How many clients are connected now. */
  connections(): number;
  /** Stops listening and closes the database (a data folder is written out first). */
  stop(): Promise<void>;
}

/** Starts the database and serves it. Resolves once it listens. */
export async function startDatabase(
  options: DatabaseOptions = {},
): Promise<Database> {
  const host = options.host ?? '127.0.0.1';
  // The migrations create pg_trgm (#54).
  const pglite = await PGlite.create({
    ...(options.dataDir !== undefined && { dataDir: options.dataDir }),
    extensions: { pg_trgm },
  });
  const server = new PGLiteSocketServer({
    db: pglite,
    host,
    port: options.port ?? 0,
    maxConnections: options.maxConnections ?? 64,
  });
  // Every connection's handler is made with the server's queue: ours, before any connects.
  (server as unknown as { queryQueue: SessionQueue }).queryQueue =
    new SessionQueue(pglite);
  try {
    await server.start();
  } catch (error) {
    await pglite.close();
    throw error;
  }
  const port = Number(server.getServerConn().split(':').pop());
  let stopped: Promise<void> | undefined;
  return {
    port,
    url: `postgres://postgres@${host}:${port}/postgres`,
    connections: () => server.getStats().activeConnections,
    stop: () =>
      (stopped ??= (async () => {
        await server.stop();
        await pglite.close();
      })()),
  };
}
