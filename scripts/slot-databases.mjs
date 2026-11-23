#!/usr/bin/env node
// Drops agent slots' databases on the local compose Postgres (the names:
// scripts/slot-databases-plan.mjs). Run by agent-slot.mjs, which holds the slot registry's lock
// around it, so no slot is created or removed meanwhile:
//
//   node scripts/slot-databases.mjs drop <slot> [--settings <file>] [--dry-run]
//   node scripts/slot-databases.mjs prune [--yes]
//
// drop: the databases derived from that slot's name (`ccms_<slot>`, `ccms_perf_<slot>_<profile>`)
// that exist, unless protected or another live slot's name derives them too. prune: lists the
// databases a slot could have made whose slot is gone; drops them only with --yes. Neither ever
// uses `WITH (FORCE)`: a database with open connections is skipped with a note.
//
// The server is the one the settings name (`CCMS_DATABASE_URL` in the slot's .env.local, then
// the main checkout's), else the compose default; only one on this machine, and for `drop` only
// the main checkout's server; the URL (it holds the password) is never printed. Postgres not
// answering is a note, not a failure; refusing the connection is a failure. Run directly, this
// script takes no lock: run it through `pnpm slot`.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import {
  checkoutDatabases,
  isProtected,
  maintenanceUrl,
  orphanDatabases,
  ownerComment,
  slotDatabasesToDrop,
} from './slot-databases-plan.mjs';
import { run } from './agent-slot-io.mjs';
import { readSlots } from './slot-file.mjs';

/** The compose Postgres as `setup-local` writes it (compose.yaml; local credentials only). */
export const COMPOSE_DATABASE_URL = 'postgres://ccms:ccms@127.0.0.1:5432/ccms';

/** Postgres: "database is being accessed by other users". */
const IN_USE = '55006';

/**
 * The server to drop on, from the first settings file (in order) that sets `CCMS_DATABASE_URL`:
 * `{ url, host }`, or `{ why }` when that one is not usable (not local, not a URL, …): then
 * nothing is dropped, never on another server instead. No file sets it: the compose default.
 */
export function serverFrom(files) {
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    let value;
    try {
      value = parseEnv(readFileSync(file, 'utf8')).CCMS_DATABASE_URL;
    } catch {
      continue;
    }
    if (value === undefined || value === '') continue;
    return maintenanceUrl(value);
  }
  return maintenanceUrl(COMPOSE_DATABASE_URL);
}

/**
 * The slot's server, only when it is the main checkout's too (or `{ why }`): a slot's settings
 * never send a drop to another Postgres on this machine.
 */
export function sameServer(slotServer, mainServer) {
  if (slotServer.why || mainServer.why)
    return slotServer.why ? slotServer : mainServer;
  return slotServer.host === mainServer.host
    ? slotServer
    : {
        why: "the slot's settings name another server than the main checkout's",
      };
}

/** The slots that are live: every record (one being created too) and every worktree folder. */
export function liveSlots(root) {
  const names = new Set(readSlots(root).map((slot) => slot.name));
  const worktrees = path.join(root, '.claude', 'worktrees');
  if (existsSync(worktrees)) {
    for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  }
  return [...names];
}

/** A pg client on `url`, with pg from the API's dependencies (the scripts have none of their own). */
export function pgConnect(root) {
  return (url) => {
    const pg = createRequire(path.join(root, 'backend', 'api', 'package.json'))(
      'pg',
    );
    return new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 3_000,
      // A drop never waits on a lock for long.
      statement_timeout: 30_000,
    });
  };
}

/** The client connected, or undefined with a note (Postgres down is not a failure). */
async function open(server, connect, log, nothing) {
  if (server.why) {
    log(`Databases: ${nothing} (${server.why}).`);
    return undefined;
  }
  let client;
  try {
    client = connect(server.url);
    await client.connect();
    return client;
  } catch (error) {
    await client?.end().catch(() => undefined);
    const message = String(error?.message ?? '');
    const down = DOWN.includes(error?.code) || /timeout/i.test(message);
    log(
      down
        ? `Databases: ${nothing}: Postgres does not answer at ${server.host} (${error?.code ?? 'timeout'}). Later: pnpm slot prune-databases.`
        : `Databases: ${nothing}: Postgres at ${server.host} refused the connection (${error?.code ?? message}).`,
    );
    return down ? 'down' : 'refused';
  }
}

/** Connection errors that mean Postgres is not running (a note), not that it refused us. */
const DOWN = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  '57P03',
];

/**
 * Drops one database, without FORCE. `dropped`, `in use` (open connections: left as it is) or
 * `failed: <reason>`. Refuses a protected name or one that is not a plain identifier.
 */
async function dropOne(client, name) {
  if (isProtected(name) || !/^ccms_[a-z0-9_]+$/.test(name)) {
    return 'failed: not a slot database';
  }
  try {
    await client.query(`drop database if exists "${name}"`);
    return 'dropped';
  } catch (error) {
    if (error?.code === IN_USE) return 'in use, left as it is';
    return `failed: ${error?.code ?? ''} ${error?.message ?? ''}`.trim();
  }
}

/**
 * `drop <slot>`: drops the slot's own databases (or, `dryRun`, says which it would). Returns
 * whether every drop it tried went through (a database in use counts as fine: it is skipped).
 */
export async function dropSlotDatabases({
  slot,
  live,
  owner,
  server,
  connect,
  dryRun = false,
  log = console.log,
}) {
  const client = await open(server, connect, log, 'none dropped');
  if (typeof client !== 'object') return client !== 'refused';
  let ok = true;
  try {
    const { rows } = await client.query(
      `select datname, shobj_description(oid, 'pg_database') as comment
         from pg_database where datname = any($1::text[])`,
      [checkoutDatabases(slot)],
    );
    const { drop, kept } = slotDatabasesToDrop({
      slot,
      liveSlots: live,
      existing: rows.map(asDatabase),
      owner,
    });
    for (const { name, why } of kept) {
      log(`Databases: ${name} stays (${why}).`);
    }
    if (drop.length === 0 && kept.length === 0)
      log(`Databases: the slot has none on ${server.host}.`);
    for (const name of drop) {
      if (dryRun) {
        log(`Databases: would drop ${name}.`);
        continue;
      }
      const outcome = await dropOne(client, name);
      if (outcome.startsWith('failed')) ok = false;
      log(`Databases: ${name} ${outcome}.`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return ok;
}

/** A pg_database row as the plan reads it. */
function asDatabase(row) {
  return { name: row.datname, comment: row.comment ?? null };
}

/** A database's size as text, or `?` when it cannot be read. */
async function sizeOf(client, name) {
  try {
    const { rows } = await client.query(
      'select pg_size_pretty(pg_database_size($1::name)) as size',
      [name],
    );
    return rows[0]?.size ?? '?';
  } catch {
    return '?';
  }
}

/**
 * `prune`: lists the databases of slots that are gone; drops them only with `yes`. Returns
 * whether every drop it tried went through.
 */
export async function pruneDatabases({
  live,
  owner,
  server,
  connect,
  yes = false,
  log = console.log,
}) {
  const client = await open(server, connect, log, 'none listed');
  if (typeof client !== 'object') return client !== 'refused';
  let ok = true;
  try {
    const { rows } = await client.query(
      `select datname, shobj_description(oid, 'pg_database') as comment from pg_database`,
    );
    const { drop: orphans, unmarked } = orphanDatabases({
      liveSlots: live,
      existing: rows.map(asDatabase),
      owner,
    });
    if (unmarked.length > 0) {
      log(
        `Not dropped, not marked as made by this checkout's tooling (older, by hand or another clone's; drop them by hand if they are yours): ${unmarked.join(', ')}`,
      );
    }
    if (orphans.length === 0) {
      log(`Databases: no database of a slot that is gone on ${server.host}.`);
      return true;
    }
    log(
      `Databases of slots that are gone, on ${server.host} (live slots: ${live.length ? live.join(', ') : 'none'}):`,
    );
    for (const name of orphans) log(`  ${name}\t${await sizeOf(client, name)}`);
    if (!yes) {
      log(
        `Nothing dropped. To drop these ${orphans.length}: pnpm slot prune-databases --yes`,
      );
      return true;
    }
    for (const name of orphans) {
      const outcome = await dropOne(client, name);
      if (outcome.startsWith('failed')) ok = false;
      log(`Databases: ${name} ${outcome}.`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return ok;
}

/** The CLI, for agent-slot.mjs. */
async function main(argv) {
  // The main checkout (its registry, settings and pg), also when this copy is a worktree's.
  const common = run('git', [
    '-C',
    path.dirname(fileURLToPath(import.meta.url)),
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim();
  const root = path.dirname(common);
  const [command, ...rest] = argv;
  const live = liveSlots(root);
  const owner = ownerComment(realpathSync(root));
  const mainSettings = path.join(root, '.env.local');
  const mainServer = serverFrom([mainSettings]);
  const connect = pgConnect(root);
  if (command === 'drop' && rest[0] && !rest[0].startsWith('--')) {
    const at = rest.indexOf('--settings');
    const settings = at >= 0 ? rest[at + 1] : undefined;
    return dropSlotDatabases({
      slot: rest[0],
      live,
      owner,
      server: sameServer(serverFrom([settings, mainSettings]), mainServer),
      connect,
      dryRun: rest.includes('--dry-run'),
    });
  }
  if (command === 'prune') {
    return pruneDatabases({
      live,
      owner,
      server: mainServer,
      connect,
      yes: rest.includes('--yes') && !rest.includes('--dry-run'),
    });
  }
  console.error(
    'Usage: slot-databases.mjs drop <slot> [--settings <file>] [--dry-run] | prune [--yes]',
  );
  process.exit(2);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
