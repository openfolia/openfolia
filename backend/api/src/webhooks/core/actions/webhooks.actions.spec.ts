import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import { FakeOutboxFeed } from '../../../../tests/fakes/fake-outbox-feed.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import {
  FakeWebhookOwners,
  FakeWebhookSecrets,
  FakeWebhookSender,
  FakeWebhookStore,
  fakeWebhookSettings,
} from '../../../../tests/fakes/fake-webhooks.js';
import { actorWith, NOBODY } from '../../../../tests/fakes/actors.js';
import { NotFoundError, UnavailableError } from '../../../base/core/errors.js';
import type { OutboxEvent } from '../../../outbox/core/outbox-feed.js';
import { DISABLE_AFTER_FAILURES, type WebhookEvent } from '../webhook.js';
import {
  idempotencyKey,
  type OutgoingEvent,
  type WebhookEventBuilder,
} from '../webhook-events.js';
import { DELIVER_WEBHOOK } from '../webhook-job.js';
import type { WebhookSettings } from '../webhook-ports.js';
import { verifyWebhookSignature } from '../webhook-signature.js';
import {
  DeliverWebhookAction,
  DeliveryAttemptFailed,
  DeliveryDeferred,
  FailWebhookDeliveryAction,
  MAX_DEFERRALS,
  MAX_PUT_OFF_MS,
  waitAfter,
} from './deliver-webhook.action.js';
import { FanOutWebhooksAction } from './fan-out-webhooks.action.js';
import {
  CreateWebhookAction,
  DeleteWebhookAction,
  GetWebhookAction,
  ListWebhookDeliveriesAction,
  ListWebhooksAction,
  RotateWebhookSecretAction,
  seesPayload,
  UpdateWebhookAction,
} from './manage-webhooks.action.js';
import { PruneWebhookDeliveriesAction } from './prune-webhook-deliveries.action.js';
import {
  RetryWebhookDeliveryAction,
  TestWebhookAction,
} from './test-webhook.action.js';

const manager = {
  ...actorWith(['webhook.manage', 'content.read']),
  id: 'manager',
};

function setup(settings: WebhookSettings = fakeWebhookSettings()) {
  const store = new FakeWebhookStore();
  const secrets = new FakeWebhookSecrets();
  const sender = new FakeWebhookSender();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const feed = new FakeOutboxFeed();
  const jobs = new FakeJobQueue();
  const owners = new FakeWebhookOwners().add(manager);
  const made: OutgoingEvent[] = [];
  let failWith: Error | undefined;
  let refuseFor: string | undefined;
  const audiences: (string | null)[] = [];
  const builder = {
    of: async (
      event: OutboxEvent,
      owner: { id: string },
      wanted: ReadonlySet<WebhookEvent>,
      maxAudience: string | null = null,
    ) => {
      audiences.push(maxAudience);
      if (failWith) throw failWith;
      if (owner.id === refuseFor)
        throw new NotFoundError('No such previous release.');
      if (event.topic === 'bad') return undefined;
      if (event.topic !== 'release.withdrawn') return [];
      const e: OutgoingEvent = {
        type: 'release.withdrawn',
        idempotencyKey: idempotencyKey(
          'release.withdrawn',
          String(event.payload['releaseId']),
        ),
        data: { releaseId: event.payload['releaseId'] },
      };
      made.push(e);
      return wanted.has(e.type) ? [e] : [];
    },
  } as unknown as WebhookEventBuilder;
  const create = new CreateWebhookAction(store, secrets, settings, audit, unit);
  const deliver = new DeliverWebhookAction(
    store,
    secrets,
    sender,
    settings,
    audit,
    unit,
    owners,
    jobs,
  );
  return {
    store,
    secrets,
    sender,
    audit,
    feed,
    jobs,
    owners,
    unit,
    create,
    deliver,
    audiences,
    test: new TestWebhookAction(store, settings, deliver, audit, unit),
    retry: new RetryWebhookDeliveryAction(store, settings, jobs, audit, unit),
    fail: (error: Error | undefined) => {
      failWith = error;
    },
    refuseFor: (ownerId: string) => {
      refuseFor = ownerId;
    },
    get: new GetWebhookAction(store),
    list: new ListWebhooksAction(store),
    update: new UpdateWebhookAction(store, secrets, settings, audit, unit),
    remove: new DeleteWebhookAction(store, audit, unit),
    rotate: new RotateWebhookSecretAction(
      store,
      secrets,
      settings,
      audit,
      unit,
    ),
    deliveries: new ListWebhookDeliveriesAction(store),
    failDelivery: new FailWebhookDeliveryAction(store, deliver, unit),
    fanOut: new FanOutWebhooksAction(
      feed,
      builder,
      store,
      owners,
      jobs,
      settings,
      unit,
    ),
    prune: new PruneWebhookDeliveriesAction(store),
  };
}

const subscribe = (
  s: ReturnType<typeof setup>,
  events: WebhookEvent[] = ['release.withdrawn'],
) =>
  s.create.handle({
    actor: manager,
    url: 'https://receiver.example/hook',
    events,
    description: null,
  });

describe('managing webhooks', () => {
  it('needs webhook.manage', async () => {
    const s = setup();
    await expect(
      s.create.handle({
        actor: NOBODY,
        url: 'https://receiver.example/',
        events: ['manual.released'],
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.store.webhooks.size).toBe(0);
  });

  it('makes a subscriber owned by its maker, answers the secret once and stores it only sealed', async () => {
    const s = setup();
    const { webhook, secret } = await subscribe(s, [
      'module.released',
      'manual.released',
      'module.released',
    ]);
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(webhook).toMatchObject({
      url: 'https://receiver.example/hook',
      events: ['manual.released', 'module.released'],
      active: true,
      owner: { kind: 'user', id: 'manager' },
    });
    expect(JSON.stringify(webhook)).not.toContain(secret.slice(6));
    expect(s.store.webhooks.get(webhook.id)?.secrets.current).toBe(
      `sealed:${webhook.id}:${secret}`,
    );
    expect(s.audit.events).toMatchObject([
      {
        action: 'webhook.create',
        subject: { type: 'webhook', id: webhook.id },
        data: {
          host: 'receiver.example',
          events: ['manual.released', 'module.released'],
        },
      },
    ]);
    expect(JSON.stringify(s.audit.events)).not.toContain(secret.slice(6));
  });

  it('refuses URLs deliveries may not go to', async () => {
    const s = setup();
    for (const [url, problem] of [
      ['http://receiver.example/', 'scheme'],
      ['https://169.254.169.254/', 'blocked-address'],
      ['https://u:p@receiver.example/', 'credentials'],
    ]) {
      await expect(
        s.create.handle({
          actor: manager,
          url: url!,
          events: ['manual.released'],
          description: null,
        }),
      ).rejects.toMatchObject({ code: 'invalid-url', meta: { problem } });
    }
    expect(s.store.webhooks.size).toBe(0);
  });

  it('is off without a key', async () => {
    const s = setup(fakeWebhookSettings({ enabled: false }));
    await expect(subscribe(s)).rejects.toMatchObject({
      code: 'not-configured',
    });
  });

  it('keeps the audit log free of the URL’s path and query', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { url: 'https://other.example/hook?token=abc' },
    });
    expect(JSON.stringify(s.audit.events)).not.toContain('token=abc');
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'webhook.update',
      data: { fields: ['url'], host: 'other.example' },
    });
  });

  it('shows a subscriber only to its owner or a reader covering any owner’s; to anyone else it does not exist', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    const scoped = {
      ...actorWith(['webhook.manage', 'content.read'], {
        maxAudience: 'public',
      }),
      id: 'scoped',
    };
    s.owners.add(scoped);
    const own = await s.create.handle({
      actor: scoped,
      url: 'https://scoped.example/a',
      events: ['release.withdrawn'],
      description: null,
    });
    const page = { number: 1, size: 10 };
    expect(
      (await s.list.handle({ actor: scoped, page })).items.map((w) => w.id),
    ).toEqual([own.webhook.id]);
    expect(
      (await s.list.handle({ actor: manager, page })).items.map((w) => w.id),
    ).toEqual([webhook.id, own.webhook.id]);
    for (const attempt of [
      () => s.get.handle({ actor: scoped, id: webhook.id }),
      () =>
        s.update.handle({
          actor: scoped,
          id: webhook.id,
          changes: { active: false },
        }),
      () => s.rotate.handle({ actor: scoped, id: webhook.id }),
      () => s.remove.handle({ actor: scoped, id: webhook.id }),
      () =>
        s.deliveries.handle({
          actor: scoped,
          id: webhook.id,
          filter: {},
          page,
        }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'not-found' });
    }
  });

  it('hands a subscriber to whoever points it at another URL; same values, a description or other events keep the owner', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    const everywhere = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'everywhere',
    };
    for (const changes of [
      { url: 'https://receiver.example/hook', events: ['release.withdrawn'] },
      { description: 'Only a note.' },
      { events: ['release.withdrawn', 'manual.released'] },
    ] as const) {
      const kept = await s.update.handle({
        actor: everywhere,
        id: webhook.id,
        changes: { ...changes, events: changes.events && [...changes.events] },
      });
      expect(kept.owner).toEqual({ kind: 'user', id: 'manager' });
      expect(s.audit.events.at(-1)?.data).not.toHaveProperty('owner');
    }
    const moved = await s.update.handle({
      actor: everywhere,
      id: webhook.id,
      changes: { url: 'https://other.example/' },
    });
    expect(moved.owner).toEqual({ kind: 'user', id: 'everywhere' });
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      owner: { kind: 'user', id: 'everywhere' },
      skipped: 0,
    });
    // Its owner may point it anywhere, whatever their scope.
    const scoped = {
      ...actorWith(['webhook.manage', 'content.read'], {
        maxAudience: 'public',
      }),
      id: 'scoped',
    };
    s.owners.add(scoped);
    const own = await s.create.handle({
      actor: scoped,
      url: 'https://scoped.example/a',
      events: ['release.withdrawn'],
      description: null,
    });
    const elsewhere = await s.update.handle({
      actor: scoped,
      id: own.webhook.id,
      changes: { url: 'https://scoped.example/b' },
    });
    expect(elsewhere.owner).toEqual({ kind: 'user', id: 'scoped' });
  });

  it('lets someone else change the URL or the events only when they cover the old and the new events', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    // Reads everything released, but no drafts: sees this subscriber.
    const reader = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'reader',
    };
    await expect(
      s.update.handle({
        actor: reader,
        id: webhook.id,
        changes: { events: ['release.withdrawn', 'translation.imported'] },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      s.update.handle({
        actor: reader,
        id: webhook.id,
        changes: {
          url: 'https://other.example/',
          events: ['translation.imported'],
        },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const translator = {
      ...actorWith([
        'webhook.manage',
        'content.read',
        'content.read.draft',
        'translation.manage',
      ]),
      id: 'translator',
    };
    const reshaped = await s.update.handle({
      actor: translator,
      id: webhook.id,
      changes: { events: ['translation.imported'] },
    });
    expect(reshaped.owner).toEqual({ kind: 'user', id: 'manager' });
    // Now an import subscriber: the reader no longer sees it.
    await expect(
      s.get.handle({ actor: reader, id: webhook.id }),
    ).rejects.toMatchObject({ code: 'not-found' });
    const moved = await s.update.handle({
      actor: translator,
      id: webhook.id,
      changes: { url: 'https://other.example/' },
    });
    expect(moved.owner).toEqual({ kind: 'user', id: 'translator' });
  });

  it('pauses and resumes, clearing a disabled state', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    const paused = await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { active: false },
    });
    expect(paused.active).toBe(false);
    const stored = s.store.webhooks.get(webhook.id)!;
    s.store.webhooks.set(webhook.id, {
      ...stored,
      disabledReason: 'failing',
      disabledAt: new Date(),
      consecutiveFailures: 5,
    });
    const resumed = await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { active: true },
    });
    expect(resumed).toMatchObject({
      active: true,
      disabledReason: null,
      consecutiveFailures: 0,
    });
  });

  it('rotates the secret, keeping the previous one signing for a day', async () => {
    const s = setup();
    const { webhook, secret: first } = await subscribe(s);
    s.rotate.now = () => Date.parse('2026-01-01T00:00:00Z');
    const { webhook: rotated, secret } = await s.rotate.handle({
      actor: manager,
      id: webhook.id,
    });
    expect(secret).not.toBe(first);
    expect(rotated.previousSecretUntil?.toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(s.store.webhooks.get(webhook.id)?.secrets).toEqual({
      current: `sealed:${webhook.id}:${secret}`,
      previous: `sealed:${webhook.id}:${first}`,
    });
    expect(s.audit.events.at(-1)?.action).toBe('webhook.rotate-secret');
  });

  it('lets only the owner, or a manager covering any owner of any subscriber, rotate the secret', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    // Sees it (it is sent nothing about drafts), yet may not hold its secret.
    const reader = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'reader',
    };
    await expect(
      s.rotate.handle({ actor: reader, id: webhook.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const everything = {
      ...actorWith([
        'webhook.manage',
        'content.read',
        'content.read.draft',
        'translation.manage',
      ]),
      id: 'everything',
    };
    for (const actor of [manager, everything]) {
      const { secret } = await s.rotate.handle({ actor, id: webhook.id });
      expect(secret).toMatch(/^whsec_/);
    }
  });

  it('is 404 for an unknown or malformed ID', async () => {
    const s = setup();
    for (const id of ['nope', '00000000-0000-7000-8000-000000000000']) {
      await expect(s.get.handle({ actor: manager, id })).rejects.toMatchObject({
        code: 'not-found',
      });
      await expect(
        s.remove.handle({ actor: manager, id }),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
  });
});

describe('making deliveries from the outbox', () => {
  it('makes one delivery per event and subscriber, with its job, once however often the row is read', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    s.feed.add('change-set.submit', { changeSetId: 'c' });
    const report = await s.fanOut.handle();
    expect(report).toMatchObject({ events: 2, deliveries: 1 });
    const [delivery] = s.store.deliveries.values();
    expect(delivery).toMatchObject({
      webhookId: webhook.id,
      event: 'release.withdrawn',
      status: 'pending',
    });
    expect(JSON.parse(delivery!.body)).toMatchObject({
      type: 'release.withdrawn',
      idempotencyKey: delivery!.idempotencyKey,
      data: { releaseId: 'r1' },
    });
    expect(s.jobs.jobs).toMatchObject([
      {
        queue: DELIVER_WEBHOOK.name,
        key: delivery!.id,
        payload: { deliveryId: delivery!.id },
      },
    ]);
    // The same row again (a restart before the cursor moved): nothing new.
    s.feed.cursors.clear();
    expect(await s.fanOut.handle()).toMatchObject({ deliveries: 0 });
    expect(s.store.deliveries.size).toBe(1);
  });

  it('makes nothing while the outbox holds it after a restore, and everything once it goes on (#619)', async () => {
    const s = setup();
    await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    s.feed.held.add('webhooks');
    expect(await s.fanOut.handle()).toMatchObject({
      blocked: true,
      events: 0,
      deliveries: 0,
    });
    expect(s.feed.cursors.size).toBe(0);
    s.feed.held.clear();
    expect(await s.fanOut.handle()).toMatchObject({
      blocked: false,
      events: 1,
      deliveries: 1,
    });
  });

  it('tells nobody of an event from before the subscriber, nor one whose owner no longer acts', async () => {
    const s = setup();
    s.feed
      .add('release.withdrawn', { releaseId: 'early' })
      .createdAt.setTime(Date.now() - 60_000);
    const { webhook } = await subscribe(s);
    s.owners.actors.clear();
    s.feed.add('release.withdrawn', { releaseId: 'r2' });
    await s.fanOut.handle();
    expect(s.store.deliveries.size).toBe(0);
    expect(webhook.active).toBe(true);
  });

  it('passes over a row whose payload is wrong; tries an outage again', async () => {
    const s = setup();
    await subscribe(s);
    s.feed.add('bad', {});
    const skipped = await s.fanOut.handle();
    expect(skipped.skipped).toMatchObject([{ reason: 'payload' }]);
    s.feed.add('release.withdrawn', { releaseId: 'r3' });
    s.fail(new UnavailableError('git-unavailable', 'Git is down.', 1));
    const retried = await s.fanOut.handle();
    expect(retried.retry).toBeDefined();
    expect(retried.events).toBe(0);
    s.fail(undefined);
    expect(await s.fanOut.handle()).toMatchObject({ events: 1, deliveries: 1 });
  });

  it('passes over only the subscriber whose owner’s reading is refused; the others still hear of it', async () => {
    const s = setup();
    const { webhook: refused } = await subscribe(s);
    const other = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'other',
    };
    s.owners.add(other);
    const { webhook: heard } = await s.create.handle({
      actor: other,
      url: 'https://other.example/hook',
      events: ['release.withdrawn'],
      description: null,
    });
    s.refuseFor('manager');
    s.feed.add('release.withdrawn', { releaseId: 'r' });
    const report = await s.fanOut.handle();
    expect(report).toMatchObject({ events: 1, deliveries: 1 });
    expect(report.skipped).toMatchObject([
      { reason: 'refused', webhookId: refused.id },
    ]);
    expect([...s.store.deliveries.values()].map((d) => d.webhookId)).toEqual([
      heard.id,
    ]);
  });

  it('does nothing while webhooks are off', async () => {
    const s = setup(fakeWebhookSettings({ enabled: false }));
    s.feed.add('release.withdrawn', { releaseId: 'r' });
    expect(await s.fanOut.handle()).toMatchObject({ events: 0 });
    expect(s.feed.cursors.size).toBe(0);
  });
});

describe('delivering', () => {
  async function pending(s: ReturnType<typeof setup>) {
    const made = await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const [delivery] = s.store.deliveries.values();
    return { ...made, delivery: delivery! };
  }

  it('signs the stored body so the receiver’s recipe verifies it, with the idempotency key and delivery ID', async () => {
    const s = setup();
    const { secret, delivery } = await pending(s);
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false }),
    ).toBe('succeeded');
    const [request] = s.sender.sent;
    expect(request?.body).toBe(delivery.body);
    expect(request?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Ccms-Delivery': delivery.id,
      'X-Ccms-Event': 'release.withdrawn',
      'Idempotency-Key': delivery.idempotencyKey,
    });
    expect(
      verifyWebhookSignature(
        request!.headers['X-Ccms-Signature']!,
        request!.body,
        secret,
      ),
    ).toBe(true);
    expect(s.store.deliveries.get(delivery.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      lastStatusCode: 200,
    });
  });

  it('never sends again after a success', async () => {
    const s = setup();
    const { delivery } = await pending(s);
    await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false });
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false }),
    ).toBe('settled');
    expect(s.sender.sent).toHaveLength(1);
  });

  it('retries a failure (the job’s retry), recording each attempt, and fails it on the last', async () => {
    const s = setup();
    const { delivery } = await pending(s);
    s.sender.answer = () => ({
      ok: false,
      error: 'http-status',
      statusCode: 503,
    });
    const attempt = s.deliver.handle({
      deliveryId: delivery.id,
      lastAttempt: false,
    });
    await expect(attempt).rejects.toBeInstanceOf(DeliveryAttemptFailed);
    await expect(attempt).rejects.toThrow(
      `Delivery ${delivery.id} failed (http-status 503); retried.`,
    );
    expect(s.store.deliveries.get(delivery.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'http-status',
      lastStatusCode: 503,
    });
    s.sender.answer = () => ({ ok: true, statusCode: 204 });
    // Past the wait after a failure.
    s.store.now = () => Date.now() + waitAfter(1) + 1;
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false }),
    ).toBe('succeeded');
    expect(s.store.deliveries.get(delivery.id)?.attempts).toBe(2);
  });

  it('makes one attempt at a time per subscriber and a few per owner, waits after a failure, and puts the rest off without spending an attempt', async () => {
    const s = setup();
    const hooks = [];
    for (let i = 0; i < 3; i++) {
      hooks.push(
        (
          await s.create.handle({
            actor: manager,
            url: `https://receiver${i}.example/hook`,
            events: ['release.withdrawn'],
            description: null,
          })
        ).webhook,
      );
    }
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    s.feed.add('release.withdrawn', { releaseId: 'r2' });
    await s.fanOut.handle();
    const of = (id: string) =>
      [...s.store.deliveries.values()].filter((d) => d.webhookId === id);
    const [a1, a2] = of(hooks[0]!.id);
    const [b1] = of(hooks[1]!.id);
    const [c1] = of(hooks[2]!.id);
    // Receivers that hang until released.
    const waiting: (() => void)[] = [];
    const send = s.sender.send.bind(s.sender);
    s.sender.send = async (request) => {
      s.sender.sent.push(request);
      await new Promise<void>((resolve) => waiting.push(resolve));
      return { ok: true, statusCode: 200 };
    };
    const first = s.deliver.handle({ deliveryId: a1!.id, lastAttempt: false });
    const second = s.deliver.handle({
      deliveryId: b1!.id,
      lastAttempt: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.jobs.jobs.length = 0;
    // The same subscriber, and a third of the same owner: put off.
    for (const d of [a2!, c1!]) {
      expect(
        await s.deliver.handle({ deliveryId: d.id, lastAttempt: false }),
      ).toBe('deferred');
    }
    expect(s.jobs.jobs).toMatchObject([
      { payload: { deliveryId: a2!.id, deferrals: 1 } },
      { payload: { deliveryId: c1!.id, deferrals: 1 } },
    ]);
    expect(s.store.deliveries.get(a2!.id)?.attempts).toBe(0);
    expect(s.sender.sent).toHaveLength(2);
    for (const release of waiting) release();
    expect(await first).toBe('succeeded');
    expect(await second).toBe('succeeded');
    s.sender.send = send;
    // Claims let go: the next goes.
    expect(
      await s.deliver.handle({
        deliveryId: a2!.id,
        deferrals: 1,
        lastAttempt: false,
      }),
    ).toBe('succeeded');
  });

  it('waits after an attempt failed at the receiver, then tries again', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    s.feed.add('release.withdrawn', { releaseId: 'r2' });
    await s.fanOut.handle();
    const [a, b] = [...s.store.deliveries.values()];
    s.sender.answer = () => ({ ok: false, error: 'timeout', statusCode: null });
    await expect(
      s.deliver.handle({ deliveryId: a!.id, lastAttempt: false }),
    ).rejects.toBeInstanceOf(DeliveryAttemptFailed);
    expect(s.store.webhooks.get(webhook.id)?.attemptFailures).toBe(1);
    s.jobs.jobs.length = 0;
    expect(
      await s.deliver.handle({ deliveryId: b!.id, lastAttempt: true }),
    ).toBe('deferred');
    // Put off to the end of the wait, on its last attempt too: not failed.
    expect(s.store.deliveries.get(b!.id)?.status).toBe('pending');
    const [job] = s.jobs.jobs;
    expect(job?.payload).toEqual({ deliveryId: b!.id, deferrals: 1 });
    s.store.now = () => Date.now() + waitAfter(1) + 1;
    s.sender.answer = () => ({ ok: true, statusCode: 200 });
    expect(
      await s.deliver.handle({
        deliveryId: b!.id,
        deferrals: 1,
        lastAttempt: false,
      }),
    ).toBe('succeeded');
    expect(s.store.webhooks.get(webhook.id)?.attemptFailures).toBe(0);
  });

  it('starts one job chain for a put-off however often its job runs, backing off, and spends attempts once the delivery is old', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const [d] = [...s.store.deliveries.values()];
    const w = s.store.webhooks.get(webhook.id)!;
    s.store.webhooks.set(webhook.id, {
      ...w,
      sendingUntil: new Date(Date.now() + 60_000),
    });
    s.deliver.jitter = () => 0;
    s.jobs.jobs.length = 0;
    for (let run = 0; run < 2; run++) {
      expect(
        await s.deliver.handle({ deliveryId: d!.id, lastAttempt: false }),
      ).toBe('deferred');
    }
    expect(s.jobs.jobs).toHaveLength(1);
    const later = await s.deliver.handle({
      deliveryId: d!.id,
      deferrals: 1,
      lastAttempt: false,
    });
    expect(later).toBe('deferred');
    expect(s.jobs.jobs.map((j) => j.payload)).toEqual([
      { deliveryId: d!.id, deferrals: 1 },
      { deliveryId: d!.id, deferrals: 2 },
    ]);
    s.deliver.now = () => d!.createdAt.getTime() + MAX_PUT_OFF_MS + 1;
    await expect(
      s.deliver.handle({ deliveryId: d!.id, deferrals: 2, lastAttempt: false }),
    ).rejects.toBeInstanceOf(DeliveryDeferred);
  });

  it('spends an attempt on a delivery put off too often', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const [d] = [...s.store.deliveries.values()];
    const w = s.store.webhooks.get(webhook.id)!;
    s.store.webhooks.set(webhook.id, {
      ...w,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    await expect(
      s.deliver.handle({
        deliveryId: d!.id,
        deferrals: MAX_DEFERRALS,
        lastAttempt: false,
      }),
    ).rejects.toBeInstanceOf(DeliveryDeferred);
  });

  it('skips a delivery whose owner no longer manages webhooks or no longer acts', async () => {
    const s = setup();
    const { delivery } = await pending(s);
    s.owners.add({ ...actorWith(['content.read']), id: 'manager' });
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false }),
    ).toBe('skipped');
    expect(s.sender.sent).toHaveLength(0);
    s.feed.add('release.withdrawn', { releaseId: 'r2' });
    expect(await s.fanOut.handle()).toMatchObject({ deliveries: 0 });
    s.owners.actors.clear();
    expect(await s.fanOut.handle()).toMatchObject({ deliveries: 0 });
  });

  it('fails at once for a refused address, and disables a subscriber failing again and again (audited)', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    s.sender.answer = () => ({
      ok: false,
      error: 'blocked-address',
      statusCode: null,
    });
    for (let i = 0; i < DISABLE_AFTER_FAILURES; i++) {
      s.feed.add('release.withdrawn', { releaseId: `r${i}` });
    }
    await s.fanOut.handle();
    for (const d of [...s.store.deliveries.values()]) {
      expect(
        await s.deliver.handle({ deliveryId: d.id, lastAttempt: false }),
      ).toBe('failed');
    }
    expect(s.store.webhooks.get(webhook.id)).toMatchObject({
      active: false,
      disabledReason: 'failing',
      consecutiveFailures: DISABLE_AFTER_FAILURES,
    });
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'webhook.disable',
      actor: { kind: 'service', id: 'service:webhooks' },
      data: { reason: 'failing' },
    });
  });

  it('skips a delivery of a paused subscriber, and one it no longer subscribes to', async () => {
    const s = setup();
    const { webhook, delivery } = await pending(s);
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { active: false },
    });
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false }),
    ).toBe('skipped');
    expect(s.sender.sent).toHaveLength(0);
    expect(s.store.deliveries.get(delivery.id)?.status).toBe('skipped');
  });

  it('never sends a delivery made for an earlier owner: a takeover skips those pending, and one made meanwhile is skipped when due', async () => {
    const s = setup();
    const { webhook, delivery } = await pending(s);
    const everywhere = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'everywhere',
    };
    s.owners.add(everywhere);
    // Made for the old owner while the takeover ran (the fan-out read the
    // subscriber before it).
    const unit = s.unit;
    await s.update.handle({
      actor: everywhere,
      id: webhook.id,
      changes: { url: 'https://other.example/' },
    });
    expect(s.store.deliveries.get(delivery.id)?.status).toBe('skipped');
    expect(s.audit.events.at(-1)?.data).toMatchObject({ skipped: 1 });
    const [late] = await unit.run((tx) =>
      s.store.addDeliveries(tx, [
        {
          id: '01900000-0000-7000-8000-000000000001',
          webhookId: webhook.id,
          event: 'release.withdrawn',
          idempotencyKey: 'a'.repeat(64),
          body: '{"late":true}',
          owner: { kind: 'user', id: 'manager' },
          maxAudience: null,
          outboxId: 99,
        },
      ]),
    );
    expect(
      await s.deliver.handle({ deliveryId: late!, lastAttempt: false }),
    ).toBe('skipped');
    // What comes after follows the new owner, and is sent.
    s.feed.add('release.withdrawn', { releaseId: 'r2' });
    await s.fanOut.handle();
    const fresh = [...s.store.deliveries.values()].find(
      (d) => d.status === 'pending',
    );
    expect(fresh?.owner).toEqual({ kind: 'user', id: 'everywhere' });
    expect(
      await s.deliver.handle({ deliveryId: fresh!.id, lastAttempt: false }),
    ).toBe('succeeded');
    expect(s.sender.sent.map((r) => r.url)).toEqual(['https://other.example/']);
  });

  it('never counts toward turning a subscriber off what is not the receiver’s fault (a secret that cannot be opened)', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    for (let i = 0; i < DISABLE_AFTER_FAILURES; i++) {
      s.feed.add('release.withdrawn', { releaseId: `r${i}` });
    }
    await s.fanOut.handle();
    s.secrets.broken = true;
    for (const d of [...s.store.deliveries.values()]) {
      expect(
        await s.deliver.handle({ deliveryId: d.id, lastAttempt: false }),
      ).toBe('failed');
    }
    expect(s.store.webhooks.get(webhook.id)).toMatchObject({
      active: true,
      consecutiveFailures: 0,
    });
  });

  it('refuses an http URL once the setting allowing it is off', async () => {
    const s = setup(
      fakeWebhookSettings({ rules: { allowHttp: true, allowPrivate: false } }),
    );
    const { webhook } = await s.create.handle({
      actor: manager,
      url: 'http://receiver.example/',
      events: ['release.withdrawn'],
      description: null,
    });
    s.feed.add('release.withdrawn', { releaseId: 'r' });
    await s.fanOut.handle();
    const strict = new DeliverWebhookAction(
      s.store,
      s.secrets,
      s.sender,
      fakeWebhookSettings(),
      s.audit,
      s.unit,
      s.owners,
      s.jobs,
    );
    const [d] = s.store.deliveries.values();
    expect(await strict.handle({ deliveryId: d!.id, lastAttempt: false })).toBe(
      'failed',
    );
    expect(s.sender.sent).toHaveLength(0);
    expect(s.store.deliveries.get(d!.id)?.lastError).toBe('blocked-url');
    expect(webhook.id).toBeDefined();
  });

  it('signs with both secrets during a rotation’s grace period, then only the new one', async () => {
    const s = setup();
    const { webhook, secret: old, delivery } = await pending(s);
    const { secret } = await s.rotate.handle({
      actor: manager,
      id: webhook.id,
    });
    await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false });
    const header = s.sender.sent[0]!.headers['X-Ccms-Signature']!;
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(verifyWebhookSignature(header, delivery.body, old)).toBe(true);
    expect(verifyWebhookSignature(header, delivery.body, secret)).toBe(true);

    s.feed.add('release.withdrawn', { releaseId: 'later' });
    await s.fanOut.handle();
    const next = [...s.store.deliveries.values()].at(-1)!;
    s.deliver.now = () => Date.now() + 25 * 60 * 60 * 1000;
    await s.deliver.handle({ deliveryId: next.id, lastAttempt: false });
    expect(
      s.sender.sent[1]!.headers['X-Ccms-Signature']!.match(/v1=/g),
    ).toHaveLength(1);
  });

  it('marks a delivery failed for good when its job did (a cut-off last attempt)', async () => {
    const s = setup();
    const { webhook, delivery } = await pending(s);
    await s.failDelivery.handle({ deliveryId: delivery.id });
    await s.failDelivery.handle({ deliveryId: delivery.id });
    expect(s.store.deliveries.get(delivery.id)?.status).toBe('failed');
    expect(s.store.webhooks.get(webhook.id)?.consecutiveFailures).toBe(1);
  });

  it('lists a subscriber’s deliveries, filtered', async () => {
    const s = setup();
    const { webhook } = await pending(s);
    const all = await s.deliveries.handle({
      actor: manager,
      id: webhook.id,
      filter: {},
      page: { number: 1, size: 10 },
    });
    expect(all.total).toBe(1);
    const none = await s.deliveries.handle({
      actor: manager,
      id: webhook.id,
      filter: { status: 'failed' },
      page: { number: 1, size: 10 },
    });
    expect(none.total).toBe(0);
  });

  it('shows a delivery’s body only to the owner it was made for or a reader covering any owner’s; a reader seeing the subscriber may still not see it', async () => {
    const s = setup();
    const { webhook } = await subscribe(s, [
      'release.withdrawn',
      'translation.imported',
    ]);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const page = { number: 1, size: 10 };
    const everywhere = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'everywhere',
    };
    // Not yet: it is sent imports, which `everywhere` may not read.
    await expect(
      s.deliveries.handle({
        actor: everywhere,
        id: webhook.id,
        filter: {},
        page,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    const [own] = (
      await s.deliveries.handle({
        actor: manager,
        id: webhook.id,
        filter: {},
        page,
      })
    ).items;
    expect(own?.body).toContain('release.withdrawn');
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { events: ['release.withdrawn'] },
    });
    const [shown] = (
      await s.deliveries.handle({
        actor: everywhere,
        id: webhook.id,
        filter: {},
        page,
      })
    ).items;
    expect(shown?.body).toContain('release.withdrawn');
    // A body about an import stays hidden from a reader of no drafts.
    await s.unit.run((tx) =>
      s.store.addDeliveries(tx, [
        {
          id: '01900000-0000-7000-8000-000000000002',
          webhookId: webhook.id,
          event: 'translation.imported',
          idempotencyKey: 'b'.repeat(64),
          body: '{"importId":"i"}',
          owner: { kind: 'user', id: 'manager' },
          maxAudience: null,
          outboxId: 98,
        },
      ]),
    );
    const items = (
      await s.deliveries.handle({
        actor: everywhere,
        id: webhook.id,
        filter: { event: 'translation.imported' },
        page,
      })
    ).items;
    expect(items).toMatchObject([{ status: 'pending', body: null }]);
  });

  it('shows an import’s body to another reader only with drafts and translations unrestricted', () => {
    const owner = { kind: 'user', id: 'owner' } as const;
    const drafts = {
      ...actorWith(['webhook.manage', 'content.read', 'content.read.draft']),
      id: 'drafts',
    };
    const translator = {
      ...actorWith([
        'webhook.manage',
        'content.read',
        'content.read.draft',
        'translation.manage',
      ]),
      id: 'translator',
    };
    expect(seesPayload(drafts, owner, 'translation.imported')).toBe(false);
    expect(seesPayload(drafts, owner, 'manual.released')).toBe(true);
    expect(seesPayload(translator, owner, 'translation.imported')).toBe(true);
  });

  it('judges a body by the owner it was made for, not the owner now', async () => {
    const s = setup();
    const { webhook } = await pending(s);
    const page = { number: 1, size: 10 };
    const everywhere = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'everywhere',
    };
    s.owners.add(everywhere);
    await s.update.handle({
      actor: everywhere,
      id: webhook.id,
      changes: { url: 'https://other.example/' },
    });
    s.feed.add('release.withdrawn', { releaseId: 'r2' });
    await s.fanOut.handle();
    // The new owner, their scope narrowed since: their own deliveries show,
    // the old owner's do not.
    const narrowed = {
      ...actorWith(['webhook.manage', 'content.read'], {
        maxAudience: 'public',
      }),
      id: 'everywhere',
    };
    const items = (
      await s.deliveries.handle({
        actor: narrowed,
        id: webhook.id,
        filter: {},
        page,
      })
    ).items;
    expect(
      items.map((d) => [d.owner.id, d.body === null ? 'hidden' : 'shown']),
    ).toEqual([
      ['everywhere', 'shown'],
      ['manager', 'hidden'],
    ]);
    // The old owner, as narrow, no longer sees the subscriber at all.
    await expect(
      s.deliveries.handle({
        actor: { ...narrowed, id: 'manager' },
        id: webhook.id,
        filter: {},
        page,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('prunes settled deliveries past the retention, never pending ones', async () => {
    const s = setup();
    const { delivery } = await pending(s);
    s.prune.now = () => Date.now() + 31 * 24 * 60 * 60 * 1000;
    expect(await s.prune.handle({ keepDays: 30 })).toBe(0);
    await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false });
    expect(await s.prune.handle({ keepDays: 30 })).toBe(1);
  });
});

describe('audience limits (#254)', () => {
  it('stores, changes and removes a subscriber’s audience limit, audited, and hands it to the event builder', async () => {
    const s = setup();
    const { webhook } = await s.create.handle({
      actor: manager,
      url: 'https://receiver.example/hook',
      events: ['release.withdrawn'],
      description: null,
      maxAudience: 'public',
    });
    expect(webhook.maxAudience).toBe('public');
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      maxAudience: 'public',
    });
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    expect(s.audiences).toEqual(['public']);
    const changed = await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { maxAudience: null },
    });
    expect(changed.maxAudience).toBeNull();
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      fields: ['maxAudience'],
      maxAudience: null,
    });
  });

  it('lets someone else change the audience limit only when they cover what it is sent', async () => {
    const s = setup();
    const { webhook } = await subscribe(s, ['translation.imported']);
    // Sees nothing of it: an import subscriber needs drafts and translations.
    const reader = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'reader',
    };
    await expect(
      s.update.handle({
        actor: reader,
        id: webhook.id,
        changes: { maxAudience: 'public' },
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    const { webhook: released } = await subscribe(s);
    const scoped = {
      ...actorWith(['webhook.manage', 'content.read'], {
        maxAudience: 'public',
      }),
      id: 'scoped',
    };
    s.owners.add(scoped);
    // Their own: whatever they like.
    const own = await s.create.handle({
      actor: scoped,
      url: 'https://scoped.example/a',
      events: ['release.withdrawn'],
      description: null,
    });
    expect(
      (
        await s.update.handle({
          actor: scoped,
          id: own.webhook.id,
          changes: { maxAudience: 'public' },
        })
      ).maxAudience,
    ).toBe('public');
    // A wider manager reshapes another's.
    const changed = await s.update.handle({
      actor: reader,
      id: released.id,
      changes: { maxAudience: 'public' },
    });
    expect(changed).toMatchObject({
      maxAudience: 'public',
      owner: { id: 'manager' },
    });
  });
});

describe('test events (#254)', () => {
  it('sends a signed ping at once and answers its delivery, also to a paused subscriber, without touching its counts', async () => {
    const s = setup();
    const { webhook, secret } = await subscribe(s);
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { active: false },
    });
    const delivery = await s.test.handle({ actor: manager, id: webhook.id });
    expect(delivery).toMatchObject({
      webhookId: webhook.id,
      event: 'ping',
      status: 'succeeded',
      attempts: 1,
      lastStatusCode: 200,
    });
    expect(JSON.parse(delivery.body!)).toMatchObject({
      type: 'ping',
      idempotencyKey: delivery.idempotencyKey,
      data: { webhookId: webhook.id },
    });
    const [request] = s.sender.sent;
    expect(request?.headers).toMatchObject({
      'X-Ccms-Event': 'ping',
      'X-Ccms-Delivery': delivery.id,
    });
    expect(
      verifyWebhookSignature(
        request!.headers['X-Ccms-Signature']!,
        request!.body,
        secret,
      ),
    ).toBe(true);
    // Its claim is let go; no job, never sent again.
    expect(s.store.webhooks.get(webhook.id)?.sendingUntil).toBeNull();
    expect(s.jobs.jobs).toHaveLength(0);
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false }),
    ).toBe('settled');
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'webhook.test',
      subject: { type: 'webhook', id: webhook.id },
      data: { deliveryId: delivery.id },
    });
    // The list and a read show the latest delivery's result, never its body.
    const [listed] = (
      await s.list.handle({ actor: manager, page: { number: 1, size: 10 } })
    ).items;
    expect(listed?.lastDelivery).toMatchObject({
      id: delivery.id,
      event: 'ping',
      status: 'succeeded',
      lastStatusCode: 200,
    });
    expect(listed?.lastDelivery).not.toHaveProperty('body');
    expect(
      (await s.get.handle({ actor: manager, id: webhook.id })).lastDelivery?.id,
    ).toBe(delivery.id);
  });

  it('records a failed ping once, makes the next attempt wait, never counts it toward disabling, and is 429 while the receiver waits', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    s.sender.answer = () => ({
      ok: false,
      error: 'http-status',
      statusCode: 500,
    });
    for (let i = 0; i < DISABLE_AFTER_FAILURES; i++) {
      s.store.now = () => Date.now() + i * 3_600_000;
      s.test.now = s.store.now;
      const delivery = await s.test.handle({ actor: manager, id: webhook.id });
      expect(delivery).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastStatusCode: 500,
        lastError: 'http-status',
      });
    }
    expect(s.store.webhooks.get(webhook.id)).toMatchObject({
      active: true,
      consecutiveFailures: 0,
    });
    const sent = s.sender.sent.length;
    await expect(
      s.test.handle({ actor: manager, id: webhook.id }),
    ).rejects.toMatchObject({ code: 'rate-limited' });
    expect(s.sender.sent).toHaveLength(sent);
    expect(
      [...s.store.deliveries.values()].filter((d) => d.event === 'ping'),
    ).toHaveLength(DISABLE_AFTER_FAILURES);
  });

  it('is 404 for a subscriber the actor does not see, and while webhooks are off', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    const scoped = {
      ...actorWith(['webhook.manage', 'content.read'], {
        maxAudience: 'public',
      }),
      id: 'scoped',
    };
    await expect(
      s.test.handle({ actor: scoped, id: webhook.id }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      s.test.handle({ actor: NOBODY, id: webhook.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const off = setup(fakeWebhookSettings({ enabled: false }));
    await expect(
      off.test.handle({ actor: manager, id: webhook.id }),
    ).rejects.toMatchObject({ code: 'not-configured' });
    expect(s.sender.sent).toHaveLength(0);
  });
});

describe('retrying a failed delivery (#254)', () => {
  async function failed(s: ReturnType<typeof setup>) {
    const made = await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const [delivery] = s.store.deliveries.values();
    s.sender.answer = () => ({
      ok: false,
      error: 'http-status',
      statusCode: 503,
    });
    expect(
      await s.deliver.handle({ deliveryId: delivery!.id, lastAttempt: true }),
    ).toBe('failed');
    s.sender.answer = () => ({ ok: true, statusCode: 200 });
    s.jobs.jobs.length = 0;
    return { ...made, delivery: delivery! };
  }

  it('puts a failed delivery back with a new job, audited, and it is then delivered', async () => {
    const s = setup();
    const { webhook, delivery } = await failed(s);
    const retried = await s.retry.handle({
      actor: manager,
      id: webhook.id,
      deliveryId: delivery.id,
    });
    expect(retried).toMatchObject({ status: 'pending', attempts: 1 });
    expect(s.jobs.jobs).toMatchObject([
      {
        queue: DELIVER_WEBHOOK.name,
        key: `${delivery.id}:retry:1`,
        payload: { deliveryId: delivery.id, deferrals: 0 },
      },
    ]);
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'webhook.retry',
      subject: { type: 'webhook', id: webhook.id },
      data: { deliveryId: delivery.id, event: 'release.withdrawn' },
    });
    s.store.now = () => Date.now() + waitAfter(1) + 1;
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: false }),
    ).toBe('succeeded');
    expect(s.store.deliveries.get(delivery.id)?.attempts).toBe(2);
  });

  it('refuses a delivery made under another audience limit, and skips one waiting when the limit changes', async () => {
    const s = setup();
    const { webhook, delivery } = await failed(s);
    // Another field changed: the limit stands, so it is still sent again.
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { description: 'Portal' },
    });
    await expect(
      s.retry.handle({
        actor: manager,
        id: webhook.id,
        deliveryId: delivery.id,
      }),
    ).resolves.toMatchObject({ status: 'pending' });
    // It fails again, then the limit is narrowed: built under the wider one, it is not sent again.
    s.sender.answer = () => ({
      ok: false,
      error: 'http-status',
      statusCode: 503,
    });
    s.store.now = () => Date.now() + waitAfter(1) + 1;
    expect(
      await s.deliver.handle({ deliveryId: delivery.id, lastAttempt: true }),
    ).toBe('failed');
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { maxAudience: 'public' },
    });
    await expect(
      s.retry.handle({
        actor: manager,
        id: webhook.id,
        deliveryId: delivery.id,
      }),
    ).rejects.toMatchObject({
      code: 'not-retryable',
      meta: { reason: 'audience-changed' },
    });

    // One waiting when the limit changes is skipped, and never sent.
    s.store.now = () => Date.now() + waitAfter(5) + 1;
    s.sender.answer = () => ({ ok: true, statusCode: 200 });
    s.feed.add('release.withdrawn', { releaseId: 'r2' });
    await s.fanOut.handle();
    const waiting = [...s.store.deliveries.values()].find(
      (d) => d.status === 'pending',
    )!;
    expect(waiting.maxAudience).toBe('public');
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { maxAudience: null },
    });
    expect(s.store.deliveries.get(waiting.id)?.status).toBe('skipped');
    expect(s.audit.events.at(-1)?.data).toMatchObject({ skipped: 1 });
    const sent = s.sender.sent.length;
    expect(
      await s.deliver.handle({ deliveryId: waiting.id, lastAttempt: false }),
    ).toBe('settled');
    expect(s.sender.sent.length).toBe(sent);
  });

  it('skips at sending a delivery whose audience limit is no longer the subscriber’s', async () => {
    const s = setup();
    const { webhook } = await subscribe(s);
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const [delivery] = s.store.deliveries.values();
    // The limit changed underneath (no update action ran: a race, a direct write).
    const stored = s.store.webhooks.get(webhook.id)!;
    s.store.webhooks.set(webhook.id, { ...stored, maxAudience: 'public' });
    expect(
      await s.deliver.handle({ deliveryId: delivery!.id, lastAttempt: false }),
    ).toBe('skipped');
  });

  it('refuses what is not failed, a test event, and a paused, reshaped or taken-over subscriber’s', async () => {
    const s = setup();
    const { webhook, delivery } = await failed(s);
    const retry = (deliveryId = delivery.id) =>
      s.retry.handle({ actor: manager, id: webhook.id, deliveryId });
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { active: false },
    });
    await expect(retry()).rejects.toMatchObject({
      code: 'not-retryable',
      meta: { reason: 'inactive' },
    });
    await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: { active: true, events: ['manual.released'] },
    });
    await expect(retry()).rejects.toMatchObject({
      code: 'not-retryable',
      meta: { reason: 'not-subscribed' },
    });
    const everywhere = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'everywhere',
    };
    await s.update.handle({
      actor: everywhere,
      id: webhook.id,
      changes: {
        url: 'https://other.example/',
        events: ['release.withdrawn'],
      },
    });
    await expect(retry()).rejects.toMatchObject({
      code: 'not-retryable',
      meta: { reason: 'owner-changed' },
    });
    // Past the wait after the failure.
    s.store.now = () => Date.now() + waitAfter(1) + 1;
    const ping = await s.test.handle({ actor: everywhere, id: webhook.id });
    await expect(retry(ping.id)).rejects.toMatchObject({
      code: 'not-retryable',
      meta: { reason: 'test-event' },
    });
    expect(s.jobs.jobs).toHaveLength(0);
  });

  it('refuses a delivery that is not failed, and one of another subscriber (404)', async () => {
    const s = setup();
    const { webhook, delivery } = await failed(s);
    await s.retry.handle({
      actor: manager,
      id: webhook.id,
      deliveryId: delivery.id,
    });
    await expect(
      s.retry.handle({
        actor: manager,
        id: webhook.id,
        deliveryId: delivery.id,
      }),
    ).rejects.toMatchObject({
      code: 'not-retryable',
      meta: { reason: 'status' },
    });
    const other = await subscribe(s);
    for (const deliveryId of [delivery.id, 'nope']) {
      await expect(
        s.retry.handle({ actor: manager, id: other.webhook.id, deliveryId }),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
  });
});

describe('custom headers (#457)', () => {
  const TOKEN = 'Bearer unit-secret-4411';
  const withHeaders = (s: ReturnType<typeof setup>) =>
    s.create.handle({
      actor: manager,
      url: 'https://receiver.example/hook',
      events: ['release.withdrawn'],
      description: null,
      headers: [
        { name: 'Authorization', value: TOKEN, secret: true },
        { name: 'X-Api-Version', value: '2' },
      ],
    });

  it('stores a secret value only sealed, shows it never, audits names only, and sends it with each attempt', async () => {
    const s = setup();
    const { webhook } = await withHeaders(s);
    expect(webhook.headers).toEqual([
      { name: 'Authorization', secret: true, value: null },
      { name: 'X-Api-Version', secret: false, value: '2' },
    ]);
    expect(s.store.webhooks.get(webhook.id)?.storedHeaders).toEqual([
      {
        name: 'Authorization',
        sealed: `sealed-header:${webhook.id}:authorization:${TOKEN}`,
      },
      { name: 'X-Api-Version', value: '2' },
    ]);
    const read = await s.get.handle({ actor: manager, id: webhook.id });
    const listed = await s.list.handle({
      actor: manager,
      page: { number: 1, size: 10 },
    });
    expect(s.audit.events[0]?.data).toMatchObject({
      headers: [
        { name: 'Authorization', secret: true },
        { name: 'X-Api-Version', secret: false },
      ],
    });
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const [delivery] = s.store.deliveries.values();
    s.sender.answer = () => ({
      ok: false,
      error: 'http-status',
      statusCode: 503,
    });
    await expect(
      s.deliver.handle({ deliveryId: delivery!.id, lastAttempt: false }),
    ).rejects.toBeInstanceOf(DeliveryAttemptFailed);
    s.store.webhooks.set(webhook.id, {
      ...s.store.webhooks.get(webhook.id)!,
      nextAttemptAt: null,
    });
    s.sender.answer = () => ({ ok: true, statusCode: 200 });
    expect(
      await s.deliver.handle({ deliveryId: delivery!.id, lastAttempt: false }),
    ).toBe('succeeded');
    expect(s.sender.sent.map((r) => r.headers['Authorization'])).toEqual([
      TOKEN,
      TOKEN,
    ]);
    expect(s.sender.sent[0]?.headers['X-Api-Version']).toBe('2');
    const sent = s.store.deliveries.get(delivery!.id)?.sentHeaders;
    expect(sent).toEqual(
      expect.arrayContaining([
        'Authorization',
        'X-Api-Version',
        'X-Ccms-Signature',
      ]),
    );
    const log = await s.deliveries.handle({
      actor: manager,
      id: webhook.id,
      filter: {},
      page: { number: 1, size: 10 },
    });
    for (const text of [read, listed, log, s.audit.events].map((x) =>
      JSON.stringify(x),
    )) {
      expect(text).not.toContain('unit-secret');
    }
  });

  it('fails a delivery as ours when a secret header cannot be opened, sending nothing', async () => {
    const s = setup();
    const { webhook } = await withHeaders(s);
    const stored = s.store.webhooks.get(webhook.id)!;
    s.store.webhooks.set(webhook.id, {
      ...stored,
      storedHeaders: [{ name: 'Authorization', sealed: 'from another key' }],
    });
    s.feed.add('release.withdrawn', { releaseId: 'r1' });
    await s.fanOut.handle();
    const [delivery] = s.store.deliveries.values();
    expect(
      await s.deliver.handle({ deliveryId: delivery!.id, lastAttempt: false }),
    ).toBe('failed');
    expect(s.sender.sent).toEqual([]);
    expect(s.store.deliveries.get(delivery!.id)).toMatchObject({
      lastError: 'secret-unreadable',
      sentHeaders: null,
    });
    expect(s.store.webhooks.get(webhook.id)?.consecutiveFailures).toBe(0);
  });

  it('keeps, replaces and removes headers, audited by name; a new URL needs secret values again', async () => {
    const s = setup();
    const { webhook } = await withHeaders(s);
    const id = webhook.id;
    const kept = await s.update.handle({
      actor: manager,
      id,
      changes: {},
      headers: [
        { name: 'Authorization', secret: true },
        { name: 'X-Api-Version', value: '3' },
      ],
    });
    expect(kept.headers).toEqual([
      { name: 'Authorization', secret: true, value: null },
      { name: 'X-Api-Version', secret: false, value: '3' },
    ]);
    expect(s.store.webhooks.get(id)?.storedHeaders[0]).toEqual({
      name: 'Authorization',
      sealed: `sealed-header:${id}:authorization:${TOKEN}`,
    });
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      fields: ['headers'],
      headers: {
        added: [],
        removed: [],
        changed: ['X-Api-Version'],
        secretChanged: [],
      },
    });
    // The same again: nothing changed, nothing recorded as changed.
    await s.update.handle({
      actor: manager,
      id,
      changes: { description: 'Same headers' },
      headers: [
        { name: 'Authorization', secret: true },
        { name: 'X-Api-Version', value: '3' },
      ],
    });
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      fields: ['description'],
    });
    expect(s.audit.events.at(-1)?.data).not.toHaveProperty('headers');

    await expect(
      s.update.handle({
        actor: manager,
        id,
        changes: { url: 'https://elsewhere.example/hook' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid-headers',
      problems: [{ code: 'header-value-required' }],
    });
    await expect(
      s.update.handle({
        actor: manager,
        id,
        changes: { url: 'https://elsewhere.example/hook' },
        headers: [{ name: 'Authorization', secret: true }],
      }),
    ).rejects.toMatchObject({ code: 'invalid-headers' });
    expect(s.store.webhooks.get(id)?.url).toBe('https://receiver.example/hook');

    const moved = await s.update.handle({
      actor: manager,
      id,
      changes: { url: 'https://elsewhere.example/hook' },
      headers: [{ name: 'Authorization', value: 'Bearer new', secret: true }],
    });
    expect(moved.headers).toEqual([
      { name: 'Authorization', secret: true, value: null },
    ]);
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      headers: {
        removed: ['X-Api-Version'],
        secretChanged: ['Authorization'],
      },
    });
    const removed = await s.update.handle({
      actor: manager,
      id,
      changes: {},
      headers: [],
    });
    expect(removed.headers).toEqual([]);
    expect(JSON.stringify(s.audit.events)).not.toContain('Bearer');
  });

  it('stores a change of a name’s case or of the order; is off without a key', async () => {
    const s = setup();
    const { webhook } = await withHeaders(s);
    const renamed = await s.update.handle({
      actor: manager,
      id: webhook.id,
      changes: {},
      headers: [
        { name: 'x-api-version', value: '2' },
        { name: 'authorization', secret: true },
      ],
    });
    expect(renamed.headers.map((h) => h.name)).toEqual([
      'x-api-version',
      'authorization',
    ]);
    expect(s.audit.events.at(-1)?.data).toMatchObject({
      headers: { changed: ['x-api-version', 'authorization'] },
    });
    const off = setup(fakeWebhookSettings({ enabled: false }));
    await expect(
      off.update.handle({
        actor: manager,
        id: webhook.id,
        changes: {},
        headers: [],
      }),
    ).rejects.toMatchObject({ code: 'not-configured' });
  });

  it('lets only the owner, or a manager covering any owner of any subscriber, change the headers', async () => {
    const s = setup();
    const { webhook } = await withHeaders(s);
    const other = {
      ...actorWith(['webhook.manage', 'content.read']),
      id: 'other',
    };
    await expect(
      s.update.handle({
        actor: other,
        id: webhook.id,
        changes: {},
        headers: [],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Handed back unchanged: not a change.
    await s.update.handle({
      actor: other,
      id: webhook.id,
      changes: { description: 'Theirs' },
      headers: [
        { name: 'Authorization', secret: true },
        { name: 'X-Api-Version', value: '2' },
      ],
    });
    const everything = {
      ...actorWith([
        'webhook.manage',
        'content.read',
        'content.read.draft',
        'translation.manage',
      ]),
      id: 'everything',
    };
    const changed = await s.update.handle({
      actor: everything,
      id: webhook.id,
      changes: {},
      headers: [],
    });
    expect(changed.headers).toEqual([]);
  });
});
