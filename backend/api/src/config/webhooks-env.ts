import { z } from 'zod';
import { field, flag, wholeNumber } from './fields.js';

/** `CCMS_WEBHOOKS_*` defaults (#42). */
export const DEFAULT_WEBHOOKS_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOKS_KEEP_DAYS = 30;

/**
 * The webhooks' settings (`src/webhooks/`): part of `Env`. Their signing
 * secrets are sealed under the instance secret key (`secret-key-env.ts`).
 */
export const WebhooksEnv = z.object({
  /** How often the outbox is read for new events, in ms (default 3 s; 0: not on a timer). */
  CCMS_WEBHOOKS_POLL_MS: field(wholeNumber(0, 3_600_000).default(3_000)),
  /** One delivery attempt's whole time, in ms (default 10 s, from 1 s to 60 s). */
  CCMS_WEBHOOKS_TIMEOUT_MS: field(
    wholeNumber(1_000, 60_000).default(DEFAULT_WEBHOOKS_TIMEOUT_MS),
  ),
  /** How many days settled deliveries are kept (default 30). */
  CCMS_WEBHOOKS_KEEP_DAYS: field(
    wholeNumber(1, 3_650).default(DEFAULT_WEBHOOKS_KEEP_DAYS),
  ),
  /** Local testing only: also `http://` URLs (default false: https only). */
  CCMS_WEBHOOKS_ALLOW_HTTP: field(flag.default(false)),
  /** Local testing only: also private, loopback and link-local addresses (default false). */
  CCMS_WEBHOOKS_ALLOW_PRIVATE: field(flag.default(false)),
});
export type WebhooksSettings = z.infer<typeof WebhooksEnv>;
