/**
 * The flows that change installation-wide state (a setting such as self-approval, #588; an outbox
 * consumer held after a restore, #619; people invited with passwords, #610;
 * who must have a second factor, #611; single sign-on required, #378): every other flow
 * would see it, so they run in the `isolated` project alone, after the others
 * (`playwright.config.ts`, `run.ts`).
 */
export const ISOLATED_SPECS =
  /(self-approval|outbox-restore|password-sign-in|second-factor|enforced-sso)\.spec\.ts$/;
