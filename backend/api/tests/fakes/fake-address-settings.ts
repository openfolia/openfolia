import type { StableAddressSettings } from '../../src/addresses/core/stable-address.js';

/** Stable address settings for a test: no public URL, no cap, nothing ignored, unless given. */
export function addressSettings(
  settings: Partial<StableAddressSettings> = {},
): StableAddressSettings {
  return {
    publicUrl: undefined,
    maxAccess: 'public',
    ignoredQuery: [],
    sharedMaxAge: 300,
    buildId: 'test-build',
    ...settings,
  };
}
