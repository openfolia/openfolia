import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { UserDirectory } from '../../../access/core/user-directory.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import {
  chosen,
  DEFAULT_NOTIFICATION_SETTINGS,
  type DeliveryChoice,
} from '../../../preferences/core/notification-settings.js';
import { PreferenceStore } from '../../../preferences/core/preference-store.js';
import type { ChosenKind } from '../notification.js';
import { UnsubscribeTokens } from '../unsubscribe-tokens.js';

/** A link that is no unsubscribe link this server made, or whose person is gone: 404. */
export class UnsubscribeLinkInvalidError extends NotFoundError {
  override readonly code = 'unsubscribe-link-invalid';
}

/** Who records an unsubscribe: no one signed in, so the notifications' service. */
const UNSUBSCRIBER: Actor = Object.freeze({
  kind: 'service',
  id: 'service:notifications',
  roles: Object.freeze([]),
}) as Actor;

/** What an unsubscribe did. */
export interface Unsubscribed {
  /** Of the kinds the link names, those that send no email now (what the page lists). */
  readonly kinds: readonly ChosenKind[];
  /** Of those, the ones whose email it turned off now (the others sent none already). */
  readonly changed: readonly ChosenKind[];
}

/**
 * The one-click unsubscribe of a notification email (#884): without signing in, the token
 * (`UnsubscribeTokens`) names a person and the kinds the email was about, and each of those
 * that came the way that email did (at once, or in the summary) comes in the app only. Nothing
 * else changes: no other kind, no other setting, no other person; a kind already off or in the
 * app stays as it is, so the link never turns anything on. Recorded as
 * `notification.unsubscribe` when it changed something. Answering it twice changes nothing more.
 * A token this server did not seal, or a person no longer there: 404
 * `unsubscribe-link-invalid`, alike.
 */
@Injectable()
export class UnsubscribeAction implements UnguardedAction {
  readonly policy = 'public';

  constructor(
    private readonly tokens: UnsubscribeTokens,
    private readonly preferences: PreferenceStore,
    private readonly users: UserDirectory,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({ token }: { token: string }): Promise<Unsubscribed> {
    const opened = this.tokens.open(token);
    const user = opened && (await this.users.findUser(opened.userId));
    if (!opened || !user) {
      throw new UnsubscribeLinkInvalidError(
        'This unsubscribe link is not valid (any more).',
      );
    }
    const settings =
      (await this.preferences.read(user.id)).preferences.notifications ??
      DEFAULT_NOTIFICATION_SETTINGS;
    const choices: Partial<Record<ChosenKind, DeliveryChoice>> = {};
    for (const kind of opened.kinds) {
      // Only the way that email came: a summary's link leaves an email at once as it is.
      if (
        chosen(settings, kind) === (opened.mode === 'now' ? 'email' : 'digest')
      ) {
        choices[kind] = 'app';
      }
    }
    const changed = Object.keys(choices) as ChosenKind[];
    if (changed.length > 0) {
      const written = await this.unit.run(async (tx) => {
        const done = await this.preferences.write(
          user.id,
          { notifications: { choices } },
          tx,
        );
        if (done) {
          await this.auditLog.record(tx, UNSUBSCRIBER, {
            action: 'notification.unsubscribe',
            subject: { type: 'user', id: user.id },
            data: { kinds: changed },
          });
        }
        return done;
      }, BOUNDED);
      if (!written) {
        throw new UnsubscribeLinkInvalidError(
          'This unsubscribe link is not valid (any more).',
        );
      }
    }
    // What sends no email now: changed here, or off or in the app already. A kind still emailed
    // another way (an email at once, past the hourly cap in a summary) is not among them.
    const kinds = opened.kinds.filter((kind) => {
      const now = choices[kind] ?? chosen(settings, kind);
      return now !== 'email' && now !== 'digest';
    });
    return { kinds, changed };
  }
}
