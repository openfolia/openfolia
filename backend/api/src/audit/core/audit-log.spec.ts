import { FakeAuditLog } from '../../../tests/fakes/fake-audit-log.js';
import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import type { Actor } from '../../access/core/actor.js';
import type { NewAuditEvent } from './audit-event.js';

const author: Actor = {
  kind: 'user',
  id: 'sample-author',
  roles: [
    { id: 'author', name: 'Author', permissions: ['content.edit'], scope: {} },
  ],
};
const assign: NewAuditEvent = {
  action: 'role.assign',
  subject: { type: 'user', id: 'sample-reader' },
  comment: 'Joins the review team.',
  data: { role: 'reviewer' },
};

describe('AuditLog', () => {
  let log: FakeAuditLog;
  let unit: FakeUnitOfWork;
  beforeEach(() => {
    log = new FakeAuditLog();
    unit = new FakeUnitOfWork();
  });

  it('records the actor by kind and ID only, with the event', async () => {
    await unit.run((tx) => log.record(tx, author, assign));
    expect(log.events).toEqual([
      {
        id: '1',
        at: expect.any(Date),
        kind: 'write',
        actor: { kind: 'user', id: 'sample-author' },
        action: 'role.assign',
        subject: { type: 'user', id: 'sample-reader' },
        comment: 'Joins the review team.',
        data: { role: 'reviewer' },
      },
    ]);
  });

  // #877: read retention removes reads, so only `api.read` may be one, and it always is.
  it('refuses a read that is not api.read, and api.read as a change', async () => {
    await expect(
      unit.run((tx) => log.record(tx, author, { ...assign, kind: 'read' })),
    ).rejects.toThrow('kind "read"');
    await expect(
      unit.run((tx) =>
        log.record(tx, author, {
          action: 'api.read',
          subject: { type: 'route', id: '/me' },
        }),
      ),
    ).rejects.toThrow('kind "read"');
    expect(log.events).toEqual([]);
  });

  it('stores a missing comment as null and missing data as {}', async () => {
    await unit.run((tx) =>
      log.record(tx, author, {
        action: 'module.write',
        subject: { type: 'module', id: 'en/battery-charging' },
      }),
    );
    expect(log.events[0]).toMatchObject({ comment: null, data: {} });
  });

  it('keeps nothing when the work fails after recording', async () => {
    await expect(
      unit.run(async (tx) => {
        await log.record(tx, author, assign);
        throw new Error('the change itself failed');
      }),
    ).rejects.toThrow('the change itself failed');
    expect(log.events).toEqual([]);
    expect(unit.rolledBack).toBe(1);
  });

  it('refuses a malformed event, failing the work', async () => {
    const bad: NewAuditEvent[] = [
      // Outside the catalogue's type too: a caller that slipped past it, checked at run time.
      { ...assign, action: 'assign' as NewAuditEvent['action'] },
      { ...assign, action: 'Role.Assign' as NewAuditEvent['action'] },
      { ...assign, subject: { type: 'User', id: 'x' } },
      { ...assign, subject: { type: 'user', id: '' } },
      { ...assign, comment: '' },
      { ...assign, data: { big: 'x'.repeat(70_000) } },
      // Postgres cannot store U+0000; refused by name, not by a failed insert.
      { ...assign, comment: 'a\u0000b' },
      { ...assign, subject: { type: 'user', id: 'a\u0000' } },
      { ...assign, data: { note: 'a\u0000b' } },
      { ...assign, data: { 'a\u0000': 1 } },
      { ...assign, data: { deep: [{ x: '\u0000' }] } },
      // Parsing would drop it silently, changing the record.
      { ...assign, data: JSON.parse('{"a":1,"__proto__":{"x":2}}') },
      { ...assign, data: JSON.parse('{"n":{"__proto__":[1]}}') },
      { ...assign, data: { fn: (() => 1) as unknown as string } },
      { ...assign, extra: true } as NewAuditEvent,
    ];
    for (const event of bad) {
      await expect(
        unit.run((tx) => log.record(tx, author, event)),
      ).rejects.toThrow('Invalid audit event');
    }
    await expect(
      unit.run((tx) => log.record(tx, { ...author, id: '' }, assign)),
    ).rejects.toThrow('Invalid audit event');
    expect(log.events).toEqual([]);
  });

  it('keeps data exactly as given', async () => {
    const data = { a: [1, null, true, { b: 'c' }], 'key.with-dots': {} };
    await unit.run((tx) => log.record(tx, author, { ...assign, data }));
    expect(log.events[0]?.data).toEqual(data);
  });

  it('refuses a write through a transaction that has ended', async () => {
    const escaped = await unit.run(async (tx) => tx);
    await expect(log.record(escaped, author, assign)).rejects.toThrow(
      'The transaction has ended.',
    );
  });
});
