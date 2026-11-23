import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../src/access/core/actor.js';
import { JobsStatusDocument } from '../src/jobs/api/jobs-status.resources.js';
import { defineJob, JobHandler } from '../src/jobs/core/job.js';
import { actorWith } from './fakes/actors.js';
import type { TestApp } from './test-app.js';

// What the role tests (#527) share. Settings are read once per test file, so each role has a
// file of its own (`roles-api.e2e.spec.ts`, `roles-worker.e2e.spec.ts`).

export const roleKind = defineJob({
  name: 'test.role',
  payload: z.strictObject({ n: z.number() }),
  retryDelaySeconds: 1,
});

/** What the handler ran, in order. */
export const ran: number[] = [];

@Injectable()
class RoleHandler extends JobHandler<{ n: number }> {
  readonly kind = roleKind;
  async run(payload: { n: number }) {
    ran.push(payload.n);
  }
}

@Module({ providers: [RoleHandler] })
export class RoleJobsModule {}

const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };

/** `GET /jobs/status` as an administrator. */
export async function jobsStatus(app: TestApp) {
  app.actAs(admin);
  const res = await app.get('/jobs/status');
  app.actAs(undefined);
  expect(res.status).toBe(200);
  return JobsStatusDocument.parse(res.body).data;
}

/** Waits up to `ms` for `check` to hold, on real timers. */
export async function eventually(check: () => boolean, ms = 15_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('did not happen in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
