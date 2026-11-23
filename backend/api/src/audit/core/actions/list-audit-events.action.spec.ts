import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import type { Actor } from '../../../access/core/actor.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import type { AuditEvent } from '../audit-event.js';
import { ListAuditEventsAction } from './list-audit-events.action.js';

const actor = (permissions: Actor['roles'][number]['permissions']): Actor => ({
  kind: 'user',
  id: 'someone',
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

const action = new ListAuditEventsAction(
  new FakeAuditLog([
    event(1),
    event(2, {
      action: 'module.edit',
      subject: { type: 'module', id: 'en/a' },
    }),
    event(3, { actor: { kind: 'service', id: 'importer' } }),
    event(4, { subject: { type: 'user', id: 'sample-author' } }),
  ]),
);
const all = { number: 1, size: 50 };
const ids = (r: { items: AuditEvent[] }) => r.items.map((e) => e.id);

describe('ListAuditEventsAction', () => {
  it('lists newest first, paged, with the total', async () => {
    const first = await action.handle({
      actor: admin,
      filter: {},
      page: { number: 1, size: 3 },
    });
    expect(ids(first)).toEqual(['4', '3', '2']);
    expect(first.total).toBe(4);
    const second = await action.handle({
      actor: admin,
      filter: {},
      page: { number: 2, size: 3 },
    });
    expect(ids(second)).toEqual(['1']);
  });

  it('filters by subject, actor and action', async () => {
    const list = (filter: Parameters<typeof action.handle>[0]['filter']) =>
      action.handle({ actor: admin, filter, page: all }).then(ids);
    expect(await list({ subject: { type: 'user' } })).toEqual(['4', '3', '1']);
    expect(
      await list({ subject: { type: 'user', id: 'sample-author' } }),
    ).toEqual(['4']);
    expect(await list({ actor: { kind: 'service' } })).toEqual(['3']);
    expect(await list({ actor: { kind: 'user', id: 'sample-admin' } })).toEqual(
      ['4', '2', '1'],
    );
    expect(await list({ action: 'module.edit' })).toEqual(['2']);
    expect(
      await list({ action: 'role.assign', actor: { kind: 'service' } }),
    ).toEqual(['3']);
  });

  it(`needs admin.roles`, async () => {
    for (const reader of [
      actor(['content.read', 'content.edit', 'webhook.manage']),
      { kind: 'service', id: 'token', roles: [] } satisfies Actor,
    ]) {
      await expect(
        action.handle({ actor: reader, filter: {}, page: all }),
      ).rejects.toThrow(ForbiddenError);
    }
  });
});
