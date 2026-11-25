import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { serviceAccountActor } from '../../../access/core/service-accounts.js';
import { RecordReadAction } from './record-read.action.js';

const agent = serviceAccountActor('agent', [
  {
    id: 'reader',
    name: 'Reader',
    permissions: ['content.read'],
    scope: {},
  },
]);

describe('RecordReadAction (#877)', () => {
  let log: FakeAuditLog;
  let action: RecordReadAction;
  beforeEach(() => {
    log = new FakeAuditLog();
    action = new RecordReadAction(log, new FakeUnitOfWork());
  });

  it('records one read naming the account, the token, the path, the route, the ref, the commit, the status and the client', async () => {
    await action.handle([
      {
        actor: agent,
        tokenId: '0123456789abcdef',
        path: '/modules/en/charging',
        route: '/modules/:lang/:id',
        status: 200,
        ref: 'main',
        commit: 'a'.repeat(40),
        client: 'mcp/read_module',
      },
    ]);
    expect(log.events).toEqual([
      {
        id: '1',
        at: expect.any(Date),
        kind: 'read',
        actor: { kind: 'service', id: 'agent' },
        action: 'api.read',
        subject: { type: 'route', id: '/modules/en/charging' },
        comment: null,
        data: {
          tokenId: '0123456789abcdef',
          status: 200,
          route: '/modules/:lang/:id',
          ref: 'main',
          commit: 'a'.repeat(40),
          client: 'mcp/read_module',
        },
      },
    ]);
  });

  it('leaves out a malformed client, strips control characters and cuts long values', async () => {
    await action.handle([
      {
        actor: agent,
        tokenId: '0123456789abcdef',
        path: `/search/${'x'.repeat(600)}`,
        status: 404,
        ref: 'ma\u0000in\n',
        client: 'mcp/<script>',
        aborted: true,
      },
    ]);
    const [event] = log.events;
    expect(event!.subject.id).toHaveLength(500);
    expect(event!.data).toEqual({
      tokenId: '0123456789abcdef',
      status: 404,
      ref: 'main',
      aborted: true,
    });
  });

  it('records gaps first, naming the account and the count, with the reads in the same transaction', async () => {
    const unit = new FakeUnitOfWork();
    action = new RecordReadAction(log, unit);
    await action.handle(
      [{ actor: agent, tokenId: '0123456789abcdef', path: '/me', status: 200 }],
      [
        {
          actor: agent,
          count: 312,
          from: new Date('2026-11-25T09:00:00Z'),
          to: new Date('2026-11-25T09:00:05Z'),
        },
      ],
    );
    expect(unit.committed).toBe(1);
    expect(
      log.events.map((e) => [e.action, e.kind, e.subject, e.data]),
    ).toEqual([
      [
        'api.read-gap',
        'read',
        { type: 'service-account', id: 'agent' },
        {
          count: 312,
          from: '2026-11-25T09:00:00.000Z',
          to: '2026-11-25T09:00:05.000Z',
        },
      ],
      [
        'api.read',
        'read',
        { type: 'route', id: '/me' },
        { tokenId: '0123456789abcdef', status: 200 },
      ],
    ]);
  });
});
