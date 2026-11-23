import { z } from 'zod';
import { field, text, wholeNumber } from './fields.js';

/** `CCMS_STYLE_REVIEW_*` defaults (#248). */
export const DEFAULT_STYLE_REVIEW_PER_MINUTE = 6;
export const DEFAULT_STYLE_REVIEW_TIMEOUT_MS = 30_000;

/** An `http://` or `https://` URL without credentials, query or fragment; the message never repeats the value. */
export const endpoint = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  }, 'must be an http:// or https:// URL without credentials, query or fragment');

/**
 * The model-based style review's settings (`StyleReviewer`,
 * `src/style-review/`): part of `Env`. Off unless `CCMS_STYLE_REVIEW_URL`
 * is set; `checkStyleReviewEnv` says what goes with it.
 */
export const StyleReviewEnv = z.object({
  /** A chat-completions style endpoint (the full URL a request is posted to). */
  CCMS_STYLE_REVIEW_URL: field(endpoint.optional()),
  /** Sent as `Authorization: Bearer …`; optional (a self-hosted model may need none). Never logged. */
  CCMS_STYLE_REVIEW_API_KEY: field(text.max(4096).optional()),
  /** The model name the endpoint expects. */
  CCMS_STYLE_REVIEW_MODEL: field(text.max(200).optional()),
  /** Reviews one person may ask for per minute, on each server (default 6). */
  CCMS_STYLE_REVIEW_PER_MINUTE: field(
    wholeNumber(1, 600).default(DEFAULT_STYLE_REVIEW_PER_MINUTE),
  ),
  /** How long one review may take, in ms (default 30 s). */
  CCMS_STYLE_REVIEW_TIMEOUT_MS: field(
    wholeNumber(1_000, 300_000).default(DEFAULT_STYLE_REVIEW_TIMEOUT_MS),
  ),
});
export type StyleReviewSettings = z.infer<typeof StyleReviewEnv>;

/** Whether `hostname` (as `URL` gives it) is this machine. */
export function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * The checks across fields, for `Env.superRefine`: a model with the URL,
 * nothing without it, and a key only over `https://` (or to this machine),
 * so it never crosses a network in the clear.
 */
export function checkStyleReviewEnv(
  env: StyleReviewSettings,
  ctx: z.RefinementCtx,
): void {
  const need = (name: keyof StyleReviewSettings, message: string) =>
    ctx.addIssue({ code: 'custom', path: [name], message });
  const url = env.CCMS_STYLE_REVIEW_URL;
  // An invalid URL has its own issue already (the field's check).
  if (url && !URL.canParse(url)) return;
  if (!url) {
    if (env.CCMS_STYLE_REVIEW_MODEL || env.CCMS_STYLE_REVIEW_API_KEY) {
      need(
        'CCMS_STYLE_REVIEW_URL',
        'is required when CCMS_STYLE_REVIEW_MODEL or CCMS_STYLE_REVIEW_API_KEY is set',
      );
    }
    return;
  }
  if (!env.CCMS_STYLE_REVIEW_MODEL) {
    need(
      'CCMS_STYLE_REVIEW_MODEL',
      'is required when CCMS_STYLE_REVIEW_URL is set',
    );
  }
  const { protocol, hostname } = new URL(url);
  if (
    env.CCMS_STYLE_REVIEW_API_KEY &&
    protocol !== 'https:' &&
    !isLoopback(hostname)
  ) {
    need(
      'CCMS_STYLE_REVIEW_URL',
      'must be https:// when CCMS_STYLE_REVIEW_API_KEY is set (http:// only to localhost)',
    );
  }
}
