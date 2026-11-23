import { JobQueue } from '../src/jobs/core/job-queue.js';
import { ReleaseOutputSweeper } from '../src/releases/api/release-output-sweeper.js';
import { ServerRole } from '../src/config/server-role.js';
import { jobsStatus, ran, RoleJobsModule, roleKind } from './role-test-kit.js';
import { createTestApp, type TestApp } from './test-app.js';

// CCMS_ROLE=api (#527): serves HTTP and enqueues, consumes no job and runs no background loop,
// even with polling on. A file of its own: settings are read once per test file.
describe('CCMS_ROLE=api', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp(
      { CCMS_ROLE: 'api', CCMS_JOBS_POLL_MS: '500' },
      { imports: [RoleJobsModule] },
    );
  });
  afterAll(() => t?.close());

  it('enqueues but claims nothing, and records no consumer', async () => {
    expect(t.app.get(ServerRole).name).toBe('api');
    await t.app.get(JobQueue).enqueue(roleKind, { n: 1 }, { key: 'api' });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(ran).toEqual([]);
    const s = await jobsStatus(t);
    expect(s.attributes).toMatchObject({ ready: 1, running: 0, consumers: 0 });
    expect(s.meta.level).toBe('ok');
  });

  it('starts no background loop', () => {
    const sweeper = t.app.get(ReleaseOutputSweeper) as unknown as {
      timer?: NodeJS.Timeout;
    };
    expect(sweeper.timer).toBeUndefined();
  });

  it('still answers its health routes, with no worker running', async () => {
    const res = await t.anonymous().get('/health/ready');
    expect(res.status).toBe(200);
  });
});
