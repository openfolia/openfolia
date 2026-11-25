import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { FakeAuditLog } from '../../../tests/fakes/fake-audit-log.js';
import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import { serviceAccountActor } from '../../access/core/service-accounts.js';
import {
  type ReadGap,
  type ReadRequest,
  RecordReadAction,
} from '../core/actions/record-read.action.js';
import {
  READS_RETRY_MS,
  READS_RUNNING,
  ReadAuditMiddleware,
} from './read-audit.middleware.js';

const reader = {
  id: 'reader',
  name: 'Reader',
  permissions: ['content.read' as const],
  scope: {},
};
const agent = serviceAccountActor('agent', [reader]);
const other = serviceAccountActor('other', [reader]);

/** `RecordReadAction` over the fake log: calls held until `release()`, or failing as `fails` says. */
class HeldRecordRead extends RecordReadAction {
  readonly log: FakeAuditLog;
  calls = 0;
  holding = true;
  fails: (reads: readonly ReadRequest[], gaps: readonly ReadGap[]) => boolean =
    () => false;
  private readonly held: (() => void)[] = [];

  constructor(log = new FakeAuditLog()) {
    super(log, new FakeUnitOfWork());
    this.log = log;
  }

  override async handle(
    reads: readonly ReadRequest[],
    gaps: readonly ReadGap[] = [],
  ): Promise<void> {
    this.calls++;
    if (this.holding) await new Promise<void>((r) => this.held.push(r));
    if (this.fails(reads, gaps)) throw new TypeError('refused');
    await super.handle(reads, gaps);
  }

  release(): void {
    this.holding = false;
    for (const go of this.held.splice(0)) go();
  }
}

/** One answered GET of `actor`'s token, through the middleware. */
function read(
  middleware: ReadAuditMiddleware,
  actor = agent,
  path = '/me',
  query: Record<string, string> = {},
) {
  const req = {
    method: 'GET',
    actor,
    serviceTokenId: '0123456789abcdef',
    route: { path },
    query,
    originalUrl: path,
    headers: {},
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: true,
    getHeader: () => undefined,
  }) as unknown as Response;
  middleware.use(req, res, () => undefined);
  res.emit('close');
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const gapsOf = (log: FakeAuditLog) =>
  log.events
    .filter((e) => e.action === 'api.read-gap')
    .map((e) => [e.actor.id, e.subject, e.kind, e.data['count']]);
const readsOf = (log: FakeAuditLog) =>
  log.events.filter((e) => e.action === 'api.read').map((e) => e.subject.id);

describe('ReadAuditMiddleware (#877)', () => {
  afterEach(() => vi.useRealTimers());

  it('records a burst past the cap: each read it holds, and the rest as one gap per account with its count', async () => {
    const record = new HeldRecordRead();
    const middleware = new ReadAuditMiddleware(record);
    middleware.waitingLimit = 3;

    // READS_RUNNING recordings start, 3 reads wait, the rest are counted per account.
    for (let i = 0; i < READS_RUNNING + 3 + 5; i++) read(middleware);
    for (let i = 0; i < 2; i++) read(middleware, other);
    expect(record.calls).toBe(READS_RUNNING);
    expect(middleware.pending()).toBe(READS_RUNNING + 3 + 5 + 2);

    record.release();
    await settle();

    expect(readsOf(record.log)).toHaveLength(READS_RUNNING + 3);
    expect(gapsOf(record.log)).toEqual([
      ['agent', { type: 'service-account', id: 'agent' }, 'read', 5],
      ['other', { type: 'service-account', id: 'other' }, 'read', 2],
    ]);
    // The held ones, then the gaps (a transaction of their own) and the 3 waiting.
    expect(record.calls).toBe(READS_RUNNING + 2);
    expect(middleware.pending()).toBe(0);
  });

  it('records the rest of a batch one malformed read failed, and counts only that read in its gap', async () => {
    const record = new HeldRecordRead();
    const middleware = new ReadAuditMiddleware(record);
    // Held: the first READS_RUNNING go alone, the next ones wait as one batch.
    for (let i = 0; i < READS_RUNNING; i++) read(middleware);
    read(middleware, agent, '/a');
    read(middleware, agent, '/bad');
    read(middleware, agent, '/b');
    record.fails = (reads) => reads.some((r) => r.path === '/bad');
    record.release();
    await settle();

    expect(readsOf(record.log).sort()).toEqual(
      ['/a', '/b', ...Array<string>(READS_RUNNING).fill('/me')].sort(),
    );
    expect(gapsOf(record.log)).toEqual([
      ['agent', { type: 'service-account', id: 'agent' }, 'read', 1],
    ]);
  });

  it('keeps gaps counted while the database fails, and records their sum once it answers again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const record = new HeldRecordRead();
    record.holding = false;
    let down = true;
    record.fails = () => down;
    const middleware = new ReadAuditMiddleware(record);

    read(middleware); // fails alone: a gap of 1, whose recording fails too
    await vi.advanceTimersByTimeAsync(0);
    const tried = record.calls;
    read(middleware); // waits: no try while the database is down
    await vi.advanceTimersByTimeAsync(0);
    expect(record.calls).toBe(tried);
    expect(middleware.pending()).toBe(2);

    down = false;
    await vi.advanceTimersByTimeAsync(READS_RETRY_MS);
    expect(gapsOf(record.log)).toEqual([
      ['agent', { type: 'service-account', id: 'agent' }, 'read', 1],
    ]);
    expect(readsOf(record.log)).toEqual(['/me']);
    expect(middleware.pending()).toBe(0);
  });

  it('records what waits or retries before shutting down, without waiting out the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const record = new HeldRecordRead();
    record.holding = false;
    let down = true;
    record.fails = () => down;
    const middleware = new ReadAuditMiddleware(record);
    read(middleware);
    await vi.advanceTimersByTimeAsync(0);
    expect(middleware.pending()).toBe(1);

    down = false;
    const shutdown = middleware.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(100);
    await shutdown;
    expect(gapsOf(record.log)).toEqual([
      ['agent', { type: 'service-account', id: 'agent' }, 'read', 1],
    ]);
    // Stopped: a read the closing server still answers is only counted, and logged at the end.
    const calls = record.calls;
    const error = vi
      .spyOn(
        (middleware as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    read(middleware);
    expect(record.calls).toBe(calls);
    middleware.onApplicationShutdown();
    expect(error).toHaveBeenLastCalledWith(
      'Shutting down with 1 service account reads not recorded (TypeError).',
    );
  });

  it('logs the count left when the database stays gone through shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const record = new HeldRecordRead();
    record.holding = false;
    record.fails = () => true;
    const middleware = new ReadAuditMiddleware(record);
    const error = vi
      .spyOn(
        (middleware as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    read(middleware);
    read(middleware);
    const shutdown = middleware.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(6_000);
    await shutdown;
    middleware.onApplicationShutdown();
    expect(error).toHaveBeenLastCalledWith(
      'Shutting down with 2 service account reads not recorded (TypeError).',
    );
  });

  it('records a ref cut through a surrogate pair as well-formed text', async () => {
    const record = new HeldRecordRead();
    record.holding = false;
    const middleware = new ReadAuditMiddleware(record);
    read(middleware, agent, '/me', { ref: `${'a'.repeat(199)}😀` });
    await settle();
    const ref = record.log.events[0]!.data['ref'] as string;
    expect(ref).toHaveLength(200);
    expect(ref.isWellFormed()).toBe(true);
  });

  it('waits out a database gone after the first failed read, not one try per read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const record = new HeldRecordRead();
    const middleware = new ReadAuditMiddleware(record);
    // Held: READS_RUNNING alone, then 50 waiting as one batch.
    for (let i = 0; i < READS_RUNNING + 50; i++) read(middleware);
    record.fails = () => true;
    record.release();
    await vi.advanceTimersByTimeAsync(0);
    // The held ones, the batch, one read alone, then the gap: it waits.
    expect(record.calls).toBeLessThanOrEqual(READS_RUNNING + 1 + 4 + 4);
    expect(middleware.pending()).toBe(READS_RUNNING + 50);
  });

  it('records nothing for a request no service account token authenticated, or a change', async () => {
    const record = new HeldRecordRead();
    record.holding = false;
    const middleware = new ReadAuditMiddleware(record);
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: true,
      getHeader: () => undefined,
    }) as unknown as Response;
    middleware.use(
      {
        method: 'GET',
        actor: agent,
        query: {},
        headers: {},
      } as unknown as Request,
      res,
      () => undefined,
    );
    middleware.use(
      {
        method: 'POST',
        actor: agent,
        serviceTokenId: '0123456789abcdef',
        query: {},
        headers: {},
      } as unknown as Request,
      res,
      () => undefined,
    );
    res.emit('close');
    await settle();
    expect(record.calls).toBe(0);
  });
});
