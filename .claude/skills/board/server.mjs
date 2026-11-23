#!/usr/bin/env node
// The working board's server: the page, its data, live updates and the inbox. Listens on
// 127.0.0.1 only; refuses a foreign Host (DNS rebinding) and a POST from a foreign Origin.
// Node's standard library only. Logs to stdout, never the files' content.
//
//   BOARD_PORT=4777 BOARD_DIR=<dir> node .claude/skills/board/server.mjs
//
// When the port is taken by a board serving the same directory, it says so and exits 0 (reuse
// it); when something else holds it, it tries the next ten ports and prints the one it got.
import { readFileSync, mkdirSync, watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FILES,
  appendJsonl,
  boardDir,
  boardPort,
  checkInbox,
  groupView,
  hostAllowed,
  inboxView,
  lanePhase,
  laneTimeline,
  newInboxId,
  normalizeState,
  originAllowed,
  readJson,
  readJsonl,
  recentLog,
  timingsView,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024;
const HEARTBEAT_MS = 25_000;
/** The page's icon, also at /favicon.ico for a browser that asks there. */
const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f6d74"/><rect x="7" y="8" width="8" height="16" rx="2" fill="#fff"/><rect x="17" y="8" width="8" height="7" rx="2" fill="#fff" opacity=".75"/><rect x="17" y="17" width="8" height="7" rx="2" fill="#fff" opacity=".5"/></svg>';
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/**
 * Everything the page shows, read fresh from the files.
 * @param {string} dir
 * @param {number} [now]
 */
export function boardData(dir, now = Date.now()) {
  const state = normalizeState(readJson(path.join(dir, FILES.state), null));
  const inbox = readJsonl(path.join(dir, FILES.inbox));
  const rawTimings = readJson(path.join(dir, FILES.timings), {});
  const timingIssues =
    rawTimings?.issues && typeof rawTimings.issues === 'object'
      ? rawTimings.issues
      : {};
  // Each lane carries its phase, so the page and the pace count busy lanes by one rule.
  const lanes = state.lanes.map((/** @type {any} */ lane) => ({
    ...lane,
    phase: lanePhase(lane),
  }));
  return {
    state: { ...state, lanes },
    log: recentLog(readJsonl(path.join(dir, FILES.log)), now),
    timings: timingsView(rawTimings, now),
    laneTimeline: laneTimeline(timingIssues, state.lanes, now),
    groups: state.groups.map((/** @type {any} */ g) =>
      groupView(g, state.lanes, timingIssues, now),
    ),
    inbox: inboxView(inbox, state),
    now: new Date(now).toISOString(),
  };
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string | null>} the body, or null when it is too large
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', reject);
  });
}

/**
 * The board's request handler and its live-update hub.
 * @param {{ dir: string, log?: (line: string) => void }} options
 */
export function createBoard({ dir, log = (line) => console.log(line) }) {
  mkdirSync(dir, { recursive: true });
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  /** @type {NodeJS.Timeout | null} */
  let pending = null;
  const watcher = watch(dir, () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      for (const client of clients)
        client.write('event: changed\ndata: {}\n\n');
    }, 100);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);

  /** @param {number} port */
  const handler = (port) =>
    /** @type {http.RequestListener} */ (
      async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        /** @param {number} status @param {string} reason */
        const refuse = (status, reason) => {
          log(`board: refused ${req.method} ${url.pathname} (${reason})`);
          sendJson(res, status, { error: reason });
        };
        if (!hostAllowed(req.headers.host, port))
          return refuse(403, 'host not allowed');
        try {
          if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, PAGE_HEADERS);
            res.end(readFileSync(path.join(HERE, 'board.html')));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/favicon.ico') {
            res.writeHead(200, {
              'content-type': 'image/svg+xml',
              'cache-control': 'max-age=86400',
            });
            res.end(FAVICON);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/health') {
            return sendJson(res, 200, { board: 'working-board', dir });
          }
          if (req.method === 'GET' && url.pathname === '/api/board') {
            return sendJson(res, 200, boardData(dir));
          }
          if (req.method === 'GET' && url.pathname === '/api/events') {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              connection: 'keep-alive',
            });
            res.write('event: changed\ndata: {}\n\n');
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
          }
          if (url.pathname === '/api/inbox') {
            if (req.method !== 'POST') return refuse(405, 'method not allowed');
            if (!originAllowed(req.headers.origin, port))
              return refuse(403, 'origin not allowed');
            if (
              !/^application\/json\b/i.test(req.headers['content-type'] ?? '')
            ) {
              return refuse(415, 'content-type must be application/json');
            }
            const raw = await readBody(req);
            if (raw === null) return refuse(413, 'body too large');
            let body;
            try {
              body = JSON.parse(raw);
            } catch {
              return refuse(400, 'body is not valid JSON');
            }
            const state = normalizeState(
              readJson(path.join(dir, FILES.state), null),
            );
            const checked = checkInbox(body, state);
            if (!checked.ok) return refuse(400, checked.error);
            const item = {
              id: newInboxId(),
              at: new Date().toISOString(),
              ...checked.item,
            };
            appendJsonl(path.join(dir, FILES.inbox), item);
            log(`board: inbox ${item.kind} ${item.id}`);
            return sendJson(res, 201, { id: item.id, at: item.at });
          }
          return refuse(404, 'not found');
        } catch (error) {
          log(
            `board: error on ${req.method} ${url.pathname}: ${/** @type {Error} */ (error).message}`,
          );
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
          else res.end();
        }
      }
    );

  const close = () => {
    watcher.close();
    clearInterval(heartbeat);
    if (pending) clearTimeout(pending);
    for (const client of clients) client.end();
    clients.clear();
  };
  return { handler, close };
}

/**
 * Asks whatever listens on `port` whether it is a board serving `dir`.
 * @param {number} port
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
function isOurBoard(port, dir) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/api/health',
        headers: { host: `127.0.0.1:${port}` },
        timeout: 1500,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(text);
            resolve(body.board === 'working-board' && body.dir === dir);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Starts the board on 127.0.0.1. Port 0 takes any free port (the tests).
 * @param {{ dir: string, port: number, tries?: number, log?: (line: string) => void }} options
 * @returns {Promise<{ port: number, reused: boolean, close: () => Promise<void> }>}
 */
export async function startBoard({
  dir,
  port,
  tries = 11,
  log = (line) => console.log(line),
}) {
  const candidates =
    port === 0
      ? [0]
      : Array.from({ length: tries }, (_, i) => port + i).filter(
          (p) => p <= 65535,
        );
  // A board for this directory on any of the ports (an earlier start may have fallen back to a
  // higher one): reuse it, never start a second.
  for (const candidate of candidates) {
    if (candidate !== 0 && (await isOurBoard(candidate, dir))) {
      return { port: candidate, reused: true, close: async () => {} };
    }
  }
  for (const candidate of candidates) {
    const server = http.createServer();
    const listening = await new Promise((resolve, reject) => {
      server.once('error', (error) => {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE')
          resolve(false);
        else reject(error);
      });
      server.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (!listening) continue;
    // Watching starts only once the port is ours, so a failed start leaves nothing running.
    const board = createBoard({ dir, log });
    const address = server.address();
    const actual =
      typeof address === 'object' && address ? address.port : candidate;
    server.on('request', board.handler(actual));
    return {
      port: actual,
      reused: false,
      close: () =>
        new Promise((resolve) => {
          board.close();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }
  throw new Error(`no free port from ${port} to ${port + tries - 1}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dir = boardDir(process.env, process.cwd());
  startBoard({ dir, port: boardPort(process.env) })
    .then(({ port, reused }) => {
      const url = `http://127.0.0.1:${port}/`;
      if (reused) {
        console.log(`board: already running at ${url} for ${dir}`);
        process.exit(0);
      }
      console.log(`board: listening on ${url} (dir ${dir})`);
    })
    .catch((error) => {
      console.error(
        `board: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
