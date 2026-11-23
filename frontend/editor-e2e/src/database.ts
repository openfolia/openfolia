// The run's database, for the few states no route of the API makes. Everything else a flow
// needs is made through the API (`api.ts`).
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

interface Client {
  connect(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** `pg`, the API's own driver (this suite has no database dependency of its own). */
function newClient(): Client {
  const url = process.env['E2E_DATABASE_URL'];
  if (!url) throw new Error('E2E_DATABASE_URL comes from the global setup');
  // Only the run's own database, on this machine: never one a stray variable names.
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `E2E_DATABASE_URL must name the run's own database, not ${host}`,
    );
  }
  const pg = createRequire(join(ROOT, 'backend/api/package.json'))('pg') as {
    Client: new (options: { connectionString: string }) => Client;
  };
  return new pg.Client({ connectionString: url });
}

/**
 * Makes `releaseId` a release whose planning was refused for too many files (#477), as the
 * planning job records it for a release over `CCMS_RELEASE_MAX_OUTPUTS`: its files removed and
 * the refusal recorded, in one transaction. The run's limit is the default (20,000), far above
 * the sample content, and lowering it would refuse every other flow's releases, so the state is
 * made here; `wanted` must be above that limit for the API to keep refusing it. Call it once the
 * release's planning has ended, so no planning writes files after it.
 */
export async function refuseReleaseOutputs(
  releaseId: string,
  refusal: { wanted: number; max: number },
): Promise<void> {
  const client = newClient();
  await client.connect();
  try {
    await client.query('begin');
    await client.query('delete from release_outputs where release_id = $1', [
      releaseId,
    ]);
    await client.query(
      `insert into release_output_refusals (release_id, reason, wanted, max, refused_at)
       values ($1, 'too-many-outputs', $2, $3, now())`,
      [releaseId, refusal.wanted, refusal.max],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Render jobs (`release.outputs`) of outputs that match `where` (on `o`, the output), in `states`. */
const RENDER_JOBS = (where: string, states: string) =>
  `select j.id, j.started_on from pgboss.job j
     join release_outputs o on o.id::text = j.singleton_key
    where j.name = 'release.outputs' and j.state in (${states}) and ${where}`;

/** Polls `done` every 500 ms until it holds, at most until `until`, else throws `what`. */
async function waitFor(
  done: () => Promise<boolean>,
  until: number,
  what: string,
): Promise<void> {
  while (!(await done())) {
    if (Date.now() > until) throw new Error(what);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Puts the files of `releaseIds` back to waiting for their turn (#497), as a release's files are
 * while newer releases' render first: queued, with no render job yet (`scheduled_at` null). The
 * run renders the sample content's files in seconds, so a backlog is made here. Call it once the
 * releases' own rendering has ended. At most `waitMs` in all, it:
 *
 * 1. waits until no render job of theirs is left (a file its group's render made may leave its
 *    own job queued, which would render it again after the hold);
 * 2. takes them out of their reuse groups (`reuse_group` null, as an output from before groups):
 *    other flows cut releases of the same product meanwhile, in the same groups, and a file one
 *    of those makes, or finds made, serves every output of its group still to render, which made
 *    the held files ready before the page read them (#536). No render looks for them now;
 * 3. waits until the render jobs of those groups running at that moment have ended: one of another
 *    release may have picked a held output as the file's own (its group's oldest) while that was
 *    still to render, before its own job ended it, and would finish it by its id and queue its
 *    release's next files once it is back to waiting;
 * 4. then puts the files back to waiting.
 *
 * Planning them again (`POST /releases/:id/outputs/plan`) gives the files their jobs, and every
 * file is made again, each at its own release.
 */
export async function holdReleaseOutputs(
  releaseIds: readonly string[],
  waitMs = 120_000,
): Promise<number> {
  const client = newClient();
  await client.connect();
  try {
    const until = Date.now() + waitMs;
    await waitFor(
      async () =>
        (
          await client.query(
            RENDER_JOBS(
              'o.release_id = any($1::uuid[])',
              `'created', 'retry', 'active'`,
            ),
            [releaseIds],
          )
        ).rowCount === 0,
      until,
      'the releases still have render jobs left',
    );
    const { rows: groups } = await client.query(
      `with held as (
         select id, reuse_group from release_outputs where release_id = any($1::uuid[]) for update
       ), freed as (
         update release_outputs o set reuse_group = null from held
          where o.id = held.id
       )
       select distinct reuse_group from held where reuse_group is not null`,
      [releaseIds],
    );
    const left = groups.map((g) => String(g['reuse_group']));
    // Each running job by its id and start: a retry starts again, and reads the groups as now.
    const running = (
      await client.query(
        RENDER_JOBS('o.reuse_group = any($1::uuid[])', `'active'`),
        [left],
      )
    ).rows.map((r) => `${String(r['id'])}@${String(r['started_on'])}`);
    if (running.length > 0) {
      await waitFor(
        async () => {
          const { rows } = await client.query(
            `select id, started_on from pgboss.job where id = any($1::uuid[]) and state = 'active'`,
            [running.map((r) => r.split('@')[0])],
          );
          return !rows.some((r) =>
            running.includes(`${String(r['id'])}@${String(r['started_on'])}`),
          );
        },
        until,
        "render jobs of the releases' groups are still running",
      );
    }
    const { rowCount } = await client.query(
      `update release_outputs
         set state = 'queued', sha256 = null, size = null, reused_from_release = null,
             reused_from_output = null, finished_at = null, scheduled_at = null
       where release_id = any($1::uuid[])`,
      [releaseIds],
    );
    return rowCount ?? 0;
  } finally {
    await client.end();
  }
}

/**
 * Puts the planning of `releaseIds` back to waiting (#497), as a release's planning waits behind
 * other work: each release's latest planning job (`release.plan-
 * outputs`, keyed by it) queued again, due only in ten minutes. The run plans the sample
 * content's releases in moments, so the wait is made here. Call it once the releases' planning
 * has ended; `releasePlanning` lets the jobs run (planning again adds nothing: the rows are
 * there). The rows of the release are left alone. How many jobs it held.
 */
export async function holdPlanning(
  releaseIds: readonly string[],
): Promise<number> {
  return planningDue(releaseIds, `now() + interval '10 minutes'`, 'completed');
}

/**
 * Takes back the files of `releaseId` (#527), as a release is before its planning: its output
 * rows and the record that its planning ran to its end removed, in one transaction, nothing else. With its planning held (`holdPlanning`), it is a release still to be
 * planned, which the product's later releases are planned after. Call it once its files are all
 * made, on a product no other flow releases (`ownProduct`), since a later release's planning
 * would plan it again. How many rows it removed.
 */
export async function unplanRelease(releaseId: string): Promise<number> {
  const client = newClient();
  await client.connect();
  try {
    await client.query('begin');
    const { rowCount } = await client.query(
      'delete from release_outputs where release_id = $1',
      [releaseId],
    );
    // And that its planning ran to its end (#527), so it is a release still to be planned.
    await client.query('delete from release_plannings where release_id = $1', [
      releaseId,
    ]);
    await client.query('commit');
    return rowCount ?? 0;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Makes the planning of `releaseId` one cut off part way (#527): its rows stay, the record that
 * it ran to its end goes, so its held job (`holdPlanning`) is its planning still to come again.
 * Whether it removed one.
 */
export async function cutOffPlanning(releaseId: string): Promise<boolean> {
  const client = newClient();
  await client.connect();
  try {
    const { rowCount } = await client.query(
      'delete from release_plannings where release_id = $1',
      [releaseId],
    );
    return (rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

/** Lets the planning `holdPlanning` held run now. */
export async function releasePlanning(
  releaseIds: readonly string[],
): Promise<number> {
  return planningDue(releaseIds, 'now()', 'created');
}

async function planningDue(
  releaseIds: readonly string[],
  due: string,
  from: 'completed' | 'created',
): Promise<number> {
  const client = newClient();
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `update pgboss.job j set state = 'created', start_after = ${due}, started_on = null, completed_on = null
        where j.name = 'release.plan-outputs' and j.state = $2 and j.singleton_key = any($1::text[])
          and j.created_on = (select max(created_on) from pgboss.job o
                               where o.name = j.name and o.singleton_key = j.singleton_key)`,
      [releaseIds, from],
    );
    return rowCount ?? 0;
  } finally {
    await client.end();
  }
}

/**
 * The backup service as the API sees it (#529): no such service runs in this suite (it needs the
 * Postgres client tools and a real server), so a flow plays its part in the database. `beat`
 * writes its heartbeat, so the page offers "Test location" and "Back up now".
 */
export async function beatBackupService(): Promise<void> {
  const client = newClient();
  await client.connect();
  try {
    await client.query(
      `insert into backup_service (id, process_id, started_at, last_seen_at, overrides, key_fingerprint)
       values (1, 'editor-e2e', now(), now(), '{}'::jsonb, null)
       on conflict (id) do update set last_seen_at = now(), process_id = 'editor-e2e'`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Answers the next pending backup request of `kind` as the service would: a location test
 * `done` or `failed` with `detail`; a backup `done`, with a verified run of 4 KiB at the S3
 * location, to `fingerprint`. Waits for the request up to `waitMs`. Answers the run's ID, or null.
 */
export async function answerBackupRequest(
  kind: 'run' | 'test-location',
  answer: { failed?: string; fingerprint?: string; location?: string },
  waitMs = 10_000,
): Promise<string | null> {
  const client = newClient();
  await client.connect();
  try {
    const until = Date.now() + waitMs;
    let id: string | undefined;
    for (;;) {
      const { rows } = await client.query(
        `select id from backup_requests where kind = $1 and status = 'pending' order by created_at limit 1`,
        [kind],
      );
      id = rows[0]?.['id'] as string | undefined;
      if (id) break;
      if (Date.now() > until) throw new Error(`no pending ${kind} request`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (answer.failed !== undefined) {
      await client.query(
        `update backup_requests set status = 'failed', started_at = now(), finished_at = now(),
           error = 'location-test-failed', error_detail = $2 where id = $1`,
        [id, answer.failed],
      );
      return null;
    }
    if (kind === 'test-location') {
      await client.query(
        `update backup_requests set status = 'done', started_at = now(), finished_at = now() where id = $1`,
        [id],
      );
      return null;
    }
    const { rows } = await client.query(
      `insert into backup_runs (id, trigger, status, started_at, finished_at, size_bytes, sha256,
         location, name, key_fingerprint, verified, verify_mode, process_id, request_id)
       values (gen_random_uuid(), 'manual', 'succeeded', now() - interval '65 seconds', now(), 4096,
         repeat('a', 64), $2, 'openfolia-backup-' || to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MISS"Z"') || '-e2e00000.tar.age',
         $3, true, 'decrypted', 'editor-e2e', $1)
       returning id`,
      [id, answer.location ?? 's3:backups/e2e/', answer.fingerprint ?? null],
    );
    const runId = rows[0]?.['id'] as string;
    await client.query(
      `update backup_requests set status = 'done', started_at = now(), finished_at = now(), run_id = $2 where id = $1`,
      [id, runId],
    );
    return runId;
  } finally {
    await client.end();
  }
}

/** The backups as a fresh installation has them: no settings, key, service, request or run. */
export async function resetBackups(): Promise<void> {
  const client = newClient();
  await client.connect();
  try {
    await client.query(
      'truncate backup_runs, backup_requests, backup_keys, backup_service, backup_settings',
    );
  } finally {
    await client.end();
  }
}

/**
 * Holds an outbox consumer of the test's own, `name` (a lowercase key no real consumer has), as a
 * restore onto another database server leaves one (#619): `GET /outbox/status` names it until
 * `releaseOutboxConsumer`. The real consumers (notifications, webhooks, the change feed) are never
 * touched, so no other flow stops hearing of anything.
 */
export async function holdOutboxConsumer(name: string): Promise<void> {
  const client = newClient();
  await client.connect();
  try {
    await client.query(
      `insert into outbox_consumers (name, blocked) values ($1, true)
       on conflict (name) do update set blocked = true`,
      [name],
    );
  } finally {
    await client.end();
  }
}

/** Removes the consumer `holdOutboxConsumer` made. */
export async function releaseOutboxConsumer(name: string): Promise<void> {
  const client = newClient();
  await client.connect();
  try {
    await client.query('delete from outbox_consumers where name = $1', [name]);
  } finally {
    await client.end();
  }
}
