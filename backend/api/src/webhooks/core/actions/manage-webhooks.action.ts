import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotConfiguredError,
  NotFoundError,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import {
  type Delivery,
  type DeliveryEvent,
  type DeliveryFilter,
  type DeliverySummary,
  isWebhookId,
  MAX_WEBHOOKS,
  newWebhookId,
  normalEvents,
  PING,
  PREVIOUS_SECRET_GRACE_MS,
  WEBHOOK_EVENTS,
  type Webhook,
  type WebhookChanges,
  type WebhookEvent,
  type WebhookOwner,
} from '../webhook.js';
import {
  checkHeaders,
  type HeaderInput,
  headerChanges,
  isSecret,
  type StoredHeader,
} from '../webhook-headers.js';
import { WebhookEventHandlers } from '../webhook-event-handler.js';
import { WebhookSecrets, WebhookSettings } from '../webhook-ports.js';
import { mintWebhookSecret } from '../webhook-signature.js';
import { WebhookStore } from '../webhook-store.js';
import { checkWebhookUrl } from '../webhook-url.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

const notFound = (id: string) => new NotFoundError(`No webhook "${id}".`);

/**
 * A subscriber that exists and `actor` may see (`tx`: locked for it), or
 * 404, exactly like a missing one (`seesWebhook`).
 */
export async function existing(
  store: WebhookStore,
  handlers: WebhookEventHandlers,
  id: string,
  actor: Actor,
  tx?: Parameters<WebhookStore['find']>[1],
): Promise<Webhook> {
  const found = isWebhookId(id) ? await store.find(id, tx) : undefined;
  if (!found || !seesWebhook(handlers, actor, found)) throw notFound(id);
  return found;
}

export const ownerOf = (actor: Actor): WebhookOwner => ({
  kind: actor.kind,
  id: actor.id,
});

/**
 * Whether `actor` may see a subscriber, its URL, events and delivery log:
 * its owner, or a reader whose scope covers any owner of one with its
 * events (`WebhookEventHandlers.coversAnyOwner`). Its events can be
 * changed only by a reader covering both the old and the new ones, so
 * nobody reshapes them to see more.
 */
export function seesWebhook(
  handlers: WebhookEventHandlers,
  actor: Actor,
  webhook: Webhook,
): boolean {
  return (
    sameOwner(webhook.owner, ownerOf(actor)) ||
    handlers.coversAnyOwner(actor, webhook.events)
  );
}

/** 404 `not-configured` while there is no key to seal secrets with. */
export function configured(settings: WebhookSettings): void {
  if (!settings.enabled) {
    throw new NotConfiguredError(
      'Webhooks are off on this server: there is no secret key (CCMS_SECRET_KEY unset and CCMS_SECRET_KEY_GENERATE=false).',
    );
  }
}

/** A URL deliveries may go to, as parsed; 422 `invalid-url` (`meta.problem`) otherwise. */
function checkedUrl(settings: WebhookSettings, raw: string): string {
  const checked = checkWebhookUrl(raw, settings.rules);
  if ('problem' in checked) {
    throw new UnprocessableError(
      'invalid-url',
      checked.problem === 'scheme'
        ? 'A webhook URL must use https.'
        : checked.problem === 'blocked-address'
          ? 'A webhook URL must not point to a private, loopback, link-local or otherwise non-public address.'
          : checked.problem === 'credentials'
            ? 'A webhook URL must not hold a user name or password; the signature authenticates deliveries.'
            : checked.problem === 'fragment'
              ? 'A webhook URL must not have a fragment (#…).'
              : checked.problem === 'too-long'
                ? 'A webhook URL may have at most 2,000 characters.'
                : 'Not an absolute URL.',
      { problem: checked.problem },
    );
  }
  return checked.url;
}

/** Custom headers as the audit log names them: by name, and whether secret; never a value. */
const headerNames = (headers: readonly StoredHeader[]) =>
  headers.map((h) => ({ name: h.name, secret: isSecret(h) }));

/** The host a URL names, for the audit log (never its path or query, which may hold a token). */
export const hostOf = (url: string) => new URL(url).host;

/** A subscriber as a list or a read shows it: with its latest delivery's result (#254). */
export interface ListedWebhook extends Webhook {
  /** Its latest delivery, without its body; null when it has had none (or they were pruned). */
  readonly lastDelivery: DeliverySummary | null;
}

async function withLastDelivery(
  store: WebhookStore,
  webhooks: readonly Webhook[],
): Promise<ListedWebhook[]> {
  const last = await store.lastDeliveries(webhooks.map((w) => w.id));
  return webhooks.map((w) => ({ ...w, lastDelivery: last.get(w.id) ?? null }));
}

/**
 * One page of the subscribers `actor` sees (`seesWebhook`), oldest first,
 * each with its latest delivery's result; never a secret. Needs
 * `webhook.manage`.
 */
@Injectable()
export class ListWebhooksAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<ListedWebhook>
> {
  readonly policy = 'webhook.manage';

  constructor(
    private readonly store: WebhookStore,
    private readonly handlers: WebhookEventHandlers,
  ) {
    super();
  }

  protected async run({
    actor,
    page,
  }: {
    actor: Actor;
    page: PageRequest;
  }): Promise<Paginated<ListedWebhook>> {
    const result = await this.store.list(
      page,
      this.handlers.visibleTo(actor, ownerOf(actor)),
    );
    return {
      total: result.total,
      items: await withLastDelivery(this.store, result.items),
    };
  }
}

/**
 * One subscriber; never its secret. 404 `not-found`, also for one the
 * actor may not see (`seesWebhook`). Needs `webhook.manage`.
 */
@Injectable()
export class GetWebhookAction extends ActorAction<
  { actor: Actor; id: string },
  ListedWebhook
> {
  readonly policy = 'webhook.manage';

  constructor(
    private readonly store: WebhookStore,
    private readonly handlers: WebhookEventHandlers,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    actor: Actor;
    id: string;
  }): Promise<ListedWebhook> {
    const [listed] = await withLastDelivery(this.store, [
      await existing(this.store, this.handlers, id, actor),
    ]);
    return listed!;
  }
}

export interface CreateWebhookInput {
  readonly actor: Actor;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly description: string | null;
  /** Its audience limit (`Webhook.maxAudience`); null or left out: none. */
  readonly maxAudience?: string | null;
  /** Its custom headers (#457); left out: none. */
  readonly headers?: readonly HeaderInput[];
}

/** A subscriber just made or whose secret was just rotated, with the secret, shown this once. */
export interface WithSecret {
  readonly webhook: Webhook;
  /** Never stored as text, logged or audited; it cannot be shown again. */
  readonly secret: string;
}

/**
 * Adds a subscriber, owned by the actor: it hears only of what they may
 * read. Its secret is made from the CSPRNG, stored sealed and answered
 * once. 422 `invalid-url` (`meta.problem`); 409 `too-many-webhooks` past
 * `MAX_WEBHOOKS`; 404 `not-configured` without an encryption key.
 * Recorded as `webhook.create` (its host and events; never the URL's path
 * or query, never the secret). Needs `webhook.manage`.
 */
@Injectable()
export class CreateWebhookAction extends ActorAction<
  CreateWebhookInput,
  WithSecret
> {
  readonly policy = 'webhook.manage';
  /** Makes the secret; the CSPRNG's in the server. */
  mint = mintWebhookSecret;

  constructor(
    private readonly store: WebhookStore,
    private readonly secrets: WebhookSecrets,
    private readonly settings: WebhookSettings,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run(input: CreateWebhookInput): Promise<WithSecret> {
    this.sandbox.refuse('webhooks');
    configured(this.settings);
    const url = checkedUrl(this.settings, input.url);
    const events = normalEvents(input.events);
    const id = newWebhookId();
    const headers = checkHeaders(input.headers ?? [], {
      existing: [],
      seal: (value, name) => this.secrets.sealHeader(value, id, name),
      lengthOf: () => undefined,
      urlChanges: false,
    });
    const secret = this.mint();
    const sealed = this.secrets.seal(secret, id);
    const webhook = await runContended(
      this.unit,
      async (tx) => {
        const made = await this.store.insert(
          tx,
          {
            id,
            url,
            description: input.description,
            events,
            maxAudience: input.maxAudience ?? null,
            owner: { kind: input.actor.kind, id: input.actor.id },
            sealedSecret: sealed,
            headers,
          },
          MAX_WEBHOOKS,
        );
        if (!made) {
          throw new ConflictError(
            'too-many-webhooks',
            `There may be at most ${MAX_WEBHOOKS} webhooks; delete one first.`,
            { max: MAX_WEBHOOKS },
          );
        }
        await this.auditLog.record(tx, input.actor, {
          action: 'webhook.create',
          subject: { type: 'webhook', id: made.id },
          data: {
            host: hostOf(url),
            events,
            ...(made.maxAudience !== null && {
              maxAudience: made.maxAudience,
            }),
            ...(headers.length > 0 && { headers: headerNames(headers) }),
          },
        });
        return made;
      },
      BOUNDED,
    );
    return { webhook, secret };
  }
}

export interface UpdateWebhookInput {
  readonly actor: Actor;
  readonly id: string;
  /** The ID the request's body names: 409 `id-mismatch` unless it is `id`. */
  readonly bodyId?: string;
  /** What changes; its custom headers are given as `headers`, not here. */
  readonly changes: Omit<WebhookChanges, 'headers'>;
  /**
   * Its custom headers, all of them (#457): they replace the stored ones; a
   * secret one left without a value keeps its stored value. Left out: they
   * stay.
   */
  readonly headers?: readonly HeaderInput[];
}

/**
 * Changes a subscriber's URL, events, description, or pauses (`active:
 * false`) and resumes it (`active: true`, which also clears a disabled
 * state and the failures counted); its secret stays.
 *
 * What a subscriber hears of is what its owner may read, sent to its URL.
 * Whoever points it at another URL (one other than the stored one) becomes
 * its owner, so nobody points another's subscriber, and what they may
 * read, at a receiver of their own. Someone else may do that only when
 * their scope covers any owner's (`coversAnyOwner`): a manager with a
 * narrower scope would otherwise narrow, unseen, what an existing
 * subscriber receives (403 `forbidden`; they may still change its events,
 * pause it, resume it or describe it). Changing only the events keeps the
 * owner: what is then sent still follows the owner's scope, to the
 * owner's receiver, so a manager with a wider scope cannot widen what goes
 * to a receiver someone else chose. When the owner changes, the
 * deliveries still pending, made for the old owner, are skipped: their
 * bodies follow the old owner's scope and are never sent to the new URL.
 * So are those built under another audience limit, when it changes (#254).
 * The secret stays (the old owner's receiver knows it): a new owner
 * rotates it.
 *
 * 404 `not-found`; 422 `invalid-url`. Recorded as `webhook.update` (the
 * fields changed; the host when the URL changed; `active` when set; the
 * new owner when it moved; the deliveries skipped when the owner or the
 * audience limit changed). Needs
 * `webhook.manage`.
 */
@Injectable()
export class UpdateWebhookAction extends ActorAction<
  UpdateWebhookInput,
  Webhook
> {
  readonly policy = 'webhook.manage';

  constructor(
    private readonly store: WebhookStore,
    private readonly handlers: WebhookEventHandlers,
    private readonly secrets: WebhookSecrets,
    private readonly settings: WebhookSettings,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    bodyId,
    changes,
    headers: headerInput,
  }: UpdateWebhookInput): Promise<Webhook> {
    this.sandbox.refuse('webhooks');
    if (bodyId !== undefined && bodyId !== id) {
      throw new ConflictError(
        'id-mismatch',
        `The body names the webhook "${bodyId}", the path "${id}".`,
      );
    }
    // Sealing a header value needs the key: 404 `not-configured` without one.
    if (headerInput !== undefined) configured(this.settings);
    const url =
      changes.url === undefined
        ? undefined
        : checkedUrl(this.settings, changes.url);
    const events =
      changes.events === undefined ? undefined : normalEvents(changes.events);
    const owner = ownerOf(actor);
    return runContended(
      this.unit,
      async (tx) => {
        const old = await existing(this.store, this.handlers, id, actor, tx);
        const owns = sameOwner(old.owner, owner);
        const newUrl = url !== undefined && url !== old.url;
        const newEvents =
          events !== undefined && !sameEvents(events, old.events);
        const newAudience =
          changes.maxAudience !== undefined &&
          changes.maxAudience !== old.maxAudience;
        const takesOver = newUrl && !owns;
        // Someone else re-aims or reshapes it (its events or its audience
        // limit) only when their scope covers any owner's of both the old
        // and the new events.
        if (
          !owns &&
          (newUrl || newEvents || newAudience) &&
          !this.handlers.coversAnyOwner(actor, [
            ...old.events,
            ...(events ?? []),
          ])
        ) {
          throw new ForbiddenError(
            'Changing the URL, the events or the audience limit of a webhook someone else owns needs a reading scope that covers what it is sent, before and after.',
          );
        }
        const headers = await this.newHeaders(tx, id, headerInput, newUrl);
        // Its custom headers authenticate deliveries to the owner's
        // receiver, as its secret signs them: only those who may rotate the
        // secret may change them.
        if (
          headers?.write &&
          !owns &&
          !this.handlers.coversAnyOwner(actor, WEBHOOK_EVENTS)
        ) {
          throw new ForbiddenError(
            'Changing the custom headers of a webhook someone else owns needs a reading scope that restricts nothing.',
          );
        }
        const normal: WebhookChanges = {
          ...changes,
          ...(url !== undefined && { url }),
          ...(events !== undefined && { events }),
          ...(takesOver && { owner }),
          ...(headers?.write && { headers: headers.stored }),
        };
        const updated = await this.store.update(tx, id, normal);
        // A new owner or a new audience limit: what waits was built for the
        // old ones, so it is not sent (a narrower limit must not let through
        // what the wider one did).
        const skipped =
          takesOver || newAudience
            ? await this.store.skipPendingNotFor(
                tx,
                id,
                updated.owner,
                updated.maxAudience,
              )
            : 0;
        await this.auditLog.record(tx, actor, {
          action: 'webhook.update',
          subject: { type: 'webhook', id },
          data: {
            fields: Object.keys(normal).sort(),
            ...(url !== undefined && { host: hostOf(url) }),
            ...(events !== undefined && { events }),
            ...(normal.maxAudience !== undefined && {
              maxAudience: normal.maxAudience,
            }),
            ...(normal.active !== undefined && { active: normal.active }),
            ...(takesOver && { owner }),
            ...((takesOver || newAudience) && { skipped }),
            ...(normal.headers !== undefined &&
              headers && { headers: headers.changes }),
          },
        });
        return updated;
      },
      BOUNDED,
    );
  }

  /**
   * The headers to store (checked, secret values sealed) and what changed,
   * by name; undefined when none were given and they may stay. A new URL
   * with secret headers stored needs their values again: a secret is never
   * sent to a receiver it was not given for (422 `header-value-required`).
   */
  private async newHeaders(
    tx: Parameters<WebhookStore['storedHeaders']>[0],
    id: string,
    input: readonly HeaderInput[] | undefined,
    urlChanges: boolean,
  ) {
    if (input === undefined && !urlChanges) return undefined;
    const existing = await this.store.storedHeaders(tx, id);
    if (input === undefined) {
      if (!existing.some(isSecret)) return undefined;
      throw new UnprocessableProblems(
        'invalid-headers',
        'The custom headers cannot be used.',
        [
          {
            code: 'header-value-required',
            detail:
              'Pointing the webhook at another URL needs the value of each secret header again (or the header removed): a secret is never sent to a receiver it was not given for.',
            pointer: '/data/attributes/headers',
          },
        ],
      );
    }
    const stored = checkHeaders(input, {
      existing,
      seal: (value, name) => this.secrets.sealHeader(value, id, name),
      lengthOf: (header) => {
        try {
          return this.secrets.openHeader(header.sealed, id, header.name).length;
        } catch {
          return undefined;
        }
      },
      urlChanges,
    });
    return {
      stored,
      changes: headerChanges(existing, stored),
      // Stored again for any difference, a name's case or the order too.
      write: !sameStoredHeaders(existing, stored),
    };
  }
}

const sameStoredHeaders = (
  a: readonly StoredHeader[],
  b: readonly StoredHeader[],
): boolean =>
  a.length === b.length &&
  a.every((h, i) => {
    const o = b[i];
    if (!o || o.name !== h.name || isSecret(o) !== isSecret(h)) return false;
    return isSecret(h) && isSecret(o)
      ? h.sealed === o.sealed
      : !isSecret(h) && !isSecret(o) && h.value === o.value;
  });

export const sameOwner = (a: WebhookOwner, b: WebhookOwner): boolean =>
  a.kind === b.kind && a.id === b.id;

const sameEvents = (
  a: readonly WebhookEvent[],
  b: readonly WebhookEvent[],
): boolean => {
  const set = new Set(b);
  return a.length === set.size && a.every((e) => set.has(e));
};

/**
 * Deletes a subscriber and its delivery log; deliveries still waiting are
 * not sent. 404 `not-found`. Recorded as `webhook.delete`. Needs
 * `webhook.manage`.
 */
@Injectable()
export class DeleteWebhookAction extends ActorAction<
  { actor: Actor; id: string },
  void
> {
  readonly policy = 'webhook.manage';

  constructor(
    private readonly store: WebhookStore,
    private readonly handlers: WebhookEventHandlers,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({ actor, id }: { actor: Actor; id: string }) {
    await runContended(
      this.unit,
      async (tx) => {
        const webhook = await existing(
          this.store,
          this.handlers,
          id,
          actor,
          tx,
        );
        await this.store.delete(tx, id);
        await this.auditLog.record(tx, actor, {
          action: 'webhook.delete',
          subject: { type: 'webhook', id },
          data: { host: hostOf(webhook.url) },
        });
      },
      BOUNDED,
    );
  }
}

/**
 * Gives a subscriber a new secret, answered once. The one before keeps
 * signing beside it (a second `v1` in the signature header) for
 * `PREVIOUS_SECRET_GRACE_MS` (a day), so a receiver can switch over
 * without losing a delivery; a second rotation within that day drops the
 * oldest at once. Only its owner, or a manager whose scope covers any
 * owner's (`coversAnyOwner`), may rotate it (403 `forbidden`): the secret
 * lets its holder sign what the owner's receiver trusts. 404 `not-found`,
 * `not-configured`. Recorded as
 * `webhook.rotate-secret` (never a secret). Needs `webhook.manage`.
 */
@Injectable()
export class RotateWebhookSecretAction extends ActorAction<
  { actor: Actor; id: string },
  WithSecret
> {
  readonly policy = 'webhook.manage';
  mint = mintWebhookSecret;
  now: () => number = Date.now;

  constructor(
    private readonly store: WebhookStore,
    private readonly handlers: WebhookEventHandlers,
    private readonly secrets: WebhookSecrets,
    private readonly settings: WebhookSettings,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    actor: Actor;
    id: string;
  }): Promise<WithSecret> {
    this.sandbox.refuse('webhooks');
    configured(this.settings);
    const secret = this.mint();
    const sealed = this.secrets.seal(secret, id);
    const until = new Date(this.now() + PREVIOUS_SECRET_GRACE_MS);
    const webhook = await runContended(
      this.unit,
      async (tx) => {
        const old = await existing(this.store, this.handlers, id, actor, tx);
        // The secret signs what goes to the owner's receiver: only they, or
        // a manager covering any owner of any subscriber (not judged by its
        // events, which could be reshaped first), may hold a new one.
        if (
          !sameOwner(old.owner, ownerOf(actor)) &&
          !this.handlers.coversAnyOwner(actor, WEBHOOK_EVENTS)
        ) {
          throw new ForbiddenError(
            'Rotating the secret of a webhook someone else owns needs a reading scope that restricts nothing.',
          );
        }
        const rotated = await this.store.rotateSecret(tx, id, sealed, until);
        await this.auditLog.record(tx, actor, {
          action: 'webhook.rotate-secret',
          subject: { type: 'webhook', id },
          data: { previousSecretUntil: until.toISOString() },
        });
        return rotated;
      },
      BOUNDED,
    );
    return { webhook, secret };
  }
}

/** A delivery as its log shows it: the body only to a reader who may read what it says. */
export interface LoggedDelivery extends Omit<Delivery, 'body'> {
  /** Null: the reader may not see what the owner may (see `ListWebhookDeliveriesAction`). */
  readonly body: string | null;
}

/**
 * Whether `actor` may see the body of a delivery of `event` made for
 * `owner` (the subscriber's owner when the delivery was made, not its
 * owner now): what it holds was filtered by that owner's reading scope, so
 * only that owner themselves, or a reader whose scope
 * covers any owner's (`WebhookEventHandlers.coversAnyOwner`).
 * Fails closed: scopes are not compared otherwise.
 */
export function seesPayload(
  handlers: WebhookEventHandlers,
  actor: Actor,
  owner: WebhookOwner,
  event: DeliveryEvent,
): boolean {
  return (
    sameOwner(actor, owner) ||
    handlers.coversAnyOwner(actor, event === PING ? [] : [event])
  );
}

/**
 * One page of a subscriber's deliveries, newest first. Each body was
 * filtered by the scope of the owner it was made for, so it is shown only where `seesPayload`
 * holds; anyone else holding `webhook.manage` sees the delivery's state,
 * attempts and errors, without its body (`payload: null`). 404
 * `not-found`. Needs `webhook.manage`.
 */
@Injectable()
export class ListWebhookDeliveriesAction extends ActorAction<
  { actor: Actor; id: string; filter: DeliveryFilter; page: PageRequest },
  Paginated<LoggedDelivery>
> {
  readonly policy = 'webhook.manage';

  constructor(
    private readonly store: WebhookStore,
    private readonly handlers: WebhookEventHandlers,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    filter,
    page,
  }: {
    actor: Actor;
    id: string;
    filter: DeliveryFilter;
    page: PageRequest;
  }): Promise<Paginated<LoggedDelivery>> {
    await existing(this.store, this.handlers, id, actor);
    const result = await this.store.listDeliveries(id, filter, page);
    return {
      total: result.total,
      items: result.items.map((d) => ({
        ...d,
        body: seesPayload(this.handlers, actor, d.owner, d.event)
          ? d.body
          : null,
      })),
    };
  }
}
