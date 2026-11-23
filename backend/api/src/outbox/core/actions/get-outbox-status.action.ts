import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ActorAction } from '../../../access/core/policy.js';
import { OutboxFeed } from '../outbox-feed.js';

/** Who reads whether the outbox holds its consumers: administrators (`admin.roles`), as for the jobs. */
export const READ_OUTBOX_STATUS = 'admin.roles' satisfies Permission;

export interface OutboxStatusReport {
  /** The consumers held after a restore onto another database server, by name. */
  readonly blocked: readonly string[];
  readonly level: 'ok' | 'error';
}

/**
 * Whether the outbox's consumers (notifications, webhooks, the change
 * feed) read on (#619): those latched `blocked` after a restore onto
 * another database server read nothing until the operator's recipe
 * clears them (README, "Outbox", "After a restore"). Names only.
 */
@Injectable()
export class GetOutboxStatusAction extends ActorAction<
  { actor: Actor },
  OutboxStatusReport
> {
  readonly policy = READ_OUTBOX_STATUS;

  constructor(private readonly feed: OutboxFeed) {
    super();
  }

  protected async run(): Promise<OutboxStatusReport> {
    const blocked = await this.feed.blocked();
    return { blocked, level: blocked.length > 0 ? 'error' : 'ok' };
  }
}
