import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import {
  allows,
  allowsUnrestricted,
  ANYWHERE,
} from '../../access/core/allows.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import {
  type OutgoingEvent,
  WebhookEventHandler,
} from '../../webhooks/core/webhook-event-handler.js';
import { idempotencyKey } from '../../webhooks/core/webhook-events.js';
import { TRANSLATION_WEBHOOK_EVENTS } from '../translations.webhook-events.js';

const Id = z.string().min(1).max(200);

/** `translation.imported` (#51): the import and the change set it went into. */
const TranslationImported = z.object({
  importId: Id,
  changeSetId: Id.optional(),
});

/**
 * The translations' webhook event (`translations.webhook-events.ts`), `translation.imported`:
 * to an owner holding `translation.manage` and `content.read.draft` (an import lands in a change
 * set, a draft), keyed over the import. It names no content of an audience, so it is not limited.
 *
 * Who covers any owner of a subscriber to it: whoever also holds `content.read.draft` and
 * `translation.manage` restricting nothing.
 */
@Injectable()
export class TranslationWebhookHandler extends WebhookEventHandler {
  readonly group = TRANSLATION_WEBHOOK_EVENTS.group;

  async build(
    event: OutboxEvent,
    owner: Actor,
  ): Promise<OutgoingEvent[] | undefined> {
    if (event.topic !== 'translation.imported') return [];
    const parsed = TranslationImported.safeParse(event.payload);
    if (!parsed.success) return undefined;
    const p = parsed.data;
    if (
      !allows(owner, 'translation.manage', ANYWHERE) ||
      !allows(owner, 'content.read.draft', ANYWHERE)
    ) {
      return [];
    }
    return [
      {
        type: 'translation.imported',
        idempotencyKey: idempotencyKey('translation.imported', p.importId),
        data: {
          importId: p.importId,
          changeSetId: p.changeSetId ?? null,
        },
      },
    ];
  }

  coversAnyOwner(actor: Actor): boolean {
    return (
      allowsUnrestricted(actor, 'content.read.draft') &&
      allowsUnrestricted(actor, 'translation.manage')
    );
  }
}
