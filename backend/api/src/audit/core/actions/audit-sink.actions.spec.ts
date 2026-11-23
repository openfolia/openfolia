import {
  FakeAuditLog,
  FakeAuditSink,
  FakeAuditSinkCursor,
  fakePosition,
} from '../../../../tests/fakes/fake-audit-log.js';
import type { AuditEvent } from '../audit-event.js';
import {
  type AuditSettings,
  SINK_BATCH,
  SINK_BATCH_BYTES,
  SINK_START,
} from '../audit-sink.js';
import {
  PRUNE_BATCH,
  PRUNE_CALLS,
  PruneAuditLogAction,
} from './prune-audit-log.action.js';
import { SendToAuditSinkAction } from './send-to-audit-sink.action.js';

const DAY = 24 * 60 * 60 * 1000;

const event = (id: number, at = new Date()): AuditEvent => ({
  id: String(id),
  at,
  actor: { kind: 'user', id: 'ada' },
  action: 'role.update',
  subject: { type: 'role', id: `r${id}` },
  comment: null,
  data: {},
});
const events = (n: number, at?: Date) =>
  Array.from({ length: n }, (_, i) => event(i + 1, at));

const pass = { holder: 'one', leaseMs: 60_000, deadline: Date.now() + 60_000 };

describe('SendToAuditSinkAction', () => {
  it('sends every event in order, in batches, and moves the cursor past each', async () => {
    const log = new FakeAuditLog(events(SINK_BATCH + 5));
    const cursor = new FakeAuditSinkCursor(log);
    const sink = new FakeAuditSink();

    const report = await new SendToAuditSinkAction(sink, cursor).handle(pass);

    expect(report).toEqual({ sent: SINK_BATCH + 5 });
    expect(sink.batches.map((b) => b.length)).toEqual([SINK_BATCH, 5]);
    expect(sink.delivered.map((e) => e.id)).toEqual(
      log.events.map((e) => e.id),
    );
    expect(cursor.cursor).toEqual(fakePosition(log.events.at(-1)!));
    // Nothing new: nothing sent.
    expect(await new SendToAuditSinkAction(sink, cursor).handle(pass)).toEqual({
      sent: 0,
    });
  });

  it('keeps the cursor on a failed delivery and sends the same batch again next time', async () => {
    const log = new FakeAuditLog(events(3));
    const cursor = new FakeAuditSinkCursor(log);
    const sink = new FakeAuditSink();
    sink.results.push({ ok: false, error: 'http-status', statusCode: 503 });
    const action = new SendToAuditSinkAction(sink, cursor);

    expect(await action.handle(pass)).toEqual({
      sent: 0,
      stopped: {
        reason: 'failed',
        result: { ok: false, error: 'http-status', statusCode: 503 },
      },
    });
    expect(cursor.cursor).toEqual(SINK_START);

    expect(await action.handle(pass)).toEqual({ sent: 3 });
    expect(sink.delivered.map((e) => e.id)).toEqual(['1', '2', '3']);
  });

  it('sends nothing while another holder has the lease', async () => {
    const log = new FakeAuditLog(events(2));
    const cursor = new FakeAuditSinkCursor(log);
    await cursor.claim('other', 60_000);
    const sink = new FakeAuditSink();
    expect(await new SendToAuditSinkAction(sink, cursor).handle(pass)).toEqual({
      sent: 0,
      stopped: { reason: 'leased' },
    });
    expect(sink.batches).toEqual([]);
  });

  it('keeps a batch within SINK_BATCH_BYTES, a large event going alone', async () => {
    const big = (id: number): AuditEvent => ({
      ...event(id),
      data: { text: 'x'.repeat(SINK_BATCH_BYTES / 2) },
    });
    const log = new FakeAuditLog([big(1), big(2), big(3), event(4)]);
    const cursor = new FakeAuditSinkCursor(log);
    const sink = new FakeAuditSink();
    expect(await new SendToAuditSinkAction(sink, cursor).handle(pass)).toEqual({
      sent: 4,
    });
    expect(sink.batches.map((b) => b.map((e) => e.id))).toEqual([
      ['1'],
      ['2'],
      ['3', '4'],
    ]);
  });

  it('sends nothing while the cursor lies ahead of the database (restored), and says so', async () => {
    const log = new FakeAuditLog(events(2));
    const cursor = new FakeAuditSinkCursor(log);
    cursor.ahead = true;
    const sink = new FakeAuditSink();
    expect(await new SendToAuditSinkAction(sink, cursor).handle(pass)).toEqual({
      sent: 0,
      stopped: { reason: 'cursor-ahead' },
    });
    expect(sink.batches).toEqual([]);
  });

  it('stops at the deadline, the rest left for the next pass', async () => {
    const log = new FakeAuditLog(events(SINK_BATCH * 3));
    const cursor = new FakeAuditSinkCursor(log);
    const sink = new FakeAuditSink();
    const action = new SendToAuditSinkAction(sink, cursor);
    let calls = 0;
    action.now = () => (calls++ < 2 ? 0 : 10);
    expect(await action.handle({ ...pass, deadline: 5 })).toEqual({
      sent: SINK_BATCH * 2,
    });
  });
});

describe('PruneAuditLogAction', () => {
  const settings = (over: Partial<AuditSettings> = {}): AuditSettings => ({
    sinkEnabled: false,
    keepDays: 30,
    ...over,
  });

  it('removes the events older than the period and records the removal', async () => {
    const old = new Date(Date.now() - 40 * DAY);
    const log = new FakeAuditLog([...events(3, old), event(4)]);
    const action = new PruneAuditLogAction(
      log,
      new FakeAuditSinkCursor(log),
      settings(),
    );

    expect(await action.handle()).toBe(3);
    expect(log.events.map((e) => e.action)).toEqual([
      'role.update',
      'audit-log.prune',
    ]);
    expect(log.events[1]!.data).toMatchObject({
      removed: 3,
      firstId: '1',
      lastId: '3',
    });
  });

  it('removes nothing without a period', async () => {
    const log = new FakeAuditLog(events(2, new Date(0)));
    const action = new PruneAuditLogAction(
      log,
      new FakeAuditSinkCursor(log),
      settings({ keepDays: undefined }),
    );
    expect(await action.handle()).toBe(0);
    expect(log.events).toHaveLength(2);
  });

  it('with a sink, keeps what it has not sent', async () => {
    const log = new FakeAuditLog(events(4, new Date(Date.now() - 40 * DAY)));
    const cursor = new FakeAuditSinkCursor(log);
    cursor.cursor = fakePosition(log.events[1]!);
    const action = new PruneAuditLogAction(
      log,
      cursor,
      settings({ sinkEnabled: true }),
    );
    expect(await action.handle()).toBe(2);
    expect(log.events.map((e) => e.id)).toEqual(['3', '4', '5']);
  });

  it('calls in batches, at most PRUNE_CALLS per run', async () => {
    const log = new FakeAuditLog();
    const prune = vi.spyOn(log, 'prune').mockResolvedValue(PRUNE_BATCH);
    const action = new PruneAuditLogAction(
      log,
      new FakeAuditSinkCursor(log),
      settings(),
    );
    expect(await action.handle()).toBe(PRUNE_BATCH * PRUNE_CALLS);
    expect(prune).toHaveBeenCalledTimes(PRUNE_CALLS);
    prune.mockClear();
    prune.mockResolvedValueOnce(PRUNE_BATCH).mockResolvedValueOnce(7);
    expect(await action.handle()).toBe(PRUNE_BATCH + 7);
    expect(prune).toHaveBeenCalledTimes(2);
  });
});
