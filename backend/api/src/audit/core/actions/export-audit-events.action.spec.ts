import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor } from '../../../access/core/actor.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import type { Transaction } from '../../../base/core/unit-of-work.js';
import type { AuditEvent, AuditFilter } from '../audit-event.js';
import type { CheckedAuditEvent } from '../audit-log.js';
import { ExportAuditEventsAction } from './export-audit-events.action.js';

const actor = (permissions: Actor['roles'][number]['permissions']): Actor => ({
  kind: 'user',
  id: 'sample-admin',
  roles: [{ id: 'role', name: 'Role', permissions, scope: {} }],
});
const admin = actor(['admin.roles']);

const event = (id: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: String(id),
  at: new Date(Date.UTC(2026, 0, id)),
  actor: { kind: 'user', id: 'sample-admin' },
  action: 'role.assign',
  subject: { type: 'user', id: 'sample-reader' },
  comment: null,
  data: {},
  ...over,
});

const seed = () => [
  event(1),
  event(2, { action: 'module.edit', subject: { type: 'module', id: 'en/a' } }),
  event(3, { actor: { kind: 'service', id: 'importer' } }),
  event(4, { subject: { type: 'user', id: 'sample-author' } }),
];

async function collect(events: AsyncIterable<AuditEvent>): Promise<string[]> {
  const ids: string[] = [];
  for await (const e of events) ids.push(e.id);
  return ids;
}

describe('ExportAuditEventsAction', () => {
  it('hands out what the list pages through for the same filter, newest first', async () => {
    const log = new FakeAuditLog(seed());
    const action = new ExportAuditEventsAction(log, new FakeUnitOfWork());
    const filters: AuditFilter[] = [
      {},
      { subject: { type: 'user' } },
      { actor: { kind: 'service' } },
      { action: 'module.edit' },
      {
        from: new Date(Date.UTC(2026, 0, 2)),
        to: new Date(Date.UTC(2026, 0, 4)),
      },
    ];
    for (const filter of filters) {
      const exported = await collect(
        await action.handle({ actor: admin, filter, format: 'csv' }),
      );
      // The export's own event is newer than every seeded one; the list
      // is read after it, so both see it alike.
      const listed = (
        await log.list(filter, { number: 1, size: 200 })
      ).items.map((e) => e.id);
      expect(exported).toEqual(listed);
    }
  });

  it('records the export, with the format and the filter, before handing out anything', async () => {
    const log = new FakeAuditLog(seed());
    const unit = new FakeUnitOfWork();
    const action = new ExportAuditEventsAction(log, unit);
    await action.handle({
      actor: admin,
      format: 'jsonl',
      filter: {
        subject: { type: 'module', id: 'en/a' },
        actor: { kind: 'user' },
        from: new Date('2026-01-01T00:00:00Z'),
      },
    });
    expect(unit.committed).toBe(1);
    expect(log.events.at(-1)).toMatchObject({
      actor: { kind: 'user', id: 'sample-admin' },
      action: 'audit-log.export',
      subject: { type: 'audit-log', id: 'audit-events' },
      comment: null,
      data: {
        format: 'jsonl',
        filter: {
          subject: 'module/en/a',
          actor: 'user',
          from: '2026-01-01T00:00:00.000Z',
        },
      },
    });
  });

  it('hands out nothing when the export cannot be recorded', async () => {
    class FailingLog extends FakeAuditLog {
      streamed = false;
      protected override append(
        _tx: Transaction,
        _event: CheckedAuditEvent,
      ): Promise<void> {
        return Promise.reject(new Error('the database is gone'));
      }
      override stream(filter: AuditFilter) {
        this.streamed = true;
        return super.stream(filter);
      }
    }
    const log = new FailingLog(seed());
    const action = new ExportAuditEventsAction(log, new FakeUnitOfWork());
    await expect(
      action.handle({ actor: admin, filter: {}, format: 'csv' }),
    ).rejects.toThrow('the database is gone');
    expect(log.streamed).toBe(false);
  });

  it('needs admin.roles, and records nothing for anyone without it', async () => {
    const log = new FakeAuditLog(seed());
    const action = new ExportAuditEventsAction(log, new FakeUnitOfWork());
    for (const reader of [
      actor(['content.read', 'content.edit', 'webhook.manage']),
      { kind: 'service', id: 'token', roles: [] } satisfies Actor,
    ]) {
      await expect(
        action.handle({ actor: reader, filter: {}, format: 'csv' }),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(log.events).toHaveLength(4);
  });
});
