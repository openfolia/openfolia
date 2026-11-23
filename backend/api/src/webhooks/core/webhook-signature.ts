import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The header holding the signatures: `t=<unix seconds>,v1=<hex>[,v1=<hex>]`. */
// Compatibility: keeps the working name from before the product was named OpenFolia: receivers check the signature by this header.
export const SIGNATURE_HEADER = 'X-Ccms-Signature';

/** How far a receiver should let a signature's time lie from its clock (the documented recipe). */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * A subscriber's secret: `whsec_` and 64 hex digits (256 bits from the
 * CSPRNG). The prefix lets a secret scanner recognise a leaked one
 * (`^whsec_[0-9a-f]{64}$`).
 */
export const WEBHOOK_SECRET_PATTERN = /^whsec_[0-9a-f]{64}$/;

/** A new secret, from the CSPRNG. */
export function mintWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/**
 * The `v1` signature: HMAC-SHA256, keyed with the whole secret (as shown,
 * `whsec_` included, as UTF-8), over `<timestamp>.<body>` (the timestamp
 * in decimal Unix seconds, a full stop, the raw body bytes), as lowercase
 * hex.
 */
export function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
}

/**
 * The signature header's value for `body` at `timestamp`: one `v1` per
 * secret (the current one first; the previous one too during a rotation's
 * grace period, so a receiver may switch secrets when it likes).
 */
export function signatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): string {
  return [
    `t=${timestamp}`,
    ...secrets.map((s) => `v1=${signWebhook(s, timestamp, body)}`),
  ].join(',');
}

/**
 * The documented recipe, as a receiver runs it (README, "Webhooks"):
 * parse `t` and every `v1` from the header, refuse a `t` further than
 * `toleranceSeconds` from now (a replay), compute the signature over
 * `<t>.<raw body>` with the secret and compare it with each `v1` in
 * constant time. True when one matches.
 */
export function verifyWebhookSignature(
  header: string,
  body: string,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [key, value = ''] = part.trim().split('=', 2);
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === undefined || Math.abs(now - timestamp) > tolerance) {
    return false;
  }
  const expected = Buffer.from(signWebhook(secret, timestamp, body), 'hex');
  return candidates.some((c) =>
    timingSafeEqual(Buffer.from(c, 'hex'), expected),
  );
}
