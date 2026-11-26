import { Injectable } from '@nestjs/common';
import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type Delivery,
  type DeliveryError,
  DeliveryEvent,
  type DeliveryFilter,
  DeliveryStatus,
  type DeliverySummary,
  type DeliveryTarget,
  MAX_WEBHOOKS,
  type NewDelivery,
  type NewWebhook,
  type Webhook,
  type WebhookChanges,
  WebhookEvent,
  type WebhookOwner,
} from '../core/webhook.js';
import {
  type AttemptRecord,
  type SendClaim,
  WebhookStore,
  type WebhookVisibility,
} from '../core/webhook-store.js';
import type { StoredHeader, WebhookHeader } from '../core/webhook-headers.js';
import {
  storedHeadersOf,
  toStoredJson,
  webhookDeliveries,
  webhooks,
} from './webhooks.tables.js';

type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/** Every column but the secrets: what reads that do not deliver take. */
const PUBLIC_COLUMNS = {
  id: webhooks.id,
  url: webhooks.url,
  description: webhooks.description,
  events: webhooks.events,
  maxAudience: webhooks.maxAudience,
  active: webhooks.active,
  disabledReason: webhooks.disabledReason,
  disabledAt: webhooks.disabledAt,
  consecutiveFailures: webhooks.consecutiveFailures,
  ownerKind: webhooks.ownerKind,
  ownerId: webhooks.ownerId,
  createdAt: webhooks.createdAt,
  updatedAt: webhooks.updatedAt,
  secretRotatedAt: webhooks.secretRotatedAt,
  previousSecretUntil: webhooks.previousSecretUntil,
  // The custom headers without a secret one's sealed value (#457): it is
  // never read but to deliver or to change the headers.
  headers: sql<unknown>`coalesce((select jsonb_agg(h - 'sealed' order by n) from jsonb_array_elements(${webhooks.headers}) with ordinality as e(h, n)), '[]'::jsonb)`,
};
type PublicRow = Omit<
  WebhookRow,
  | 'secretSealed'
  | 'previousSecretSealed'
  | 'attemptFailures'
  | 'sendingUntil'
  | 'nextAttemptAt'
  | 'headers'
> & { readonly headers: unknown };

/** How soon an attempt refused for a claim held tries again. */
const BUSY_RETRY_MS = 5_000;

/** The advisory lock under which subscribers are counted and added. */
// Compatibility: keeps the working name from before the product was named OpenFolia (this lock and the
// owner's below): servers of the version before and after an upgrade take the same locks.
const INSERT_LOCK = sql`pg_advisory_xact_lock(hashtext('ccms:webhooks:insert'))`;

/** `WebhookStore` over the `webhooks` and `webhook_deliveries` tables. */
@Injectable()
export class DrizzleWebhookStore extends WebhookStore {
  constructor(private readonly database: Database) {
    super();
  }

  async list(
    page: PageRequest,
    visible: WebhookVisibility,
  ): Promise<Paginated<Webhook>> {
    const where =
      visible === 'all'
        ? undefined
        : or(
            and(
              eq(webhooks.ownerKind, visible.owner.kind),
              eq(webhooks.ownerId, visible.owner.id),
            ),
            visible.orWithout === undefined
              ? undefined
              : not(arrayOverlaps(webhooks.events, [...visible.orWithout])),
          );
    return this.database.db.transaction(
      async (tx) => {
        const rows = await tx
          .select(PUBLIC_COLUMNS)
          .from(webhooks)
          .where(where)
          .orderBy(asc(webhooks.createdAt), asc(webhooks.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        const [counted] = await tx
          .select({ total: count() })
          .from(webhooks)
          .where(where);
        return { items: rows.map(toWebhook), total: counted?.total ?? 0 };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async find(id: string, tx?: Transaction): Promise<Webhook | undefined> {
    const db = tx ? drizzleOf(tx) : this.database.db;
    const query = db
      .select(PUBLIC_COLUMNS)
      .from(webhooks)
      .where(eq(webhooks.id, id));
    const [row] = tx ? await query.for('update') : await query;
    return row && toWebhook(row);
  }

  async storedHeaders(
    tx: Transaction,
    id: string,
  ): Promise<readonly StoredHeader[]> {
    const [row] = await drizzleOf(tx)
      .select({ headers: webhooks.headers })
      .from(webhooks)
      .where(eq(webhooks.id, id));
    if (!row) throw new Error(`No webhook "${id}".`);
    return storedHeadersOf(row.headers);
  }

  async insert(
    tx: Transaction,
    webhook: NewWebhook,
    max: number,
  ): Promise<Webhook | undefined> {
    const db = drizzleOf(tx);
    await db.execute(sql`select ${INSERT_LOCK}`);
    const [counted] = await db.select({ total: count() }).from(webhooks);
    if ((counted?.total ?? 0) >= max) return undefined;
    const [row] = await db
      .insert(webhooks)
      .values({
        id: webhook.id,
        url: webhook.url,
        description: webhook.description,
        events: [...webhook.events],
        maxAudience: webhook.maxAudience,
        secretSealed: webhook.sealedSecret,
        headers: toStoredJson(webhook.headers),
        ownerKind: webhook.owner.kind,
        ownerId: webhook.owner.id,
      })
      .returning(PUBLIC_COLUMNS);
    if (!row) throw new Error('The webhook was not written.');
    return toWebhook(row);
  }

  async update(
    tx: Transaction,
    id: string,
    changes: WebhookChanges,
  ): Promise<Webhook> {
    const [row] = await drizzleOf(tx)
      .update(webhooks)
      .set({
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
        ...(changes.owner !== undefined && {
          ownerKind: changes.owner.kind,
          ownerId: changes.owner.id,
        }),
        ...(changes.headers !== undefined && {
          headers: toStoredJson(changes.headers),
        }),
        updatedAt: sql`now()`,
      })
      .where(eq(webhooks.id, id))
      .returning(PUBLIC_COLUMNS);
    if (!row) throw new Error(`No webhook "${id}" to change.`);
    return toWebhook(row);
  }

  async delete(tx: Transaction, id: string): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .delete(webhooks)
      .where(eq(webhooks.id, id))
      .returning({ id: webhooks.id });
    return rows.length > 0;
  }

  async rotateSecret(
    tx: Transaction,
    id: string,
    sealed: string,
    previousUntil: Date,
  ): Promise<Webhook> {
    const [row] = await drizzleOf(tx)
      .update(webhooks)
      .set({
        previousSecretSealed: sql`${webhooks.secretSealed}`,
        previousSecretUntil: previousUntil,
        secretSealed: sealed,
        secretRotatedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(webhooks.id, id))
      .returning(PUBLIC_COLUMNS);
    if (!row) throw new Error(`No webhook "${id}" to rotate.`);
    return toWebhook(row);
  }

  async active(): Promise<Webhook[]> {
    const rows = await this.database.db
      .select(PUBLIC_COLUMNS)
      .from(webhooks)
      .where(eq(webhooks.active, true))
      .orderBy(asc(webhooks.createdAt), asc(webhooks.id))
      .limit(MAX_WEBHOOKS);
    return rows.map(toWebhook);
  }

  async target(id: string): Promise<DeliveryTarget | undefined> {
    const [row] = await this.database.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, id));
    if (!row) return undefined;
    const stored = storedHeadersOf(row.headers);
    return {
      ...toWebhook({ ...row, headers: toStoredJson(stored) }),
      storedHeaders: stored,
      secrets: {
        current: row.secretSealed,
        previous: row.previousSecretSealed,
      },
      attemptFailures: row.attemptFailures,
    };
  }

  async addDeliveries(
    tx: Transaction,
    deliveries: readonly NewDelivery[],
  ): Promise<string[]> {
    if (deliveries.length === 0) return [];
    const db = drizzleOf(tx);
    // A subscriber deleted meanwhile: its deliveries are left out.
    const there = new Set(
      (
        await db
          .select({ id: webhooks.id })
          .from(webhooks)
          .where(
            inArray(webhooks.id, [
              ...new Set(deliveries.map((d) => d.webhookId)),
            ]),
          )
          .for('share')
      ).map((r) => r.id),
    );
    const rows = deliveries.filter((d) => there.has(d.webhookId));
    if (rows.length === 0) return [];
    const added = await db
      .insert(webhookDeliveries)
      .values(
        rows.map((d) => ({
          id: d.id,
          webhookId: d.webhookId,
          event: d.event,
          idempotencyKey: d.idempotencyKey,
          body: d.body,
          ownerKind: d.owner.kind,
          ownerId: d.owner.id,
          maxAudience: d.maxAudience,
          outboxId: d.outboxId,
        })),
      )
      .onConflictDoNothing({
        target: [webhookDeliveries.webhookId, webhookDeliveries.idempotencyKey],
      })
      .returning({ id: webhookDeliveries.id });
    return added.map((r) => r.id);
  }

  async lastDeliveries(
    webhookIds: readonly string[],
  ): Promise<ReadonlyMap<string, DeliverySummary>> {
    if (webhookIds.length === 0) return new Map();
    const rows = await this.database.db
      .selectDistinctOn([webhookDeliveries.webhookId], {
        webhookId: webhookDeliveries.webhookId,
        id: webhookDeliveries.id,
        event: webhookDeliveries.event,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastAttemptAt: webhookDeliveries.lastAttemptAt,
        lastStatusCode: webhookDeliveries.lastStatusCode,
        lastError: webhookDeliveries.lastError,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.webhookId, [...webhookIds]))
      .orderBy(
        webhookDeliveries.webhookId,
        desc(webhookDeliveries.createdAt),
        desc(webhookDeliveries.id),
      );
    return new Map(
      rows.map((r) => [
        r.webhookId,
        {
          id: r.id,
          event: DeliveryEvent.parse(r.event),
          status: DeliveryStatus.parse(r.status),
          attempts: r.attempts,
          lastAttemptAt: r.lastAttemptAt,
          lastStatusCode: r.lastStatusCode,
          lastError: r.lastError as DeliveryError | null,
          createdAt: r.createdAt,
        },
      ]),
    );
  }

  async delivery(id: string): Promise<Delivery | undefined> {
    const [row] = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    return row && toDelivery(row);
  }

  async listDeliveries(
    webhookId: string,
    filter: DeliveryFilter,
    page: PageRequest,
  ): Promise<Paginated<Delivery>> {
    const where = and(
      eq(webhookDeliveries.webhookId, webhookId),
      filter.status === undefined
        ? undefined
        : eq(webhookDeliveries.status, filter.status),
      filter.event === undefined
        ? undefined
        : eq(webhookDeliveries.event, filter.event),
    );
    return this.database.db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(webhookDeliveries)
          .where(where)
          .orderBy(
            desc(webhookDeliveries.createdAt),
            desc(webhookDeliveries.id),
          )
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        const [counted] = await tx
          .select({ total: count() })
          .from(webhookDeliveries)
          .where(where);
        return { items: rows.map(toDelivery), total: counted?.total ?? 0 };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async requeue(
    tx: Transaction,
    id: string,
  ): Promise<{ readonly deferrals: number } | undefined> {
    const [row] = await drizzleOf(tx)
      .update(webhookDeliveries)
      .set({ status: 'pending' })
      .where(
        and(
          eq(webhookDeliveries.id, id),
          eq(webhookDeliveries.status, 'failed'),
        ),
      )
      .returning({ deferrals: webhookDeliveries.deferrals });
    return row;
  }

  async recordAttempt(
    tx: Transaction,
    id: string,
    attempt: AttemptRecord,
  ): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .update(webhookDeliveries)
      .set({
        status: attempt.status,
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastAttemptAt: attempt.at,
        lastStatusCode: attempt.statusCode,
        lastError: attempt.error,
        sentHeaders:
          attempt.sentHeaders === null ? null : [...attempt.sentHeaders],
        ...(attempt.status === 'succeeded' && { deliveredAt: attempt.at }),
      })
      .where(
        and(
          eq(webhookDeliveries.id, id),
          eq(webhookDeliveries.status, 'pending'),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return rows.length > 0;
  }

  async skip(tx: Transaction, id: string): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .update(webhookDeliveries)
      .set({ status: 'skipped' })
      .where(
        and(
          eq(webhookDeliveries.id, id),
          eq(webhookDeliveries.status, 'pending'),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return rows.length > 0;
  }

  async skipPendingNotFor(
    tx: Transaction,
    webhookId: string,
    owner: WebhookOwner,
    maxAudience: string | null,
  ): Promise<number> {
    const rows = await drizzleOf(tx)
      .update(webhookDeliveries)
      .set({ status: 'skipped' })
      .where(
        and(
          eq(webhookDeliveries.webhookId, webhookId),
          eq(webhookDeliveries.status, 'pending'),
          or(
            ne(webhookDeliveries.ownerKind, owner.kind),
            ne(webhookDeliveries.ownerId, owner.id),
            maxAudience === null
              ? isNotNull(webhookDeliveries.maxAudience)
              : or(
                  isNull(webhookDeliveries.maxAudience),
                  ne(webhookDeliveries.maxAudience, maxAudience),
                ),
          ),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return rows.length;
  }

  async claimSend(
    webhookId: string,
    owner: WebhookOwner,
    sendMs: number,
    perOwner: number,
  ): Promise<SendClaim> {
    return this.database.db.transaction(async (tx) => {
      // One claim at a time per owner, so their count holds.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`ccms:webhooks:owner:${owner.kind}/${owner.id}`}))`,
      );
      const [row] = await tx
        .select({
          now: sql<Date>`now()`.mapWith(webhooks.createdAt),
          sendingUntil: webhooks.sendingUntil,
          nextAttemptAt: webhooks.nextAttemptAt,
        })
        .from(webhooks)
        .where(eq(webhooks.id, webhookId))
        .for('update');
      if (!row) return { retryAt: new Date() };
      const now = row.now;
      const soon = new Date(now.getTime() + BUSY_RETRY_MS);
      if (row.nextAttemptAt && row.nextAttemptAt > now) {
        return { retryAt: row.nextAttemptAt };
      }
      if (row.sendingUntil && row.sendingUntil > now) return { retryAt: soon };
      const [held] = await tx
        .select({ n: count() })
        .from(webhooks)
        .where(
          and(
            eq(webhooks.ownerKind, owner.kind),
            eq(webhooks.ownerId, owner.id),
            sql`${webhooks.sendingUntil} > now()`,
          ),
        );
      if ((held?.n ?? 0) >= perOwner) return { retryAt: soon };
      const [claimed] = await tx
        .update(webhooks)
        .set({
          // To the millisecond, so the token read back as a Date matches.
          sendingUntil: sql`date_trunc('milliseconds', now() + ${`${sendMs} milliseconds`}::interval)`,
        })
        .where(eq(webhooks.id, webhookId))
        .returning({ token: webhooks.sendingUntil });
      return claimed?.token ? { token: claimed.token } : { retryAt: soon };
    });
  }

  async noteDeferral(
    tx: Transaction,
    deliveryId: string,
    deferrals: number,
  ): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .update(webhookDeliveries)
      .set({ deferrals: deferrals + 1 })
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.status, 'pending'),
          eq(webhookDeliveries.deferrals, deferrals),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return rows.length > 0;
  }

  async releaseSend(webhookId: string, token: Date): Promise<void> {
    await this.database.db
      .update(webhooks)
      .set({ sendingUntil: null })
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.sendingUntil, token)));
  }

  async noteAttemptFailure(
    tx: Transaction,
    webhookId: string,
    waitMs: number,
  ): Promise<void> {
    await drizzleOf(tx)
      .update(webhooks)
      .set({
        attemptFailures: sql`${webhooks.attemptFailures} + 1`,
        nextAttemptAt: sql`now() + ${`${waitMs} milliseconds`}::interval`,
      })
      .where(eq(webhooks.id, webhookId));
  }

  async noteSuccess(tx: Transaction, webhookId: string): Promise<void> {
    await drizzleOf(tx)
      .update(webhooks)
      .set({ consecutiveFailures: 0, attemptFailures: 0, nextAttemptAt: null })
      .where(eq(webhooks.id, webhookId));
  }

  async noteFailure(
    tx: Transaction,
    webhookId: string,
    disableAfter: number,
  ): Promise<boolean> {
    const db = drizzleOf(tx);
    const [row] = await db
      .select({
        active: webhooks.active,
        failures: webhooks.consecutiveFailures,
      })
      .from(webhooks)
      .where(eq(webhooks.id, webhookId))
      .for('update');
    if (!row) return false;
    const failures = row.failures + 1;
    const disable = row.active && failures >= disableAfter;
    await db
      .update(webhooks)
      .set({
        consecutiveFailures: failures,
        ...(disable && {
          active: false,
          disabledReason: 'failing',
          disabledAt: sql`now()`,
        }),
      })
      .where(eq(webhooks.id, webhookId));
    return disable;
  }

  async pruneDeliveries(before: Date, limit: number): Promise<number> {
    const rows = await this.database.db.execute<{ id: string }>(sql`
      delete from ${webhookDeliveries}
      where ${webhookDeliveries.id} in (
        select ${webhookDeliveries.id} from ${webhookDeliveries}
        where ${webhookDeliveries.status} <> 'pending'
          and ${webhookDeliveries.createdAt} < ${before.toISOString()}::timestamptz
        limit ${limit}
      )
      returning ${webhookDeliveries.id}`);
    return rowCount(rows);
  }
}

function rowCount(result: unknown): number {
  const r = result as { rows?: unknown[]; length?: number };
  return Array.isArray(r) ? r.length : (r.rows?.length ?? 0);
}

function toWebhook(row: PublicRow): Webhook {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events.flatMap((e) => {
      const parsed = WebhookEvent.safeParse(e);
      return parsed.success ? [parsed.data] : [];
    }),
    maxAudience: row.maxAudience,
    active: row.active,
    disabledReason: row.disabledReason === 'failing' ? 'failing' : null,
    disabledAt: row.disabledAt,
    consecutiveFailures: row.consecutiveFailures,
    owner: {
      kind: row.ownerKind === 'service' ? 'service' : 'user',
      id: row.ownerId,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    secretRotatedAt: row.secretRotatedAt,
    previousSecretUntil: row.previousSecretUntil,
    headers: publicHeadersOf(row.headers),
  };
}

/**
 * The headers as shown, from the column's JSON (`PUBLIC_COLUMNS` drops a
 * secret one's sealed value already; it is never shown either way).
 */
function publicHeadersOf(json: unknown): WebhookHeader[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((h: unknown): WebhookHeader[] => {
    if (typeof h !== 'object' || h === null) return [];
    const { name, secret, value } = h as Record<string, unknown>;
    if (typeof name !== 'string') return [];
    if (secret === true) return [{ name, secret: true, value: null }];
    return typeof value === 'string' ? [{ name, secret: false, value }] : [];
  });
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    event: DeliveryEvent.parse(row.event),
    idempotencyKey: row.idempotencyKey,
    body: row.body,
    owner: {
      kind: row.ownerKind === 'service' ? 'service' : 'user',
      id: row.ownerId,
    },
    maxAudience: row.maxAudience,
    status: DeliveryStatus.parse(row.status),
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError as DeliveryError | null,
    deliveredAt: row.deliveredAt,
    sentHeaders: row.sentHeaders,
    createdAt: row.createdAt,
  };
}
