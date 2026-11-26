import {
  DEFAULT_SECOND_FACTOR_RULE,
  type SecondFactorRuleValue,
} from '../../access/core/second-factors.js';
import {
  type BreakGlassProblem,
  DEFAULT_SIGN_IN_RULE,
  type SignInRule,
} from '../../access/core/sign-in-rules.js';
import {
  DEFAULT_SELF_APPROVAL,
  type SelfApproval,
} from '../../change-sets/core/self-approval.js';

/**
 * The installation's own settings (#588): operational state an administrator (`admin.roles`)
 * changes at once, kept in Postgres. Never in the project configuration in Git: changing that
 * goes through a change set, so a team of one could never approve the change that turns
 * self-approval on.
 */
export interface InstallationSettings {
  /** Who may approve their own change set (`SelfApprovalRule`). */
  readonly selfApproval: SelfApproval;
  /** Who must sign in with a second factor (#611, `SecondFactorRule`). */
  readonly secondFactor: SecondFactorRuleValue;
  /** Whether people must sign in with an identity provider (#378, `SignInRules`). */
  readonly singleSignOn: SignInRule['singleSignOn'];
  /** Who may still sign in with their password then; null: nobody. */
  readonly breakGlassUserId: string | null;
  /** How long a session may go unused; null: the server's own limit. */
  readonly sessionIdleMinutes: number | null;
  /** How long a session lasts; null: the server's own limit. */
  readonly sessionMaxHours: number | null;
}

/** The settings as stored, with how often they changed. */
export interface StoredInstallationSettings {
  readonly settings: InstallationSettings;
  /** Counts the changes; 0 before the first. */
  readonly version: number;
  /** When they last changed; null: never. */
  readonly updatedAt: Date | null;
}

/** What an installation that changed nothing has: four eyes, a second factor and single sign-on by choice. */
export const DEFAULT_INSTALLATION_SETTINGS: InstallationSettings = {
  selfApproval: DEFAULT_SELF_APPROVAL,
  secondFactor: DEFAULT_SECOND_FACTOR_RULE,
  singleSignOn: DEFAULT_SIGN_IN_RULE.singleSignOn,
  breakGlassUserId: null,
  sessionIdleMinutes: null,
  sessionMaxHours: null,
};

/** What the settings about signing in work on, worked out when they are read (#378). */
export interface SignInState {
  /** Whether an identity provider is set up, so single sign-on can be required. */
  readonly singleSignOnAvailable: boolean;
  /** Why the break-glass account could not be used now; null when it could, or there is none. */
  readonly breakGlassProblem: BreakGlassProblem | null;
  /** The server's own session limits, where none is set. */
  readonly serverSessionIdleMinutes: number;
  readonly serverSessionMaxHours: number;
}

/** The settings as shown: stored, and what they work on. */
export interface ShownInstallationSettings extends StoredInstallationSettings {
  readonly signIn: SignInState;
}

/** The audit log's subject for every installation settings event. */
export const SETTINGS_SUBJECT = {
  type: 'settings',
  id: 'installation',
} as const;
