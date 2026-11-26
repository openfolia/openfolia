import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { UserId } from '../../access/core/actor.js';
import { SecretSealer } from '../../base/core/secret-sealer.js';
import { CHOSEN_KINDS, ChosenKind } from './notification.js';

/** What an unsubscribe token is sealed for: nothing else opens it. */
export const UNSUBSCRIBE_CONTEXT = 'notification-unsubscribe:v1';

/** What a token holds: whose settings, and which kinds it may turn email off for. */
const Payload = z.strictObject({
  u: UserId,
  k: z.array(ChosenKind).min(1).max(CHOSEN_KINDS.length),
  /** Whether the email went at once (`now`) or was the summary: only that way stops. */
  m: z.enum(['now', 'digest']),
});

/** An opened token. */
export interface Unsubscribe {
  readonly userId: string;
  readonly kinds: readonly ChosenKind[];
  /** How the email went: `now` stops the kinds' email at once, `digest` their summary. */
  readonly mode: 'now' | 'digest';
}

/**
 * The one-click unsubscribe tokens of notification emails (#884): the person and the kinds
 * the email was about, sealed under the instance secret key (authenticated encryption, its own
 * context), so a token is unreadable, cannot be changed or made up, and opens for nothing else.
 * It carries no time limit: an email's link keeps working. After the instance key is replaced,
 * tokens sealed under the old one no longer open.
 */
@Injectable()
export class UnsubscribeTokens {
  constructor(private readonly sealer: SecretSealer) {}

  issue(
    userId: string,
    kinds: readonly ChosenKind[],
    mode: 'now' | 'digest',
  ): string {
    const payload = Payload.parse({
      u: userId,
      k: [...new Set(kinds)],
      m: mode,
    });
    return Buffer.from(
      this.sealer.seal(JSON.stringify(payload), UNSUBSCRIBE_CONTEXT),
    ).toString('base64url');
  }

  /** The token's person and kinds; undefined for anything that is not a token this key sealed. */
  open(token: string): Unsubscribe | undefined {
    if (!/^[A-Za-z0-9_-]{20,1000}$/.test(token)) return undefined;
    try {
      const sealed = Buffer.from(token, 'base64url').toString('utf8');
      const parsed = Payload.safeParse(
        JSON.parse(this.sealer.open(sealed, UNSUBSCRIBE_CONTEXT)),
      );
      return parsed.success
        ? {
            userId: parsed.data.u,
            kinds: parsed.data.k,
            mode: parsed.data.m,
          }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
