import type { TranslatedText } from '@openfolia/ui/i18n';

import type { Item, Schema } from '../../api';
import { apiErrorText } from '../../i18n';
import type { Me } from '../../permissions/me';

export type WebhookItem = Item<'/webhooks'>;
export type DeliveryItem = Item<'/webhooks/{webhookId}/deliveries'>;
export type WebhookEvent =
  Schema<'WebhookResource'>['attributes']['events'][number];
export type DeliveryEvent = DeliveryItem['attributes']['event'];
export type DeliveryStatus = DeliveryItem['attributes']['status'];
export type LastDelivery = NonNullable<WebhookItem['meta']['lastDelivery']>;

/**
 * What the person reads about a failed webhook call: `not-configured` (the server has no secret
 * key to seal the secrets with, only possible with key generation turned off, #470) says that
 * webhooks are off, never the generic not-found; anything else as every call says it.
 */
export function webhookErrorText(
  error: Parameters<typeof apiErrorText>[0],
): TranslatedText {
  return error.code === 'not-configured'
    ? { key: 'editor.admin.webhooks.notConfigured' }
    : apiErrorText(error);
}

/** The events a subscriber may be sent, in the API's order (`GET /webhooks`, `events`). */
export const WEBHOOK_EVENTS = [
  'manual.released',
  'module.released',
  'module.deprecated',
  'manual.deprecated',
  'release.withdrawn',
  'translation.imported',
] as const satisfies readonly WebhookEvent[];

/** What a delivery log may be filtered by: those events, and the test event. */
export const DELIVERY_EVENTS = [
  ...WEBHOOK_EVENTS,
  'ping',
] as const satisfies readonly DeliveryEvent[];

export const DELIVERY_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'skipped',
] as const satisfies readonly DeliveryStatus[];

/** Page sizes of the subscribers list. */
export const WEBHOOK_PAGE_SIZES = [10, 25, 50] as const;
/** Deliveries on one page of the log. */
export const DELIVERY_PAGE_SIZE = 10;
/** The API's limits. */
export const URL_MAX = 2000;
export const DESCRIPTION_MAX = 500;

/** How a subscriber stands: sending, paused by hand, or turned off after failing. */
export type WebhookState = 'active' | 'paused' | 'failing';

export function webhookState(webhook: WebhookItem): WebhookState {
  if (webhook.attributes.active) return 'active';
  return webhook.meta.disabledReason === 'failing' ? 'failing' : 'paused';
}

/** What the card names a subscriber by: its description, else its URL's host. */
export function webhookName(webhook: WebhookItem): string {
  const description = webhook.attributes.description?.trim();
  if (description) return description;
  try {
    return new URL(webhook.attributes.url).host;
  } catch {
    return webhook.attributes.url;
  }
}

/**
 * Why a URL would be refused, checked as the API checks it before sending (its `invalid-url`
 * problems), or null when it may be sent. Two things the API takes only where it is set up for
 * local testing pass with a warning instead: `http:` (`insecure`) and a local name such as
 * `localhost` (`local`); elsewhere the API refuses them itself. Whether a host resolves to a
 * private address is the API's to decide (it resolves it).
 */
export type UrlProblem =
  | 'empty'
  | 'not-a-url'
  | 'scheme'
  | 'credentials'
  | 'fragment'
  | 'too-long'
  | 'blocked-address';

export interface UrlCheck {
  readonly problem: UrlProblem | null;
  readonly insecure: boolean;
  readonly local: boolean;
}

const refused = (problem: UrlProblem): UrlCheck => ({
  problem,
  insecure: false,
  local: false,
});

export function checkUrl(raw: string): UrlCheck {
  const text = raw.trim();
  if (!text) return refused('empty');
  if (text.length > URL_MAX) return refused('too-long');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refused('not-a-url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return refused('scheme');
  }
  if (url.username || url.password) return refused('credentials');
  if (text.includes('#')) return refused('fragment');
  if (!url.hostname) return refused('not-a-url');
  if (url.href.length > URL_MAX) return refused('too-long');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return {
    problem: null,
    insecure: url.protocol === 'http:',
    local:
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal'),
  };
}

/** A subscriber as the form edits it. */
export interface WebhookDraft {
  readonly url: string;
  readonly description: string;
  readonly events: readonly WebhookEvent[];
  /** An audience level's ID; '' for none. */
  readonly maxAudience: string;
  /** Its custom headers (#457), in order. */
  readonly headers: readonly HeaderDraft[];
}

/** Whether `me` owns the subscriber. */
export function owns(me: Me, webhook: WebhookItem): boolean {
  const owner = webhook.attributes.owner;
  return owner.kind === me.kind && owner.id === me.id;
}

/**
 * Whether `me` reads at least what any owner of a subscriber to `events` could, as the API judges
 * a manager changing someone else's subscriber (`coversAnyOwner`): `content.read` in a role whose
 * scope restricts nothing, and for imports also `content.read.draft` and `translation.manage`.
 * The API decides again; this only says what to offer.
 */
export function coversAnyOwner(
  me: Me,
  events: readonly WebhookEvent[],
): boolean {
  const all = me.unrestricted ?? new Set<string>();
  return (
    all.has('content.read') &&
    (!events.includes('translation.imported') ||
      (all.has('content.read.draft') && all.has('translation.manage')))
  );
}

/** Whether `me` may change the subscriber's URL, events and audience limit. */
export function mayReshape(me: Me, webhook: WebhookItem): boolean {
  return owns(me, webhook) || coversAnyOwner(me, webhook.attributes.events);
}

/** Whether `me` may rotate its secret: its owner, or a manager covering any owner of any. */
export function mayRotate(me: Me, webhook: WebhookItem): boolean {
  return owns(me, webhook) || coversAnyOwner(me, WEBHOOK_EVENTS);
}

/**
 * The audience levels a limit lets through: `max` and every less restricted one, in the
 * configuration's order (least restricted first); every level without a limit. A level the
 * configuration no longer holds lets nothing through, as the API judges it.
 */
export function audiencesUpTo<T extends { readonly id: string }>(
  audiences: readonly T[],
  max: string | null,
): readonly T[] {
  if (max === null) return audiences;
  const at = audiences.findIndex((a) => a.id === max);
  return at === -1 ? [] : audiences.slice(0, at + 1);
}

/** The text of each URL problem (keys written out: the translation check finds them). */
export const URL_PROBLEM_TEXT: Readonly<Record<UrlProblem, string>> = {
  empty: 'editor.admin.webhooks.url.empty',
  'not-a-url': 'editor.admin.webhooks.url.notAUrl',
  scheme: 'editor.admin.webhooks.url.scheme',
  credentials: 'editor.admin.webhooks.url.credentials',
  fragment: 'editor.admin.webhooks.url.fragment',
  'too-long': 'editor.admin.webhooks.url.tooLong',
  'blocked-address': 'editor.admin.webhooks.url.blockedAddress',
};

/** The text of an `invalid-url` problem the API names; an unknown one reads as not a URL. */
export function urlProblemText(problem: unknown): string {
  return typeof problem === 'string' && problem in URL_PROBLEM_TEXT
    ? URL_PROBLEM_TEXT[problem as UrlProblem]
    : URL_PROBLEM_TEXT['not-a-url'];
}

/** What each event is about, for the form. */
export const EVENT_TEXT: Readonly<Record<WebhookEvent, string>> = {
  'manual.released': 'editor.admin.webhooks.events.manualReleased',
  'module.released': 'editor.admin.webhooks.events.moduleReleased',
  'module.deprecated': 'editor.admin.webhooks.events.moduleDeprecated',
  'manual.deprecated': 'editor.admin.webhooks.events.manualDeprecated',
  'release.withdrawn': 'editor.admin.webhooks.events.releaseWithdrawn',
  'translation.imported': 'editor.admin.webhooks.events.translationImported',
};

/** A delivery's state in words. */
export const STATUS_TEXT: Readonly<Record<DeliveryStatus, string>> = {
  pending: 'editor.admin.webhooks.status.pending',
  succeeded: 'editor.admin.webhooks.status.succeeded',
  failed: 'editor.admin.webhooks.status.failed',
  skipped: 'editor.admin.webhooks.status.skipped',
};

export type DeliveryError = NonNullable<
  DeliveryItem['attributes']['lastError']
>;

/** Why an attempt failed, in words. */
export const ERROR_TEXT: Readonly<Record<DeliveryError, string>> = {
  'http-status': 'editor.admin.webhooks.errors.httpStatus',
  timeout: 'editor.admin.webhooks.errors.timeout',
  connection: 'editor.admin.webhooks.errors.connection',
  'blocked-address': 'editor.admin.webhooks.errors.blockedAddress',
  'blocked-url': 'editor.admin.webhooks.errors.blockedUrl',
  'secret-unreadable': 'editor.admin.webhooks.errors.secretUnreadable',
};

/** How a delivery's dot reads (always with a word beside it, never by colour alone). */
export type DeliveryTone = 'success' | 'warning' | 'destructive' | 'muted';

export function deliveryTone(
  delivery: Pick<LastDelivery, 'status' | 'attempts'>,
): DeliveryTone {
  switch (delivery.status) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'pending':
      return delivery.attempts > 0 ? 'warning' : 'muted';
    default:
      return 'muted';
  }
}

/** The JSON body as the log shows it: indented. */
export const prettyJson = (value: unknown): string =>
  JSON.stringify(value, null, 2);

/** A custom header as the API shows it (#457): a secret one never with its value. */
export type WebhookHeader = WebhookItem['attributes']['headers'][number];

/**
 * The API's limits for custom headers (`GET /webhooks`, `meta.headerLimits`). Each is typed as the
 * API's own literal, so a change there fails the type check here until it is taken over.
 */
type HeaderLimits = Schema<'WebhookHeaderLimits'>;
export const HEADERS_MAX: HeaderLimits['maxHeaders'] = 20;
export const HEADER_NAME_MAX: HeaderLimits['maxHeaderName'] = 100;
export const HEADERS_SIZE_MAX: HeaderLimits['maxHeadersSize'] = 8192;

/**
 * Names whose value is a credential, compared in lower case: typing one turns "Secret" on (it can
 * still be turned off), so a pasted token is not shown in plain text.
 */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-secret',
]);

/** Whether a header name is one whose value is a credential (`SENSITIVE_HEADER_NAMES`). */
export const sensitiveHeaderName = (name: string): boolean =>
  SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase());

/**
 * A custom header as the form edits it. `kept`: a secret one stored already whose value stays
 * (shown as "Set"; the form never knows it); replacing it clears `kept` and asks for a new value.
 */
export interface HeaderDraft {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly kept: boolean;
}

/** The form's rows for a subscriber's stored headers. */
export const headerDrafts = (
  headers: readonly WebhookHeader[],
): HeaderDraft[] =>
  headers.map((h) => ({
    name: h.name,
    value: h.value ?? '',
    secret: h.secret,
    kept: h.secret,
  }));

/**
 * Names the API refuses (what the server sets, or what would break the delivery or its
 * signature), compared in lower case, and the prefixes it refuses. The API decides again.
 */
export const REFUSED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'cookie',
  'user-agent',
  'idempotency-key',
]);
const REFUSED_HEADER_PREFIXES = ['x-ccms-', 'proxy-'];

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\x21-\x7e](?:[\t\x20-\x7e]*[\x21-\x7e])?$/;

/**
 * What is wrong with one header row, checked as the API checks it (`invalid-headers`), or null.
 * `value-again`: a secret one kept while the URL changes; the API sends a secret only to the
 * receiver it was given for, so it needs the value again.
 */
export type HeaderProblem =
  | 'name-invalid'
  | 'name-refused'
  | 'name-duplicate'
  | 'value-invalid'
  | 'value-required'
  | 'value-again';

export function headerProblems(
  drafts: readonly HeaderDraft[],
  urlChanged: boolean,
): (HeaderProblem | null)[] {
  const seen = new Set<string>();
  return drafts.map((d) => {
    const name = d.name.trim();
    const lower = name.toLowerCase();
    const twice = seen.has(lower);
    seen.add(lower);
    if (!HEADER_TOKEN.test(name) || name.length > HEADER_NAME_MAX) {
      return 'name-invalid';
    }
    if (
      REFUSED_HEADER_NAMES.has(lower) ||
      REFUSED_HEADER_PREFIXES.some((p) => lower.startsWith(p))
    ) {
      return 'name-refused';
    }
    if (twice) return 'name-duplicate';
    if (d.kept) return urlChanged ? 'value-again' : null;
    const value = d.value.trim();
    if (!value) return 'value-required';
    return HEADER_VALUE.test(value) ? null : 'value-invalid';
  });
}

/** Whether the rows say something other than what is stored (the order counts). */
export function headersChanged(
  drafts: readonly HeaderDraft[],
  stored: readonly WebhookHeader[],
): boolean {
  return (
    drafts.length !== stored.length ||
    drafts.some((d, i) => {
      const s = stored[i];
      return (
        !s ||
        d.name.trim() !== s.name ||
        d.secret !== s.secret ||
        (d.secret ? !d.kept : d.value.trim() !== (s.value ?? ''))
      );
    })
  );
}

/** The rows as the API takes them: a kept secret one without its value (its stored one stays). */
export const headersBody = (drafts: readonly HeaderDraft[]) =>
  drafts.map((d) =>
    d.kept
      ? { name: d.name.trim(), secret: true }
      : { name: d.name.trim(), value: d.value.trim(), secret: d.secret },
  );

/** What is wrong with the rows together, or null: too many, or names and values too long. */
export type HeadersProblem = 'too-many' | 'too-large';

/**
 * Checked as the API checks it (`too-many-headers`, `headers-too-large`). A kept secret value is
 * not known here, so only its name counts: the API checks the whole again.
 */
export function headersProblem(
  drafts: readonly HeaderDraft[],
): HeadersProblem | null {
  if (drafts.length > HEADERS_MAX) return 'too-many';
  const size = drafts.reduce(
    (sum, d) =>
      sum + d.name.trim().length + (d.kept ? 0 : d.value.trim().length),
    0,
  );
  return size > HEADERS_SIZE_MAX ? 'too-large' : null;
}

/** The text of each problem of the rows together, with the limit it names. */
export function headersProblemText(problem: HeadersProblem): TranslatedText {
  return problem === 'too-many'
    ? {
        key: 'editor.admin.webhooks.headers.problems.tooMany',
        params: { max: HEADERS_MAX },
      }
    : {
        key: 'editor.admin.webhooks.headers.problems.tooLarge',
        params: { max: HEADERS_SIZE_MAX },
      };
}

/** The text of each header problem, the form's and the API's codes (keys written out). */
export const HEADER_PROBLEM_TEXT: Readonly<Record<HeaderProblem, string>> = {
  'name-invalid': 'editor.admin.webhooks.headers.problems.nameInvalid',
  'name-refused': 'editor.admin.webhooks.headers.problems.nameRefused',
  'name-duplicate': 'editor.admin.webhooks.headers.problems.nameDuplicate',
  'value-invalid': 'editor.admin.webhooks.headers.problems.valueInvalid',
  'value-required': 'editor.admin.webhooks.headers.problems.valueRequired',
  'value-again': 'editor.admin.webhooks.headers.problems.valueAgain',
};

/** A kept secret's stored value the API could not use (the header was removed meanwhile, or the key changed). */
export const HEADER_VALUE_GONE_TEXT =
  'editor.admin.webhooks.headers.problems.valueGone';

/** The text of an `invalid-headers` problem the API names by its code; undefined for another code. */
export function headerErrorText(code: string): TranslatedText | undefined {
  switch (code) {
    case 'header-name-invalid':
      return {
        key: HEADER_PROBLEM_TEXT['name-invalid'],
        params: { max: HEADER_NAME_MAX },
      };
    case 'header-name-refused':
      return { key: HEADER_PROBLEM_TEXT['name-refused'] };
    case 'header-name-duplicate':
      return { key: HEADER_PROBLEM_TEXT['name-duplicate'] };
    case 'header-value-invalid':
      return { key: HEADER_PROBLEM_TEXT['value-invalid'] };
    case 'header-value-required':
      return { key: HEADER_PROBLEM_TEXT['value-required'] };
    case 'too-many-headers':
      return headersProblemText('too-many');
    case 'headers-too-large':
      return headersProblemText('too-large');
    default:
      return undefined;
  }
}

/** An `invalid-headers` problem the API named, for its row (`source.pointer`). */
export interface HeaderApiError {
  /** The row's index, from `/data/attributes/headers/<index>/…`; null for the rows together. */
  readonly index: number | null;
  /** The field at fault; null for the whole row or the rows together. */
  readonly field: 'name' | 'value' | null;
  readonly code: string;
  readonly text: TranslatedText;
}

const HEADER_POINTER =
  /^\/data\/attributes\/headers(?:\/(\d+)(?:\/(name|value))?)?$/;

/**
 * The API's header problems, each with the row its `source.pointer` names; null when any error of
 * the answer is not one of them (the form then says it as every other failure).
 */
export function headerApiErrors(
  errors: readonly { code: string; source?: { pointer?: string } }[],
): HeaderApiError[] | null {
  if (errors.length === 0) return null;
  const out: HeaderApiError[] = [];
  for (const error of errors) {
    const text = headerErrorText(error.code);
    if (!text) return null;
    const match = HEADER_POINTER.exec(error.source?.pointer ?? '');
    out.push({
      index: match?.[1] === undefined ? null : Number(match[1]),
      field: (match?.[2] as 'name' | 'value' | undefined) ?? null,
      code: error.code,
      text,
    });
  }
  return out;
}
