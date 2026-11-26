import { ConflictError } from '../../base/core/errors.js';
import type { SessionPolicy } from './session-policy.js';

/** 409 `single-sign-on-required` (#378), said alike whoever asks and whoever is asked about. */
export function singleSignOnRequired(): ConflictError {
  return new ConflictError(
    'single-sign-on-required',
    'This installation requires single sign-on: people sign in with the identity provider.',
  );
}

/** Refuses while single sign-on is required, before anything says whether an account exists. */
export async function refuseWhenSingleSignOn(
  policy: SessionPolicy,
): Promise<void> {
  if (await policy.requiresSingleSignOn()) throw singleSignOnRequired();
}
