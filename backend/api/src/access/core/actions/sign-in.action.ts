import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import {
  type BegunSignIn,
  type IdentityProvider,
  IdentityProviders,
} from '../identity-provider.js';
import type { UnguardedAction } from '../policy.js';
import {
  hashSessionToken,
  SESSION_TOKEN_PATTERN,
  SessionStore,
} from '../sessions.js';

/** An identity provider as the sign-in page lists it. */
export interface OfferedProvider {
  readonly id: string;
  readonly displayName: string | null;
}

/**
 * The identity providers people may sign in with (#37), for the sign-in
 * page's buttons; empty when sign-in is not set up. Anyone may ask: it is
 * read before anyone signs in, and names nothing but the providers.
 */
@Injectable()
export class ListIdentityProvidersAction implements UnguardedAction {
  readonly policy = 'public';

  constructor(private readonly providers: IdentityProviders) {}

  handle({ page }: { page: PageRequest }): Paginated<OfferedProvider> {
    return paginate(
      this.providers.list().map(({ id, displayName }) => ({ id, displayName })),
      page,
    );
  }
}

/**
 * Begins a sign-in with the provider `providerId`: where to send the
 * browser, and what to keep until it comes back. 404 `not-found` for a
 * provider that is not offered.
 */
@Injectable()
export class BeginSignInAction implements UnguardedAction {
  readonly policy = 'public';

  constructor(private readonly providers: IdentityProviders) {}

  handle({ providerId }: { providerId: string }): Promise<BegunSignIn> {
    return this.providerOf(providerId).begin();
  }

  private providerOf(providerId: string): IdentityProvider {
    const provider = this.providers.find(providerId);
    if (!provider) {
      throw new NotFoundError(`No identity provider "${providerId}".`);
    }
    return provider;
  }
}

/** A sign-out's outcome: where to send the browser next, if the provider says. */
export interface SignedOut {
  /** The provider's sign-out address, to end the session there too; undefined for none. */
  readonly signOutUrl: string | undefined;
}

/**
 * Signs out (#37): ends the session of `token` (if it is one, and still
 * running), recorded as `user.sign-out`, and asks its provider where to
 * send the browser to sign out there too (coming back to `returnTo`).
 * Anyone may sign out, also with a session that has ended or none at all:
 * the cookie goes either way, and nothing tells which.
 */
@Injectable()
export class SignOutAction implements UnguardedAction {
  readonly policy = 'public';

  constructor(
    private readonly sessions: SessionStore,
    private readonly providers: IdentityProviders,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({
    token,
    returnTo,
  }: {
    token: string | undefined;
    returnTo: string;
  }): Promise<SignedOut> {
    if (token === undefined || !SESSION_TOKEN_PATTERN.test(token)) {
      return { signOutUrl: undefined };
    }
    const hash = hashSessionToken(token);
    const session = await this.sessions.find(hash);
    if (!session) return { signOutUrl: undefined };
    const ended = await this.unit.run(async (tx) => {
      if (!(await this.sessions.revoke(hash, tx))) return false;
      await this.auditLog.record(
        tx,
        { kind: 'user', id: session.userId, roles: [] },
        {
          action: 'user.sign-out',
          subject: { type: 'user', id: session.userId },
          data: { provider: session.provider },
        },
      );
      return true;
    });
    const provider = ended ? this.providers.find(session.provider) : undefined;
    return {
      signOutUrl: provider ? await provider.signOutUrl(returnTo) : undefined,
    };
  }
}
