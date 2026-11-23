import {
  ConfigKey,
  type DeliveryAccess,
  LanguageTag,
  ModuleId,
  type ProjectConfig,
  publicAudience,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import { ReleaseRevision } from '../../releases/core/release.js';

/**
 * A manual's stable address (#450): `/d/<product>/<manual>/<variant>/<lang>`, the manual in
 * that variant and language in the product's latest release (`ReleaseStore.latest`), as HTML;
 * `@<revision>` after the language pins one release; `/pdf` after it is the PDF of the same.
 * `manual` is its slug (`delivery.manuals.<id>.slug`, else its ID), `variant` its variant's
 * slug (`variantSlug`), `product` a value of the product facet.
 */
export interface StableAddress {
  readonly product: string;
  /** The manual's address segment (`deliverySlug`). */
  readonly slug: string;
  readonly variant: string;
  readonly lang: string;
  /** A pinned release's revision; undefined: the latest. */
  readonly revision?: string | undefined;
}

/** What an address opens: the HTML page or the PDF. */
export type AddressKind = 'html' | 'pdf';

/** The prefix every stable address starts with. */
export const ADDRESS_ROOT = '/d';

/** The path segment for stylesheets and fonts of the address pages: no product is `-`. */
export const PAGE_FILES = '-';

/**
 * A path segment as a link writes it: percent-encoded, but `=`, `,` and `;` (a variant slug's
 * own characters, allowed in a path) and `~` kept, so a printed address stays readable.
 */
export function segment(value: string): string {
  return encodeURIComponent(value).replace(/%(3D|2C|3B)/gi, (code) =>
    decodeURIComponent(code),
  );
}

/** The address's path, from the API's root: `/d/north/operating/model=large/en@2.1/pdf`. */
export function addressPath(
  address: StableAddress,
  kind: AddressKind = 'html',
): string {
  const lang =
    address.revision === undefined
      ? segment(address.lang)
      : `${segment(address.lang)}@${segment(address.revision)}`;
  return [
    ADDRESS_ROOT,
    segment(address.product),
    segment(address.slug),
    segment(address.variant),
    lang,
    ...(kind === 'pdf' ? ['pdf'] : []),
  ].join('/');
}

/** The same address of the latest release (no revision). */
export function latestOf(address: StableAddress): StableAddress {
  return {
    product: address.product,
    slug: address.slug,
    variant: address.variant,
    lang: address.lang,
  };
}

/**
 * The address a request names, from its path parameters, checked for their shape; undefined
 * for one no address can have (answered as not found, like an address of nothing). The
 * language segment holds `<lang>` or `<lang>@<revision>`.
 */
export function parseAddress(params: {
  readonly product: string;
  readonly manual: string;
  readonly variant: string;
  readonly lang: string;
}): StableAddress | undefined {
  const at = params.lang.indexOf('@');
  const lang = at < 0 ? params.lang : params.lang.slice(0, at);
  const revision = at < 0 ? undefined : params.lang.slice(at + 1);
  if (
    !ConfigKey.safeParse(params.product).success ||
    !ModuleId.safeParse(params.manual).success ||
    params.variant.length === 0 ||
    params.variant.length > 500 ||
    !LanguageTag.safeParse(lang).success ||
    (revision !== undefined && !ReleaseRevision.safeParse(revision).success)
  ) {
    return undefined;
  }
  return {
    product: params.product,
    slug: params.manual,
    variant: params.variant,
    lang,
    ...(revision !== undefined && { revision }),
  };
}

/**
 * Settings of the stable addresses, the operator's (environment), not the content's:
 *
 * - `publicUrl`: where readers reach this deployment (`CCMS_PUBLIC_URL`, ending in `/`), the
 *   base of an address's absolute URL and of its QR code; undefined: not set, so there are
 *   paths only and no QR codes.
 * - `maxAccess`: the most a project's `delivery.access` may open its addresses
 *   (`CCMS_DELIVERY_MAX_ACCESS`, #553): a project asking for more is served at this
 *   (`deliveryAccess`), and its checks say so (`delivery-access-capped`).
 * - `ignoredQuery`: the query parameters an address ignores (`CCMS_DELIVERY_IGNORED_QUERY`,
 *   #553), the tracking parameters a shared link picks up (`ignoredParameter`).
 */
export abstract class StableAddressSettings {
  abstract readonly publicUrl: string | undefined;
  abstract readonly maxAccess: DeliveryAccess;
  abstract readonly ignoredQuery: readonly string[];
  /**
   * How long a shared cache (a proxy, a CDN) keeps a public page's image before it asks again,
   * in seconds (`CCMS_DELIVERY_SHARED_MAX_AGE`, #552): how long a withdrawn release's images
   * can stay out there.
   */
  abstract readonly sharedMaxAge: number;
  /**
   * What identifies the running build (`CCMS_BUILD_ID`, #552), in a page's ETag: the same on
   * every server of one build, so their ETags agree; else one per process.
   */
  abstract readonly buildId: string;
}

/** `off` < `signed-in` < `public`: how far each opens the addresses. */
const OPENNESS: Readonly<Record<DeliveryAccess, number>> = {
  off: 0,
  'signed-in': 1,
  public: 2,
};

/**
 * Who may open the addresses (#553): the project's `delivery.access`, at most the operator's
 * `maxAccess`. Every reader of `delivery.access` goes through this, so a capped project is
 * never served (or printed in a QR code) above the cap.
 */
export function deliveryAccess(
  config: Pick<ProjectConfig, 'delivery'>,
  settings: Pick<StableAddressSettings, 'maxAccess'>,
): DeliveryAccess {
  const asked = config.delivery.access;
  return OPENNESS[asked] <= OPENNESS[settings.maxAccess]
    ? asked
    : settings.maxAccess;
}

/**
 * Whether an address ignores the query parameter `name` (#553): it matches one of `patterns`,
 * a name exactly or, ending in `*`, a prefix (`utm_*`). Case matters, as in a query.
 */
export function ignoredParameter(
  name: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*')
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern,
  );
}

/**
 * A request's query string (without `?`) without the parameters an address ignores
 * (`ignoredParameter`), keeping those in `keep` (the route's own, so a pattern never hides
 * one) and every other part exactly as sent (so it is still refused as unsupported); `''`
 * when nothing is left. A part whose name cannot be decoded is kept.
 */
export function withoutIgnored(
  query: string,
  patterns: readonly string[],
  keep: ReadonlySet<string>,
): string {
  if (patterns.length === 0 || query === '') return query;
  return query
    .split('&')
    .filter((part) => {
      if (part === '') return true;
      const raw = part.split('=', 1)[0] ?? '';
      let name: string;
      try {
        name = decodeURIComponent(raw.replace(/\+/g, ' '));
      } catch {
        return true;
      }
      return keep.has(name) || !ignoredParameter(name, patterns);
    })
    .join('&');
}

/** The address's absolute URL under `publicUrl`; undefined without one. */
export function absoluteUrl(
  settings: Pick<StableAddressSettings, 'publicUrl'>,
  path: string,
): string | undefined {
  if (settings.publicUrl === undefined) return undefined;
  return new URL(path.replace(/^\//, ''), settings.publicUrl).href;
}

/** A level no configuration has (`ConfigKey` allows it, no level ID equals it). */
const NO_AUDIENCE = 'no-public-audience';

/**
 * Who reads a public address without signing in (#450): a service that reads released
 * content up to the configuration's public audience level (`publicAudience`) and nothing
 * else, in every language, module type and facet. Its ID is outside the `UserId` format, so
 * no user can have it.
 */
export function publicReader(config: ProjectConfig): Actor {
  const maxAudience = publicAudience(config);
  return Object.freeze({
    kind: 'service',
    id: 'service:public-reader',
    roles: Object.freeze([
      Object.freeze({
        id: 'public-reader',
        name: 'Public reader',
        permissions: Object.freeze(['content.read']),
        // No audience levels on `main`: none for the public either (fails closed at an older
        // tag that had levels), never the unlimited scope.
        scope: Object.freeze({ maxAudience: maxAudience ?? NO_AUDIENCE }),
      }),
    ]),
  }) as Actor;
}
