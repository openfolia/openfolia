import { sql } from 'drizzle-orm';
import { JobQueue } from '../src/jobs/core/job-queue.js';
import { ServerRole } from '../src/config/server-role.js';
import { createTestDatabase, PgliteDatabase } from './database.js';
import {
  eventually,
  jobsStatus,
  ran,
  RoleJobsModule,
  roleKind,
} from './role-test-kit.js';
import { createTestApp, type TestApp } from './test-app.js';

// CCMS_ROLE=worker (#527): the same modules; it claims on its own timer and records itself as
// a consumer, and leaves `job_consumers` on a clean shutdown. (The HTTP part of a real worker,
// the application context and its health server, is `main.ts`; the routes here only read the
// result.) A file of its own: settings are read once per test file.

/** The same PGlite after the app closed: the test closes it. */
class SharedDatabase extends PgliteDatabase {
  override async close(): Promise<void> {
    // The test closes the real one.
  }
}

describe('CCMS_ROLE=worker', () => {
  let database: PgliteDatabase;
  let t: TestApp | undefined;
  beforeAll(async () => {
    database = await createTestDatabase();
    t = await createTestApp(
      { CCMS_ROLE: 'worker', CCMS_JOBS_POLL_MS: '500' },
      {
        database: new SharedDatabase(database.client),
        imports: [RoleJobsModule],
      },
    );
  });
  afterAll(async () => {
    await t?.close();
    await database?.close();
  });

  it('claims on its timer, records itself as a consumer, and leaves on shutdown', async () => {
    expect(t!.app.get(ServerRole).name).toBe('worker');
    await t!.app.get(JobQueue).enqueue(roleKind, { n: 2 }, { key: 'worker' });
    await eventually(() => ran.length === 1);
    expect(ran).toEqual([2]);
    const s = await jobsStatus(t!);
    expect(s.attributes.consumers).toBe(1);
    await t!.close();
    t = undefined;
    const rows = await database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from job_consumers`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });
});
