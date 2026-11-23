// The scale generator's database: a fresh, migrated database per profile on the local compose
// Postgres, its users and roles through the API's own seed command, and the bulk of the
// operational history (audit events, webhook deliveries) written directly, since a hundred
// thousand API calls would take hours and these rows have no Git side.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Random, NOUNS, VERBS } from './random.mjs';
import { API_DIR, apiDist, checkoutComment, requireFromApi } from './paths.mjs';

/** Only a database on this machine, named by the tooling, is ever dropped. */
export function assertDisposable(url) {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  // pg reads query parameters (`?host=…`) as settings, so a URL with any is refused.
  if (target.search || target.hash) {
    throw new Error('perf: refusing a database URL with query parameters');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error(
      `perf: refusing a database that is not local (${target.hostname})`,
    );
  }
  if (!/^ccms_perf_[a-z0-9_]+$/.test(name)) {
    throw new Error(
      `perf: refusing a database the tooling did not name (${name})`,
    );
  }
  return name;
}

/** Throws unless the URL is disposable and its server answers: checked before anything is deleted. */
export async function assertReachable(url) {
  assertDisposable(url);
  const pg = requireFromApi('pg');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `perf: Postgres does not answer at ${admin.host} (docker compose up -d): ${error.message}`,
      { cause: error },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Drops and creates the profile's database, so every seed starts from nothing. */
export async function recreateDatabase(url) {
  const name = assertDisposable(url);
  const pg = requireFromApi('pg');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query(
      `drop database if exists ${pg.escapeIdentifier(name)} with (force)`,
    );
    await client.query(`create database ${pg.escapeIdentifier(name)}`);
    // Which checkout's tooling made it, for `pnpm slot remove` and `prune-databases`.
    await client.query(
      `comment on database ${pg.escapeIdentifier(name)} is ${pg.escapeLiteral(checkoutComment())}`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Drops the profile's database, never with FORCE: `dropped`, `in use` (open connections: left
 * as it is), `not reachable` or `failed (<code>)`. Never throws; the URL is never printed.
 */
export async function dropDatabase(url) {
  const name = assertDisposable(url);
  const pg = requireFromApi('pg');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => undefined);
    return 'not reachable';
  }
  try {
    await client.query(`drop database if exists ${pg.escapeIdentifier(name)}`);
    return 'dropped';
  } catch (error) {
    // 55006: "database is being accessed by other users".
    return error?.code === '55006'
      ? 'in use'
      : `failed (${error?.code ?? 'error'})`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * At the end of a benchmark run: the profile's database is dropped (a run changes it, so the
 * next one re-seeds anyway), unless `keep` (`--keep`). Once dropped, the profile's state says
 * so (`databaseDropped`), so the next run asks for a seed instead of failing on a missing
 * database. `statePath`: the profile's profile.json.
 */
export async function dropAfterRun(statePath, state, { keep, log }) {
  let name;
  try {
    name = assertDisposable(state.databaseUrl);
  } catch (error) {
    log(`database not dropped: ${error.message}`);
    return;
  }
  if (keep) {
    log(
      `database ${name} kept (--keep); drop it with the next run, or pnpm perf:seed again`,
    );
    return;
  }
  const outcome = await dropDatabase(state.databaseUrl);
  if (outcome === 'dropped') {
    writeFileSync(
      statePath,
      JSON.stringify(
        { ...state, databaseDropped: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    log(`database ${name} dropped (pass --keep to keep it for another run)`);
  } else {
    log(`database ${name} not dropped: ${outcome}`);
  }
}

/** Throws when the last run dropped the profile's database (`dropAfterRun`). */
export function assertDatabaseKept(state, profile) {
  if (state.databaseDropped) {
    throw new Error(
      `perf: the last run dropped the profile's database (${state.databaseDropped}); run pnpm perf:seed --profile ${profile} again (a run's --keep keeps it)`,
    );
  }
}

function runApiScript(script, args, url) {
  return execFileSync(process.execPath, [join('dist', script), ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CCMS_DATABASE_URL: url,
    },
  });
}

/** Applies every migration (the API's own command). */
export function migrate(url) {
  runApiScript('database/migrate.main.js', [], url);
}

/**
 * The roles and users of a documentation team of the profile's size: authors, reviewers,
 * approvers, a translation manager per language, publishers, readers of each audience, an
 * administrator, and the read-only role the MCP server's service account holds. Written with the
 * API's seed command (`db-seed <file>`). Returns the user IDs by role.
 */
export async function seedUsers(profile, languages, url, file) {
  const { PERMISSIONS } = await import(apiDist('access/core/permissions.js'));
  const roles = [
    {
      id: 'author',
      name: 'Author',
      permissions: ['content.read', 'content.read.draft', 'content.edit'],
      scope: {},
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      permissions: ['content.read', 'content.read.draft', 'content.review'],
      scope: {},
    },
    {
      id: 'approver',
      name: 'Approver',
      permissions: [
        'content.read',
        'content.read.draft',
        'content.review',
        'content.approve',
      ],
      scope: {},
    },
    {
      id: 'publisher',
      name: 'Publisher',
      permissions: ['content.read', 'content.read.draft', 'release.publish'],
      scope: {},
    },
    ...languages.map((lang) => ({
      id: `translator-${lang}`,
      name: `Translation manager (${lang})`,
      permissions: ['content.read', 'content.read.draft', 'translation.manage'],
      scope: { languages: [lang] },
    })),
    {
      id: 'source-reader',
      name: 'Source reader',
      permissions: ['content.read', 'content.read.draft'],
      scope: { languages: ['en'] },
    },
    {
      id: 'reader',
      name: 'Reader',
      permissions: ['content.read'],
      scope: { maxAudience: 'public' },
    },
    {
      id: 'partner-reader',
      name: 'Partner reader',
      permissions: ['content.read'],
      scope: { maxAudience: 'partner' },
    },
    {
      id: 'agent-reader',
      name: 'Agent reader',
      permissions: ['content.read'],
      scope: { maxAudience: 'public' },
    },
    { id: 'admin', name: 'Admin', permissions: [...PERMISSIONS], scope: {} },
  ];
  const users = [];
  const byRole = {
    author: [],
    reviewer: [],
    approver: [],
    publisher: [],
    translator: {},
    reader: [],
    admin: [],
  };
  const add = (id, name, userRoles, group) => {
    users.push({ id, name, roles: userRoles });
    if (group) group.push(id);
  };
  add('perf-admin', 'Perf Admin', ['admin'], byRole.admin);
  add('perf-publisher', 'Perf Publisher', ['publisher'], byRole.publisher);
  for (const lang of languages) {
    const id = `perf-translator-${lang}`;
    add(id, `Perf Translator ${lang}`, [`translator-${lang}`, 'source-reader']);
    byRole.translator[lang] = id;
  }
  const rest = Math.max(10, profile.users - users.length);
  for (let i = 0; i < rest; i++) {
    const n = String(i + 1).padStart(3, '0');
    const kind = i % 10;
    if (kind < 5)
      add(`perf-author-${n}`, `Perf Author ${n}`, ['author'], byRole.author);
    else if (kind < 7)
      add(
        `perf-reviewer-${n}`,
        `Perf Reviewer ${n}`,
        ['author', 'reviewer'],
        byRole.reviewer,
      );
    else if (kind < 8)
      add(
        `perf-approver-${n}`,
        `Perf Approver ${n}`,
        ['reviewer', 'approver'],
        byRole.approver,
      );
    else if (kind < 9)
      add(`perf-reader-${n}`, `Perf Reader ${n}`, ['reader'], byRole.reader);
    else
      add(
        `perf-partner-${n}`,
        `Perf Partner ${n}`,
        ['partner-reader'],
        byRole.reader,
      );
  }
  writeFileSync(file, JSON.stringify({ roles, users }, null, 2));
  runApiScript('database/seed.main.js', [file], url);
  return { byRole, count: users.length };
}

/**
 * A service account for the MCP server with the read-only role, and its token (printed once by
 * the API's own command; kept in the profile's state, which is git-ignored).
 */
export function serviceToken(url) {
  const out = runApiScript(
    'database/service-token.main.js',
    ['perf-agent', '--role', 'agent-reader', '--name', 'perf-mcp'],
    url,
  );
  const token = /ccms_sat_[A-Za-z0-9_-]+/.exec(out)?.[0];
  if (!token) throw new Error('perf: service-token printed no token');
  return token;
}

const AUDIT_ACTIONS = [
  ['module.edit', 30],
  ['lock.acquire', 12],
  ['lock.release', 12],
  ['change-set.commit', 10],
  ['change-set.create', 6],
  ['comment.create', 8],
  ['change-set.submit', 4],
  ['change-set.approve', 3],
  ['change-set.merge', 3],
  ['asset.upload', 4],
  ['translation-job.export', 1],
  ['translation.import', 1],
  ['role.assign', 1],
  ['webhook.update', 1],
  ['release.publish', 1],
];

/**
 * `count` audit events spread over the two years before `endSeconds`, oldest first, of the
 * kinds the API writes, by the seeded users, about the generated modules and change sets.
 */
export async function insertAuditEvents(
  url,
  { count, seed, userIds, moduleIds, endSeconds },
) {
  const pg = requireFromApi('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const random = new Random(`${seed}/audit`);
  const span = 2 * 365 * 24 * 3600;
  try {
    const batch = 5_000;
    for (let start = 0; start < count; start += batch) {
      const n = Math.min(batch, count - start);
      const at = [];
      const actor = [];
      const action = [];
      const subjectType = [];
      const subjectId = [];
      const data = [];
      for (let i = 0; i < n; i++) {
        const k = start + i;
        const verb = random.weighted(AUDIT_ACTIONS);
        const module = random.pick(moduleIds);
        at.push(
          new Date(
            (endSeconds - span + Math.floor((k / count) * span)) * 1000,
          ).toISOString(),
        );
        actor.push(random.pick(userIds));
        action.push(verb);
        if (
          verb.startsWith('module.') ||
          verb.startsWith('lock.') ||
          verb === 'comment.create'
        ) {
          subjectType.push('module');
          subjectId.push(
            `${random.pick(['en', 'en', 'en', 'de', 'fr'])}/${module}`,
          );
        } else if (verb.startsWith('change-set.')) {
          subjectType.push('change-set');
          subjectId.push(
            `00000000-0000-7000-8000-${String(k).padStart(12, '0')}`,
          );
        } else {
          subjectType.push(verb.split('.')[0]);
          subjectId.push(`${random.pick(NOUNS)}-${random.pick(VERBS)}-${k}`);
        }
        data.push(
          JSON.stringify({
            seeded: true,
            ...(random.chance(0.3) && { note: random.pick(NOUNS) }),
          }),
        );
      }
      await client.query(
        `insert into audit_events (at, actor_kind, actor_id, action, subject_type, subject_id, data)
         select a, 'user', u, act, st, sid, d::jsonb
         from unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
           as t(a, u, act, st, sid, d)`,
        [at, actor, action, subjectType, subjectId, data],
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * `count` deliveries over the webhooks, mostly delivered, some failed or pending, each with its
 * own outbox row (a delivery names the event it carries).
 */
export async function insertDeliveries(
  url,
  { count, seed, webhookIds, ownerId, endSeconds },
) {
  if (webhookIds.length === 0 || count === 0) return;
  const pg = requireFromApi('pg');
  const { randomUUID, createHash } = await import('node:crypto');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const random = new Random(`${seed}/deliveries`);
  const span = 365 * 24 * 3600;
  try {
    const batch = 2_000;
    for (let start = 0; start < count; start += batch) {
      const n = Math.min(batch, count - start);
      const outbox = await client.query(
        `insert into outbox (topic, key, payload, created_at, delivered_at)
         select 'perf.seeded-delivery', 'perf-' || ($4::int + g), '{"seeded": true}'::jsonb,
                to_timestamp($1::bigint + g * $2::double precision), now()
         from generate_series(0, $3 - 1) as g returning id`,
        [endSeconds - span, span / count, n, start],
      );
      const rows = {
        id: [],
        webhook: [],
        event: [],
        key: [],
        body: [],
        status: [],
        attempts: [],
        code: [],
        error: [],
        created: [],
        delivered: [],
        outbox: [],
      };
      outbox.rows.forEach(({ id }, i) => {
        const k = start + i;
        const status = random.weighted([
          ['succeeded', 90],
          ['failed', 6],
          ['pending', 4],
        ]);
        const created = new Date(
          (endSeconds - span + Math.floor((k / count) * span)) * 1000,
        );
        rows.id.push(randomUUID());
        rows.webhook.push(random.pick(webhookIds));
        rows.event.push(random.pick(['manual.released', 'module.released']));
        rows.key.push(
          createHash('sha256').update(`perf-delivery-${k}`).digest('hex'),
        );
        rows.body.push(JSON.stringify({ event: 'manual.released', seeded: k }));
        rows.status.push(status);
        rows.attempts.push(status === 'pending' ? 0 : random.int(1, 3));
        rows.code.push(
          status === 'succeeded' ? 200 : status === 'failed' ? 503 : null,
        );
        rows.error.push(status === 'failed' ? 'http-status' : null);
        rows.created.push(created.toISOString());
        rows.delivered.push(
          status === 'succeeded' ? created.toISOString() : null,
        );
        rows.outbox.push(id);
      });
      await client.query(
        `insert into webhook_deliveries (id, webhook_id, event, idempotency_key, body, owner_kind, owner_id,
           status, attempts, last_status_code, last_error, created_at, last_attempt_at, delivered_at, outbox_id)
         select id, w, e, k, b, 'user', $13, s, a, c, er, cr, case when a > 0 then cr end, dl, o
         from unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[],
                     $8::int[], $9::text[], $10::timestamptz[], $11::timestamptz[], $12::bigint[])
           as t(id, w, e, k, b, s, a, c, er, cr, dl, o)`,
        [
          rows.id,
          rows.webhook,
          rows.event,
          rows.key,
          rows.body,
          rows.status,
          rows.attempts,
          rows.code,
          rows.error,
          rows.created,
          rows.delivered,
          rows.outbox,
          ownerId,
        ],
      );
    }
  } finally {
    await client.end();
  }
}

/** Row counts of the tables the benchmarks read, for the profile's summary. */
export async function tableCounts(url) {
  const pg = requireFromApi('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tables = [
      'users',
      'roles',
      'audit_events',
      'change_sets',
      'working_copies',
      'locks',
      'comments',
      'releases',
      'webhooks',
      'webhook_deliveries',
      'translation_jobs',
      'translation_job_units',
      'module_index_modules',
      'asset_uploads',
      'outbox',
    ];
    const counts = {};
    for (const table of tables) {
      const { rows } = await client.query(
        `select count(*)::int as n from ${pg.escapeIdentifier(table)}`,
      );
      counts[table] = rows[0].n;
    }
    const { rows } = await client.query(
      'select pg_database_size(current_database())::bigint as bytes',
    );
    counts.databaseBytes = Number(rows[0].bytes);
    return counts;
  } finally {
    await client.end();
  }
}
