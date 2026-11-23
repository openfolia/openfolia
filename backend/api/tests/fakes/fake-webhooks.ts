import type { Actor } from '../../src/access/core/actor.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type {
  Delivery,
  DeliveryFilter,
  DeliverySummary,
  DeliveryTarget,
  NewDelivery,
  NewWebhook,
  Webhook,
  WebhookChanges,
  WebhookOwner,
} from '../../src/webhooks/core/webhook.js';
import {
  publicHeaders,
  type StoredHeader,
} from '../../src/webhooks/core/webhook-headers.js';
import {
  type OutgoingRequest,
  type SendResult,
  WebhookOwners,
  WebhookSecrets,
  WebhookSender,
  WebhookSettings,
} from '../../src/webhooks/core/webhook-ports.js';
import {
  type AttemptRecord,
  type SendClaim,
  WebhookStore,
  type WebhookVisibility,
} from '../../src/webhooks/core/webhook-store.js';
import { fakeOf } from './fake-unit-of-work.js';

type Stored = DeliveryTarget & {
  readonly sendingUntil: Date | null;
  readonly nextAttemptAt: Date | null;
};

/** Subscribers and deliveries in memory; writes apply when their transaction commits. */
export class FakeWebhookStore extends WebhookStore {
  readonly webhooks = new Map<string, Stored>();
  readonly deliveries = new Map<string, Delivery>();

  async list(
    page: PageRequest,
    visible: WebhookVisibility,
  ): Promise<Paginated<Webhook>> {
    return paginate(
      [...this.webhooks.values()]
        .filter(
          (w) =>
            visible === 'all' ||
            (w.owner.kind === visible.owner.kind &&
              w.owner.id === visible.owner.id) ||
            (visible.orWithout !== undefined &&
              !w.events.includes(visible.orWithout)),
        )
        .map(strip),
      page,
    );
  }

  async find(id: string): Promise<Webhook | undefined> {
    const found = this.webhooks.get(id);
    return found && strip(found);
  }

  async storedHeaders(
    _tx: Transaction,
    id: string,
  ): Promise<readonly StoredHeader[]> {
    return this.must(id).storedHeaders;
  }

  async insert(
    tx: Transaction,
    webhook: NewWebhook,
    max: number,
  ): Promise<Webhook | undefined> {
    if (this.webhooks.size >= max) return undefined;
    const now = new Date();
    const stored: Stored = {
      id: webhook.id,
      url: webhook.url,
      description: webhook.description,
      events: [...webhook.events],
      maxAudience: webhook.maxAudience,
      active: true,
      disabledReason: null,
      disabledAt: null,
      consecutiveFailures: 0,
      owner: webhook.owner,
      createdAt: now,
      updatedAt: now,
      secretRotatedAt: now,
      previousSecretUntil: null,
      secrets: { current: webhook.sealedSecret, previous: null },
      headers: publicHeaders(webhook.headers),
      storedHeaders: [...webhook.headers],
      attemptFailures: 0,
      sendingUntil: null,
      nextAttemptAt: null,
    };
    fakeOf(tx).onCommit(() => this.webhooks.set(stored.id, stored));
    return strip(stored);
  }

  async update(
    tx: Transaction,
    id: string,
    changes: WebhookChanges,
  ): Promise<Webhook> {
    const old = this.must(id);
    const next: Stored = {
      ...old,
      ...(changes.url !== undefined && { url: changes.url }),
      ...(changes.description !== undefined && {
        description: changes.description,
      }),
      ...(changes.events !== undefined && { events: [...changes.events] }),
      ...(changes.maxAudience !== undefined && {
        maxAudience: changes.maxAudience,
      }),
      ...(changes.active === true && {
        active: true,
        disabledReason: null,
        disabledAt: null,
        consecutiveFailures: 0,
      }),
      ...(changes.active === false && { active: false }),
      ...(changes.owner !== undefined && { owner: changes.owner }),
      ...(changes.headers !== undefined && {
        headers: publicHeaders(changes.headers),
        storedHeaders: [...changes.headers],
      }),
      updatedAt: new Date(),
    };
    fakeOf(tx).onCommit(() => this.webhooks.set(id, next));
    return strip(next);
  }

  async delete(tx: Transaction, id: string): Promise<boolean> {
    const there = this.webhooks.has(id);
    fakeOf(tx).onCommit(() => {
      this.webhooks.delete(id);
      for (const [key, d] of this.deliveries) {
        if (d.webhookId === id) this.deliveries.delete(key);
      }
    });
    return there;
  }

  async rotateSecret(
    tx: Transaction,
    id: string,
    sealed: string,
    previousUntil: Date,
  ): Promise<Webhook> {
    const old = this.must(id);
    const next: Stored = {
      ...old,
      secrets: { current: sealed, previous: old.secrets.current },
      previousSecretUntil: previousUntil,
      secretRotatedAt: new Date(),
    };
    fakeOf(tx).onCommit(() => this.webhooks.set(id, next));
    return strip(next);
  }

  async active(): Promise<Webhook[]> {
    return [...this.webhooks.values()].filter((w) => w.active).map(strip);
  }

  async target(id: string): Promise<DeliveryTarget | undefined> {
    return this.webhooks.get(id);
  }

  async addDeliveries(
    tx: Transaction,
    deliveries: readonly NewDelivery[],
  ): Promise<string[]> {
    const taken = new Set(
      [...this.deliveries.values()].map(
        (d) => `${d.webhookId}|${d.idempotencyKey}`,
      ),
    );
    const added: Delivery[] = [];
    for (const d of deliveries) {
      const key = `${d.webhookId}|${d.idempotencyKey}`;
      if (taken.has(key) || !this.webhooks.has(d.webhookId)) continue;
      taken.add(key);
      added.push({
        id: d.id,
        webhookId: d.webhookId,
        event: d.event,
        idempotencyKey: d.idempotencyKey,
        body: d.body,
        owner: d.owner,
        maxAudience: d.maxAudience,
        status: 'pending',
        attempts: 0,
        lastAttemptAt: null,
        lastStatusCode: null,
        lastError: null,
        deliveredAt: null,
        sentHeaders: null,
        createdAt: new Date(),
      });
    }
    fakeOf(tx).onCommit(() => {
      for (const d of added) this.deliveries.set(d.id, d);
    });
    return added.map((d) => d.id);
  }

  async lastDeliveries(
    webhookIds: readonly string[],
  ): Promise<ReadonlyMap<string, DeliverySummary>> {
    const out = new Map<string, DeliverySummary>();
    // Insertion order is creation order: the last one wins.
    for (const d of this.deliveries.values()) {
      if (!webhookIds.includes(d.webhookId)) continue;
      out.set(d.webhookId, {
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastAttemptAt: d.lastAttemptAt,
        lastStatusCode: d.lastStatusCode,
        lastError: d.lastError,
        createdAt: d.createdAt,
      });
    }
    return out;
  }

  async delivery(id: string): Promise<Delivery | undefined> {
    return this.deliveries.get(id);
  }

  async listDeliveries(
    webhookId: string,
    filter: DeliveryFilter,
    page: PageRequest,
  ): Promise<Paginated<Delivery>> {
    return paginate(
      [...this.deliveries.values()]
        .filter(
          (d) =>
            d.webhookId === webhookId &&
            (filter.status === undefined || d.status === filter.status) &&
            (filter.event === undefined || d.event === filter.event),
        )
        .reverse(),
      page,
    );
  }

  async recordAttempt(
    tx: Transaction,
    id: string,
    attempt: AttemptRecord,
  ): Promise<boolean> {
    const d = this.deliveries.get(id);
    if (d?.status !== 'pending') return false;
    fakeOf(tx).onCommit(() =>
      this.deliveries.set(id, {
        ...d,
        status: attempt.status,
        attempts: d.attempts + 1,
        lastAttemptAt: attempt.at,
        lastStatusCode: attempt.statusCode,
        lastError: attempt.error,
        sentHeaders: attempt.sentHeaders,
        deliveredAt: attempt.status === 'succeeded' ? attempt.at : null,
      }),
    );
    return true;
  }

  async requeue(
    tx: Transaction,
    id: string,
  ): Promise<{ readonly deferrals: number } | undefined> {
    const d = this.deliveries.get(id);
    if (d?.status !== 'failed') return undefined;
    fakeOf(tx).onCommit(() =>
      this.deliveries.set(id, { ...d, status: 'pending' }),
    );
    return { deferrals: this.deferrals.get(id) ?? 0 };
  }

  async skip(tx: Transaction, id: string): Promise<boolean> {
    const d = this.deliveries.get(id);
    if (d?.status !== 'pending') return false;
    fakeOf(tx).onCommit(() =>
      this.deliveries.set(id, { ...d, status: 'skipped' }),
    );
    return true;
  }

  async skipPendingNotFor(
    tx: Transaction,
    webhookId: string,
    owner: WebhookOwner,
    maxAudience: string | null,
  ): Promise<number> {
    const skipped = [...this.deliveries.values()].filter(
      (d) =>
        d.webhookId === webhookId &&
        d.status === 'pending' &&
        (d.owner.kind !== owner.kind ||
          d.owner.id !== owner.id ||
          d.maxAudience !== maxAudience),
    );
    fakeOf(tx).onCommit(() => {
      for (const d of skipped)
        this.deliveries.set(d.id, { ...d, status: 'skipped' });
    });
    return skipped.length;
  }

  /** The store's clock (the database's, for the real one). */
  now: () => number = Date.now;

  async claimSend(
    webhookId: string,
    owner: WebhookOwner,
    sendMs: number,
    perOwner: number,
  ): Promise<SendClaim> {
    const now = this.now();
    const soon = new Date(now + 5_000);
    const w = this.webhooks.get(webhookId);
    if (!w) return { retryAt: soon };
    if (w.nextAttemptAt && w.nextAttemptAt.getTime() > now) {
      return { retryAt: w.nextAttemptAt };
    }
    if (w.sendingUntil && w.sendingUntil.getTime() > now) {
      return { retryAt: soon };
    }
    const held = [...this.webhooks.values()].filter(
      (o) =>
        o.owner.kind === owner.kind &&
        o.owner.id === owner.id &&
        o.sendingUntil !== null &&
        o.sendingUntil.getTime() > now,
    ).length;
    if (held >= perOwner) return { retryAt: soon };
    const token = new Date(now + sendMs);
    this.webhooks.set(webhookId, { ...w, sendingUntil: token });
    return { token };
  }

  /** Put-offs counted per delivery. */
  readonly deferrals = new Map<string, number>();

  async noteDeferral(
    tx: Transaction,
    deliveryId: string,
    deferrals: number,
  ): Promise<boolean> {
    const d = this.deliveries.get(deliveryId);
    if (d?.status !== 'pending') return false;
    if ((this.deferrals.get(deliveryId) ?? 0) !== deferrals) return false;
    fakeOf(tx).onCommit(() => this.deferrals.set(deliveryId, deferrals + 1));
    return true;
  }

  async releaseSend(webhookId: string, token: Date): Promise<void> {
    const w = this.webhooks.get(webhookId);
    if (w?.sendingUntil?.getTime() === token.getTime()) {
      this.webhooks.set(webhookId, { ...w, sendingUntil: null });
    }
  }

  async noteAttemptFailure(
    tx: Transaction,
    webhookId: string,
    waitMs: number,
  ): Promise<void> {
    const at = new Date(this.now() + waitMs);
    fakeOf(tx).onCommit(() => {
      const w = this.webhooks.get(webhookId);
      if (!w) return;
      this.webhooks.set(webhookId, {
        ...w,
        attemptFailures: w.attemptFailures + 1,
        nextAttemptAt: at,
      });
    });
  }

  async noteSuccess(tx: Transaction, webhookId: string): Promise<void> {
    this.must(webhookId);
    fakeOf(tx).onCommit(() => {
      const w = this.webhooks.get(webhookId);
      if (!w) return;
      this.webhooks.set(webhookId, {
        ...w,
        consecutiveFailures: 0,
        attemptFailures: 0,
        nextAttemptAt: null,
      });
    });
  }

  async noteFailure(
    tx: Transaction,
    webhookId: string,
    disableAfter: number,
  ): Promise<boolean> {
    const w = this.webhooks.get(webhookId);
    if (!w) return false;
    const failures = w.consecutiveFailures + 1;
    const disable = w.active && failures >= disableAfter;
    fakeOf(tx).onCommit(() =>
      this.webhooks.set(webhookId, {
        ...(this.webhooks.get(webhookId) ?? w),
        consecutiveFailures: failures,
        ...(disable && {
          active: false,
          disabledReason: 'failing',
          disabledAt: new Date(),
        }),
      }),
    );
    return disable;
  }

  async pruneDeliveries(before: Date, limit: number): Promise<number> {
    let removed = 0;
    for (const [id, d] of this.deliveries) {
      if (removed >= limit) break;
      if (d.status !== 'pending' && d.createdAt < before) {
        this.deliveries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private must(id: string): Stored {
    const found = this.webhooks.get(id);
    if (!found) throw new Error(`No webhook ${id}`);
    return found;
  }
}

function strip(stored: Stored): Webhook {
  const {
    secrets: _secrets,
    storedHeaders: _headers,
    attemptFailures: _failures,
    sendingUntil: _sending,
    nextAttemptAt: _next,
    ...webhook
  } = stored;
  return webhook;
}

/** Seals by prefixing (tests only): `sealed:<secret>`. */
export class FakeWebhookSecrets extends WebhookSecrets {
  /** Set: nothing opens (the key changed). */
  broken = false;
  seal(secret: string, webhookId: string): string {
    return `sealed:${webhookId}:${secret}`;
  }
  open(sealed: string, webhookId: string): string {
    const prefix = `sealed:${webhookId}:`;
    if (this.broken || !sealed.startsWith(prefix))
      throw new Error('cannot open');
    return sealed.slice(prefix.length);
  }
  sealHeader(value: string, webhookId: string, name: string): string {
    return `sealed-header:${webhookId}:${name.toLowerCase()}:${value}`;
  }
  openHeader(sealed: string, webhookId: string, name: string): string {
    const prefix = `sealed-header:${webhookId}:${name.toLowerCase()}:`;
    if (this.broken || !sealed.startsWith(prefix))
      throw new Error('cannot open');
    return sealed.slice(prefix.length);
  }
}

/** Records every request and answers what `answer` says (200 by default). */
export class FakeWebhookSender extends WebhookSender {
  readonly sent: OutgoingRequest[] = [];
  answer: (request: OutgoingRequest) => SendResult = () => ({
    ok: true,
    statusCode: 200,
  });

  async send(request: OutgoingRequest): Promise<SendResult> {
    this.sent.push(request);
    return this.answer(request);
  }
}

/** Owners by `<kind>/<id>`. */
export class FakeWebhookOwners extends WebhookOwners {
  readonly actors = new Map<string, Actor>();

  add(actor: Actor): this {
    this.actors.set(`${actor.kind}/${actor.id}`, actor);
    return this;
  }

  async find(owner: WebhookOwner): Promise<Actor | undefined> {
    return this.actors.get(`${owner.kind}/${owner.id}`);
  }
}

/** Settings for tests: on, https and public addresses only. */
export const fakeWebhookSettings = (
  overrides: Partial<WebhookSettings> = {},
): WebhookSettings => ({
  enabled: true,
  rules: { allowHttp: false, allowPrivate: false },
  timeoutMs: 1_000,
  keepDays: 30,
  ...overrides,
});
