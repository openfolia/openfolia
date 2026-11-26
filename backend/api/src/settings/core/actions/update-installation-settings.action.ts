import { Injectable, Logger } from '@nestjs/common';
import { AccessAdmin } from '../../../access/core/access-admin.js';
import { beginAccessChange } from '../../../access/core/access-changes.js';
import type { Actor } from '../../../access/core/actor.js';
import { PASSWORD_PROVIDER } from '../../../access/core/passwords.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  coveredBySecondFactor,
  SecondFactors,
} from '../../../access/core/second-factors.js';
import { IdentityProviders } from '../../../access/core/identity-provider.js';
import {
  recordBreakGlassUse,
  SignInEvents,
} from '../../../access/core/sign-in-events.js';
import {
  EndRefusedSignIns,
  recordEnded,
  RefusedSignIns,
  sessionLimitsOf,
} from '../../../access/core/refused-sign-ins.js';
import {
  signInAllowed,
  type SignInRule,
  SignInRules,
  SignInSetup,
} from '../../../access/core/sign-in-rules.js';
import type { AuditActionName } from '../../../audit/core/audit-actions.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ContendedError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { SecretSealer } from '../../../base/core/secret-sealer.js';
import {
  BOUNDED,
  runContended,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import {
  type InstallationSettings,
  SETTINGS_SUBJECT,
  type ShownInstallationSettings,
  type StoredInstallationSettings,
} from '../installation-settings.js';
import { InstallationSettingsStore } from '../installation-settings-store.js';
import { SignInStates } from '../sign-in-state.js';

export interface UpdateInstallationSettingsInput {
  readonly actor: Actor;
  /** How the acting person's session began; undefined for none. */
  readonly provider?: string | undefined;
  /** The acting person's own session, by hash; undefined for none. */
  readonly sessionHash?: string | undefined;
  /** The settings to change; left out stays. */
  readonly changes: Partial<InstallationSettings>;
}

/** The settings a change of which changes who may sign in, or for how long (#378). */
const SIGN_IN_SETTINGS = [
  'singleSignOn',
  'breakGlassUserId',
  'sessionIdleMinutes',
  'sessionMaxHours',
] as const;

/** The settings audited one by one; the session limits are one event. */
const AUDITED = [
  ['selfApproval', 'settings.self-approval'],
  ['secondFactor', 'settings.second-factor'],
  ['singleSignOn', 'settings.single-sign-on'],
  ['breakGlassUserId', 'settings.break-glass'],
] as const;

/** Whether the change from `settings` to `next` requires single sign-on. */
const requiring = (
  settings: InstallationSettings,
  next: InstallationSettings,
) =>
  next.singleSignOn !== 'optional' &&
  next.singleSignOn !== settings.singleSignOn;

/** How often a change is begun anew because another came between. */
const TRIES = 3;

/** Thrown at a change of the session limits that leaves the idle one the longer. */
const limitsCrossed = () =>
  new UnprocessableError(
    'session-limits-crossed',
    'A session cannot go unused for longer than it lasts; choose a shorter idle time or a longer lifetime.',
  );

/** The session limits as the audit log records them. */
const limitsOf = (settings: InstallationSettings) => ({
  idleMinutes: settings.sessionIdleMinutes,
  maxHours: settings.sessionMaxHours,
});

/**
 * Changes the installation's settings (#588), at once and one change at a time (the row is
 * locked). Each setting changed is audited on its own, as `settings.<setting>` with `from` and
 * `to` (`settings.self-approval`). A change that changes nothing is answered as it is, with no
 * event. Approvals already given stay whatever the new self-approval rule says: it is read when
 * an approval is given. Needs `admin.roles`.
 *
 * Requiring a second factor (#611) never locks everyone out: it needs the instance secret key
 * the secrets are sealed with (409 `second-factor-unavailable`), and an administrator who signs
 * in with a password or a code by email must have theirs on (409 `second-factor-own-first`), so
 * it is known to work here and someone can sign in with it. Sessions already running go on;
 * everyone without one sets it up at their next sign-in.
 *
 * Neither does requiring single sign-on (#378): an identity provider must answer now (409
 * `single-sign-on-unavailable`), and the acting administrator's own session must be one that may
 * go on (409 `single-sign-on-own-first`): begun at a provider, or the break-glass account's. The
 * same is asked when the break-glass account changes while it is required. That account is an
 * active administrator's with a password (422 `break-glass-not-usable`, `meta.problem`). What was
 * begun another way ends at once; so does what is past new session limits, and what already was
 * past the old ones never comes back with longer ones (`EndRefusedSignIns`). What the break-glass
 * account's password opened before ends with the change too, but for the session it is made with:
 * that one is recorded as a use of it, as every later one is when it begins.
 *
 * Who acts still holds `admin.roles` when one of these changes (`beginAccessChange`): the provider
 * is asked first, which may take a while.
 */
@Injectable()
export class UpdateInstallationSettingsAction extends ActorAction<
  UpdateInstallationSettingsInput,
  ShownInstallationSettings
> {
  readonly policy = 'admin.roles';
  private readonly log = new Logger('Settings');

  constructor(
    private readonly store: InstallationSettingsStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly factors: SecondFactors,
    private readonly sealer: SecretSealer,
    private readonly states: SignInStates,
    private readonly rules: SignInRules,
    private readonly setup: SignInSetup,
    private readonly providers: IdentityProviders,
    private readonly refused: EndRefusedSignIns,
    private readonly signIns: RefusedSignIns,
    private readonly admin: AccessAdmin,
    private readonly events: SignInEvents,
  ) {
    super();
  }

  protected async run(
    input: UpdateInstallationSettingsInput,
  ): Promise<ShownInstallationSettings> {
    for (let tries = 0; tries < TRIES; tries++) {
      const written = await this.attempt(input);
      if (written) return this.states.show(written);
    }
    throw new ContendedError();
  }

  /** Null: another change came between, so what it refused may not have been ended. */
  private async attempt(
    input: UpdateInstallationSettingsInput,
  ): Promise<StoredInstallationSettings | null> {
    const before = await this.store.read();
    const next = { ...before.settings, ...input.changes };
    const signIn = SIGN_IN_SETTINGS.some(
      (setting) => next[setting] !== before.settings[setting],
    );
    // Asked of the provider before anything is locked: it is another server.
    const working =
      requiring(before.settings, next) && (await this.providerWorks());
    if (signIn) await this.refused.run(input.actor);
    const written = await this.change(input, before, working, signIn);
    if (written && signIn) {
      try {
        await this.refused.run(input.actor);
      } catch (error) {
        // Each is refused at its next use all the same (`SessionPolicy`).
        this.log.error(
          `The rule about signing in changed; what it refuses could not be ended yet: ${error instanceof Error ? `${error.name}: ${error.message.split('\n', 1)[0]}` : 'unknown error'}`,
        );
      }
    }
    return written;
  }

  private change(
    { actor, provider, sessionHash, changes }: UpdateInstallationSettingsInput,
    before: StoredInstallationSettings,
    working: boolean,
    signIn: boolean,
  ): Promise<StoredInstallationSettings | null> {
    return runContended(
      this.unit,
      async (tx) => {
        if (signIn) await beginAccessChange(this.admin, tx, actor);
        const named = { ...before.settings, ...changes }.breakGlassUserId;
        if (signIn && named !== null) await this.signIns.hold(tx, named);
        const current = await this.store.lock(tx);
        if (current.version !== before.version) return null;
        const { settings } = current;
        const next: InstallationSettings = { ...settings, ...changes };
        const changed = (setting: keyof InstallationSettings) =>
          next[setting] !== settings[setting];
        const limits =
          changed('sessionIdleMinutes') || changed('sessionMaxHours');
        if (
          !limits &&
          !(Object.keys(next) as (keyof InstallationSettings)[]).some(changed)
        ) {
          return current;
        }
        if (changed('secondFactor') && next.secondFactor !== 'optional') {
          await this.mayRequire(tx, actor, provider);
        }
        if (changed('singleSignOn') || changed('breakGlassUserId')) {
          await this.maySignInBy(tx, settings, next, {
            actor,
            provider,
            working,
          });
        }
        if (limits) {
          const { idleMs, maxMs } = sessionLimitsOf(
            { ...next, breakGlass: null },
            this.setup,
          );
          if (idleMs > maxMs) throw limitsCrossed();
        }
        if (requiring(settings, next) && named !== null) {
          const ended = await this.signIns.endPasswordsOf(
            tx,
            named,
            sessionHash,
          );
          await recordEnded(this.auditLog, tx, actor, ended);
          if (actor.id === named && provider === PASSWORD_PROVIDER) {
            await recordBreakGlassUse(this.auditLog, this.events, tx, named);
          }
        }
        const written = await this.store.write(tx, next);
        const record = (action: AuditActionName, from: unknown, to: unknown) =>
          this.auditLog.record(tx, actor, {
            action,
            subject: SETTINGS_SUBJECT,
            data: { from, to },
          });
        for (const [setting, action] of AUDITED) {
          if (changed(setting)) {
            await record(action, settings[setting], next[setting]);
          }
        }
        if (limits) {
          await record(
            'settings.session-limits',
            limitsOf(settings),
            limitsOf(next),
          );
        }
        return written;
      },
      BOUNDED,
    );
  }

  /** Whether some identity provider answers now. */
  private async providerWorks(): Promise<boolean> {
    for (const provider of this.providers.list()) {
      try {
        await provider.answersNow();
        return true;
      } catch (error) {
        this.log.warn(
          `Identity provider ${provider.id} does not answer: ${error instanceof Error ? error.message.split('\n', 1)[0] : 'unknown error'}`,
        );
      }
    }
    return false;
  }

  /** Whether signing in may be as `next` says: nobody is locked out by it. */
  private async maySignInBy(
    tx: Transaction,
    settings: InstallationSettings,
    next: InstallationSettings,
    by: {
      readonly actor: Actor;
      readonly provider: string | undefined;
      readonly working: boolean;
    },
  ): Promise<void> {
    const turnedOn = requiring(settings, next);
    const userId = next.breakGlassUserId;
    const problem =
      userId === null ? null : await this.rules.breakGlassProblem(userId, tx);
    if (
      problem !== null &&
      (turnedOn || userId !== settings.breakGlassUserId)
    ) {
      throw new UnprocessableError(
        'break-glass-not-usable',
        'This account could not be signed in to: it must be an active administrator’s, of their own and not through a group, with a password.',
        { problem },
      );
    }
    if (next.singleSignOn === 'optional') return;
    if (turnedOn && !by.working) {
      throw new ConflictError(
        'single-sign-on-unavailable',
        'Single sign-on cannot be required: no identity provider answers now.',
      );
    }
    const rule: SignInRule = {
      ...next,
      breakGlass:
        userId === null || problem === 'no-such-user'
          ? null
          : { userId, problem },
    };
    // Without a session (demo mode; a token is refused before this), only what keeps it: no turning on.
    const allowed =
      by.provider === undefined
        ? !turnedOn
        : signInAllowed(rule, this.setup.offered, by.actor.id, by.provider);
    if (!allowed) {
      throw new ConflictError(
        'single-sign-on-own-first',
        'Sign in with the identity provider first, or name the account you are signed in with, so that nobody is locked out.',
      );
    }
  }

  /** Whether a second factor may be required: people can set one up, and the admin has theirs. */
  private async mayRequire(
    tx: Transaction,
    actor: Actor,
    provider: string | undefined,
  ): Promise<void> {
    if (!this.sealer.available) {
      throw new ConflictError(
        'second-factor-unavailable',
        'Two-factor sign-in needs the instance secret key, which this server has none of.',
      );
    }
    if (actor.kind !== 'user' || !coveredBySecondFactor(provider)) return;
    const own = await this.factors.find(actor.id, tx);
    if (!own || own.confirmedAt === null) {
      throw new ConflictError(
        'second-factor-own-first',
        'Turn on two-factor sign-in for yourself first, in the account menu.',
      );
    }
  }
}
