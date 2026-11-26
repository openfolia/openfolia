import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import type { Actor } from '../actor.js';
import { GroupMappings } from '../group-mappings.js';
import {
  type ExternalIdentity,
  IdentityProviders,
  type PendingSignIn,
} from '../identity-provider.js';
import type { UnguardedAction } from '../policy.js';
import { SessionPolicy } from '../session-policy.js';
import { heldBefore, SessionStart } from '../session-start.js';
import { SignInNotAllowedError } from '../sign-in-rules.js';
import type { HeldBefore } from '../begin-session.js';
import {
  displayNameOf,
  groupsOf,
  userIdBase,
  userIdCandidates,
  verifiedEmailOf,
} from '../sign-in-users.js';
import { SignInLinks } from '../sign-in-links.js';
import { UserIdentities } from '../user-identities.js';
import { addressReplaced, WaysIn } from '../ways-in.js';

/** How many `base-<n>` IDs are tried for a new user before a random suffix. */
const ID_TRIES = 50;

export interface CompleteSignInInput {
  readonly providerId: string;
  /** The query the browser came back from the provider with. */
  readonly callback: URLSearchParams;
  /** What the provider's `begin` gave to keep. */
  readonly pending: PendingSignIn;
  /** The session the browser held before, if any: ended, so a sign-in never adds to it. */
  readonly previousToken?: string;
  /** The second step the browser had open (#611), if any: ended. */
  readonly openStepToken?: string;
  /**
   * What the browser held when it began, for a provider whose answer comes without its cookies
   * (#934); each ended when there is no token of it.
   */
  readonly heldAtBegin?: HeldBefore;
}

/** A sign-in's outcome: a new session, or why there is none. */
export type SignInOutcome =
  | {
      readonly userId: string;
      /** The new session's token, for the cookie; never stored or logged. */
      readonly token: string;
    }
  | {
      /**
       * `user-deactivated`: the person's user is deactivated;
       * `sign-in-not-allowed`: the session policy refuses this provider for them.
       */
      readonly refused: 'user-deactivated' | 'sign-in-not-allowed';
    };

/** Thrown inside the transaction to roll it back; answered as a refusal. */
class Deactivated extends Error {}

/**
 * Finishes a sign-in (#37): the provider checks its answer and says who
 * signed in; this finds their user, or links or creates one, applies their
 * groups' roles and starts a session. In one transaction after the access
 * lock, so two first sign-ins of one person make one user.
 *
 * - **Known identity** (issuer and subject linked before): that user.
 * - **First sign-in**: when a deactivated user has the email address the
 *   provider vouches for (`email_verified`), refused as deactivated: the
 *   provider names that person differently now (#943). Otherwise a user
 *   with that address is linked when the session policy's
 *   `linkByEmail` allows it (by default only a user who has never signed in:
 *   one an admin made, or the seed's first admin), recorded as
 *   `user.identity-link`;
 *   otherwise a new user is made, without direct roles, its ID from the
 *   login name or email address (made unique), recorded as `user.create`.
 * - **Every sign-in**: the name, and an email address the provider vouches
 *   for (when no other user has it), are brought up to date (a new address
 *   ends what was emailed to the old one, `WaysIn.endMailed`); the groups
 *   are stored and the roles they map to applied, each change recorded as
 *   `role.assign` / `role.unassign` with `data.via` `groups`. Direct
 *   assignments are kept. The provider's groups apply as they are, also
 *   when that takes `admin.roles` from the last admin (the provider decides
 *   group membership; give the first admin the role directly).
 * - A deactivated user, or one the session policy refuses (`SessionStart`), gets no session
 *   (and nothing is written). Otherwise the browser's previous session and the second step it
 *   had open (if any) end and a new session starts, recorded as `user.sign-in`.
 *
 * Rejects with `SignInFailedError` when the provider does not accept the
 * answer, and `NotFoundError` for a provider that is not offered.
 */
@Injectable()
export class CompleteSignInAction implements UnguardedAction {
  /** Run before anyone is acting: it is how someone comes to act. */
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly providers: IdentityProviders,
    private readonly admin: AccessAdmin,
    private readonly identities: UserIdentities,
    private readonly mappings: GroupMappings,
    private readonly start: SessionStart,
    private readonly sessionPolicy: SessionPolicy,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly links: SignInLinks,
    private readonly waysIn: WaysIn,
  ) {}

  async handle(input: CompleteSignInInput): Promise<SignInOutcome> {
    const provider = this.providers.find(input.providerId);
    if (!provider) {
      throw new NotFoundError(`No identity provider "${input.providerId}".`);
    }
    const identity = await provider.complete(input.callback, input.pending);
    try {
      return await runContended(
        this.unit,
        (tx) =>
          this.signIn(tx, provider.id, identity, {
            ...input.heldAtBegin,
            ...heldBefore(input),
          }),
        BOUNDED,
      );
    } catch (error) {
      if (error instanceof Deactivated) return { refused: 'user-deactivated' };
      if (error instanceof SignInNotAllowedError) {
        return { refused: 'sign-in-not-allowed' };
      }
      throw error;
    }
  }

  private async signIn(
    tx: Transaction,
    providerId: string,
    identity: ExternalIdentity,
    held: HeldBefore,
  ): Promise<SignInOutcome> {
    await this.admin.lock(tx);
    const groups = groupsOf(identity);
    const email = verifiedEmailOf(identity);
    let userId = await this.identities.userOf(
      tx,
      identity.issuer,
      identity.subject,
    );
    let created = false;
    let linked = false;
    if (userId === undefined) {
      const holder =
        email === null
          ? undefined
          : await this.identities.userWithEmail(tx, email);
      // The address the provider vouches for is a deactivated user's: it is them, named
      // differently now (made again there, another provider), and they stay out (#943).
      const holderUser =
        holder === undefined
          ? undefined
          : await this.admin.findUser(tx, holder);
      if (holderUser !== undefined && holderUser.deactivatedAt !== null) {
        throw new Deactivated();
      }
      if (await this.linkable(tx, providerId, identity, holder)) {
        userId = holder;
        linked = true;
      }
      if (userId === undefined) {
        userId = await this.createUser(tx, identity, email);
        created = true;
      }
      await this.identities.link(tx, {
        issuer: identity.issuer,
        subject: identity.subject,
        userId,
        groups,
      });
      if (linked) {
        await this.auditLog.record(
          tx,
          { kind: 'user', id: userId, roles: [] },
          {
            action: 'user.identity-link',
            subject: { type: 'user', id: userId },
            data: {
              issuer: identity.issuer,
              provider: providerId,
              via: 'email',
            },
          },
        );
        // Their open invite (the first admin's link printed at start-up, #373, or an admin's)
        // is closed: they have signed in, and a link that sets a password stays usable by
        // whoever else holds it. Only on this first sign-in that claims the user. The person
        // before their link (#650), as every change that ends ways in takes them.
        await this.waysIn.holdPerson(tx, userId);
        if ((await this.links.revokeAll(tx, userId, 'invite')) > 0) {
          await this.auditLog.record(
            tx,
            { kind: 'user', id: userId, roles: [] },
            {
              action: 'user.invite-withdraw',
              subject: { type: 'user', id: userId },
              data: { via: 'sign-in', provider: providerId },
            },
          );
        }
      }
    } else {
      await this.identities.recordSignIn(
        tx,
        identity.issuer,
        identity.subject,
        groups,
      );
    }
    const self: Actor = { kind: 'user', id: userId, roles: [] };

    const user = await this.admin.findUser(tx, userId);
    if (!user) throw new NotFoundError(`No user "${userId}".`);
    if (user.deactivatedAt !== null) throw new Deactivated();

    if (!created) {
      const name = displayNameOf(identity, user.name);
      const keepEmail =
        email === null ||
        email.toLowerCase() === user.email?.toLowerCase() ||
        (await this.admin.emailTaken(tx, email, userId));
      const changed = [
        ...(name !== user.name ? ['name'] : []),
        ...(keepEmail ? [] : ['email']),
      ];
      if (changed.length > 0) {
        await this.admin.updateUser(tx, userId, {
          name,
          email: keepEmail ? user.email : email,
        });
        // The provider's new address: what was emailed to the old one ends (#645).
        if (!keepEmail && addressReplaced(user.email, email)) {
          await this.waysIn.endMailed(tx, userId);
        }
        await this.auditLog.record(tx, self, {
          action: 'user.update',
          subject: { type: 'user', id: userId },
          data: { changed, via: providerId },
        });
      }
    }

    const change = await this.mappings.applyGroupRoles(tx, userId);
    for (const [action, roleIds] of [
      ['role.unassign', change.unassigned],
      ['role.assign', change.assigned],
    ] as const) {
      for (const roleId of roleIds) {
        await this.auditLog.record(tx, self, {
          action,
          subject: { type: 'role', id: roleId },
          data: { userId, via: 'groups' },
        });
      }
    }

    const token = await this.start.finish(tx, {
      userId,
      provider: providerId,
      held,
      now: this.now(),
    });
    await this.auditLog.record(tx, self, {
      action: 'user.sign-in',
      subject: { type: 'user', id: userId },
      data: { provider: providerId, created, linked },
    });
    return { userId, token };
  }

  /**
   * Whether a first sign-in links to `holder`, the user with the verified email address, as the
   * session policy allows (`LinkByEmail`); false: a new user.
   */
  private async linkable(
    tx: Transaction,
    providerId: string,
    identity: ExternalIdentity,
    holder: string | undefined,
  ): Promise<boolean> {
    const mode = this.sessionPolicy.linkByEmail(providerId);
    if (holder === undefined || mode === 'off') return false;
    return !(mode === 'pending'
      ? await this.identities.hasAnyIdentity(tx, holder)
      : await this.identities.hasIdentityAt(tx, holder, identity.issuer));
  }

  /** A new user for `identity`, with the first free ID of its candidates. */
  private async createUser(
    tx: Transaction,
    identity: ExternalIdentity,
    email: string | null,
  ): Promise<string> {
    const base = userIdBase(identity);
    const candidates = [
      ...userIdCandidates(base, ID_TRIES),
      `${base}-${crypto.randomUUID().slice(0, 8)}`,
    ];
    // An address another user has stays with them: the new user gets none.
    const ownEmail =
      email !== null && !(await this.admin.emailTaken(tx, email))
        ? email
        : null;
    for (const id of candidates) {
      const name = displayNameOf(identity, id);
      if (await this.admin.insertUser(tx, { id, name, email: ownEmail })) {
        await this.auditLog.record(
          tx,
          { kind: 'user', id, roles: [] },
          {
            action: 'user.create',
            subject: { type: 'user', id },
            data: { via: 'sign-in' },
          },
        );
        return id;
      }
    }
    throw new Error('No free user ID for a new user.');
  }
}
