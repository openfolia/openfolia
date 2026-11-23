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
}

/** The settings as stored, with how often they changed. */
export interface StoredInstallationSettings {
  readonly settings: InstallationSettings;
  /** Counts the changes; 0 before the first. */
  readonly version: number;
  /** When they last changed; null: never. */
  readonly updatedAt: Date | null;
}

/** What an installation that changed nothing has: four eyes. */
export const DEFAULT_INSTALLATION_SETTINGS: InstallationSettings = {
  selfApproval: DEFAULT_SELF_APPROVAL,
};

/** The audit log's subject for every installation settings event. */
export const SETTINGS_SUBJECT = {
  type: 'settings',
  id: 'installation',
} as const;
