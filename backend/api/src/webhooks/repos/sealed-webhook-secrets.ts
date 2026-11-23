import { Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import {
  SealedSecretSource,
  type SealedValue,
  SecretSealer,
} from '../../base/core/secret-sealer.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { WebhookSecrets } from '../core/webhook-ports.js';
import { isSecret } from '../core/webhook-headers.js';
import { storedHeadersOf, toStoredJson, webhooks } from './webhooks.tables.js';

/**
 * What a subscriber's sealed secret is bound to: its purpose and its ID,
 * so a value sealed for something else, or copied onto another
 * subscriber's row, never opens. The same as before #470.
 */
export const webhookSecretContext = (webhookId: string): string =>
  `webhook-secret:v1:${webhookId}`;

/**
 * What a secret custom header's sealed value is bound to (#457): its
 * subscriber and the header's name in lower case, so it neither opens on
 * another subscriber's row nor as another header.
 */
export const webhookHeaderContext = (webhookId: string, name: string): string =>
  `webhook-header:v1:${webhookId}:${name.toLowerCase()}`;

/** `WebhookSecrets` under the instance secret key (`SecretSealer`, #470). */
@Injectable()
export class SealedWebhookSecrets extends WebhookSecrets {
  constructor(private readonly sealer: SecretSealer) {
    super();
  }

  seal(secret: string, webhookId: string): string {
    return this.sealer.seal(secret, webhookSecretContext(webhookId));
  }

  open(sealed: string, webhookId: string): string {
    return this.sealer.open(sealed, webhookSecretContext(webhookId));
  }

  sealHeader(value: string, webhookId: string, name: string): string {
    return this.sealer.seal(value, webhookHeaderContext(webhookId, name));
  }

  openHeader(sealed: string, webhookId: string, name: string): string {
    return this.sealer.open(sealed, webhookHeaderContext(webhookId, name));
  }
}

/**
 * The subscribers' sealed secrets (`secret_sealed`, and
 * `previous_secret_sealed` while a rotation's old one still signs), for
 * the instance key's check and rotation (`SealedSecretSource`).
 */
export class WebhookSealedSecretSource extends SealedSecretSource {
  readonly name = 'webhook signing secrets';

  async sample(tx: Transaction, limit: number): Promise<SealedValue[]> {
    const rows = await drizzleOf(tx)
      .select({ id: webhooks.id, sealed: webhooks.secretSealed })
      .from(webhooks)
      .orderBy(asc(webhooks.id))
      .limit(limit);
    return rows.map((row) => ({
      sealed: row.sealed,
      context: webhookSecretContext(row.id),
    }));
  }

  /**
   * Re-seals each subscriber's secret, and its previous one while it still
   * signs; a previous one past its end is cleared (with its end), as it is
   * never used again. A value `reseal` cannot open stays as it is.
   */
  async reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number> {
    const db = drizzleOf(tx);
    const rows = await db
      .select({
        id: webhooks.id,
        current: webhooks.secretSealed,
        previous: webhooks.previousSecretSealed,
        stillSigns: sql<boolean>`coalesce(${webhooks.previousSecretUntil} > now(), false)`,
      })
      .from(webhooks)
      .orderBy(asc(webhooks.id))
      .for('update');
    let count = 0;
    for (const row of rows) {
      const context = webhookSecretContext(row.id);
      const current = reseal({ sealed: row.current, context });
      const stillSigns = row.previous !== null && row.stillSigns;
      const previous =
        stillSigns && row.previous !== null
          ? reseal({ sealed: row.previous, context })
          : undefined;
      const changes: Partial<typeof webhooks.$inferInsert> = {};
      if (current !== undefined) {
        changes.secretSealed = current;
        count++;
      }
      if (previous !== undefined) {
        changes.previousSecretSealed = previous;
        count++;
      } else if (row.previous !== null && !stillSigns) {
        changes.previousSecretSealed = null;
        changes.previousSecretUntil = null;
      }
      if (Object.keys(changes).length === 0) continue;
      await db.update(webhooks).set(changes).where(eq(webhooks.id, row.id));
    }
    return count;
  }
}

/**
 * The subscribers' secret custom header values (#457, `headers`, each
 * secret one's `sealed`), for the instance key's check and rotation.
 */
export class WebhookHeaderSealedSecretSource extends SealedSecretSource {
  readonly name = 'webhook header secrets';

  async sample(tx: Transaction, limit: number): Promise<SealedValue[]> {
    const rows = await drizzleOf(tx)
      .select({ id: webhooks.id, headers: webhooks.headers })
      .from(webhooks)
      .where(sql`${webhooks.headers} @> '[{"secret": true}]'::jsonb`)
      .orderBy(asc(webhooks.id))
      .limit(limit);
    return rows
      .flatMap((row) =>
        storedHeadersOf(row.headers)
          .filter(isSecret)
          .map((h) => ({
            sealed: h.sealed,
            context: webhookHeaderContext(row.id, h.name),
          })),
      )
      .slice(0, limit);
  }

  /** Re-seals every secret header value; one `reseal` cannot open stays as it is. */
  async reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number> {
    const db = drizzleOf(tx);
    const rows = await db
      .select({ id: webhooks.id, headers: webhooks.headers })
      .from(webhooks)
      .where(sql`${webhooks.headers} @> '[{"secret": true}]'::jsonb`)
      .orderBy(asc(webhooks.id))
      .for('update');
    let count = 0;
    for (const row of rows) {
      let changed = false;
      const next = storedHeadersOf(row.headers).map((h) => {
        if (!isSecret(h)) return h;
        const sealed = reseal({
          sealed: h.sealed,
          context: webhookHeaderContext(row.id, h.name),
        });
        if (sealed === undefined) return h;
        changed = true;
        count++;
        return { name: h.name, sealed };
      });
      if (!changed) continue;
      await db
        .update(webhooks)
        .set({ headers: toStoredJson(next) })
        .where(eq(webhooks.id, row.id));
    }
    return count;
  }
}
