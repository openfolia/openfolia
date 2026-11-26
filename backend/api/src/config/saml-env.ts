import { z } from 'zod';
import { field, flag, text } from './fields.js';
import { isLoopbackHost } from './sign-in-env.js';

export const DEFAULT_SAML_EMAIL_ATTRIBUTE = 'email';
export const DEFAULT_SAML_NAME_ATTRIBUTE = 'name';
export const DEFAULT_SAML_GROUPS_ATTRIBUTE = 'groups';

/** The name ID Formats one installation may expect (#946): never a transient one. */
const SAML_NAME_ID_FORMATS = [
  'persistent',
  'emailAddress',
  'unspecified',
] as const;
export type SamlNameIdFormat = (typeof SAML_NAME_ID_FORMATS)[number];

/** An `https://` URL (or `http://` on a loopback host) without credentials or fragment. */
const metadataUrl = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && isLoopbackHost(url.hostname))) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  }, 'must be an https:// URL (http:// only on localhost or 127.0.0.1), without credentials or fragment');

/** An attribute's name as the identity provider sends it (`Name`): a short name or a URI. */
const attributeName = text.pipe(z.string().max(500));

/**
 * Sign-in with SAML 2.0 (#376): part of `Env`. The identity provider's metadata (its address or
 * a file) turns it on; the service provider's addresses follow from `CCMS_EDITOR_URL`. Never
 * together with demo mode (`checkSamlEnv`).
 */
export const SamlEnv = z.object({
  /** Where the identity provider publishes its metadata. Unset (and no file): no SAML sign-in. */
  CCMS_SAML_IDP_METADATA_URL: field(metadataUrl.optional()),
  /** The identity provider's metadata as a file, in place of an address. */
  CCMS_SAML_IDP_METADATA_FILE: field(text.optional()),
  /** This server's entity ID at the identity provider; default: its metadata address. */
  CCMS_SAML_SP_ENTITY_ID: field(text.pipe(z.string().max(1000)).optional()),
  /** The identity provider's name on the sign-in button; unset: the editor's own wording. */
  CCMS_SAML_NAME: field(text.pipe(z.string().max(60)).optional()),
  /**
   * The Format of the name IDs (#946), asked for and required. Default persistent: the one SAML
   * itself keeps stable and never gives to someone else. A provider that sends another is refused
   * before any user is made, so a wrong default is never silent.
   */
  CCMS_SAML_NAME_ID_FORMAT: field(
    text
      .pipe(
        z.enum(
          SAML_NAME_ID_FORMATS,
          `must be one of ${SAML_NAME_ID_FORMATS.join(', ')}`,
        ),
      )
      .default('persistent'),
  ),
  /** The attribute holding the email address (else the NameID, when it is one). */
  CCMS_SAML_EMAIL_ATTRIBUTE: field(
    attributeName.default(DEFAULT_SAML_EMAIL_ATTRIBUTE),
  ),
  /** The attribute holding the display name. */
  CCMS_SAML_NAME_ATTRIBUTE: field(
    attributeName.default(DEFAULT_SAML_NAME_ATTRIBUTE),
  ),
  /** The attribute holding the groups (one value per group). */
  CCMS_SAML_GROUPS_ATTRIBUTE: field(
    attributeName.default(DEFAULT_SAML_GROUPS_ATTRIBUTE),
  ),
  /**
   * Whether the identity provider vouches for the email addresses it sends (default false: fail
   * closed). As OpenID Connect's `email_verified`: only when true may `CCMS_OIDC_LINK_BY_EMAIL`
   * link by them, the first admin's included.
   */
  CCMS_SAML_EMAIL_VERIFIED: field(flag.default(false)),
  /** Whether a sign-in begun at the identity provider (no request from here) is accepted (default false). */
  CCMS_SAML_IDP_INITIATED: field(flag.default(false)),
});
export type SamlSettingsEnv = z.infer<typeof SamlEnv>;

/** Whether SAML sign-in is set up: the identity provider's metadata is named. */
export function samlOn(env: {
  readonly CCMS_SAML_IDP_METADATA_URL?: string | undefined;
  readonly CCMS_SAML_IDP_METADATA_FILE?: string | undefined;
}): boolean {
  return (
    env.CCMS_SAML_IDP_METADATA_URL !== undefined ||
    env.CCMS_SAML_IDP_METADATA_FILE !== undefined
  );
}

/** The service provider's addresses (#376), under the editor's `/api`. */
export function samlAddresses(
  editorUrl: string,
  entityId: string | undefined,
): {
  readonly acsUrl: string;
  readonly metadataUrl: string;
  readonly entityId: string;
} {
  const metadataUrl = new URL('api/auth/saml/metadata', editorUrl).href;
  return {
    acsUrl: new URL('api/auth/saml/callback', editorUrl).href,
    metadataUrl,
    entityId: entityId ?? metadataUrl,
  };
}

/**
 * What SAML sign-in needs together: one source of the metadata, the editor's address (the
 * service provider's addresses are under it), and never demo mode, nor the shared token (but for
 * a loopback identity provider, in local runs and tests), as with OpenID Connect.
 */
export function checkSamlEnv(
  env: SamlSettingsEnv & {
    readonly CCMS_AUTH_MODE: string;
    readonly CCMS_API_TOKEN?: string | undefined;
    readonly CCMS_EDITOR_URL?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (!samlOn(env)) {
    for (const key of ['CCMS_SAML_SP_ENTITY_ID', 'CCMS_SAML_NAME'] as const) {
      if (env[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            'needs CCMS_SAML_IDP_METADATA_URL or CCMS_SAML_IDP_METADATA_FILE (SAML sign-in is off without one)',
        });
      }
    }
    return;
  }
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (
    env.CCMS_SAML_IDP_METADATA_URL !== undefined &&
    env.CCMS_SAML_IDP_METADATA_FILE !== undefined
  ) {
    issue(
      'CCMS_SAML_IDP_METADATA_FILE',
      'cannot be set with CCMS_SAML_IDP_METADATA_URL: name the metadata one way',
    );
  }
  if (env.CCMS_AUTH_MODE === 'demo') {
    issue(
      'CCMS_SAML_IDP_METADATA_URL',
      'sign-in with SAML and demo mode (CCMS_AUTH_MODE=demo) cannot be on together: in demo mode anyone holding the token acts as anyone. Unset one of them.',
    );
  }
  if (env.CCMS_EDITOR_URL === undefined) {
    issue(
      'CCMS_EDITOR_URL',
      "is required with SAML sign-in: the service provider's addresses are under it (<editor>/api/auth/saml/…)",
    );
  }
  const loopback =
    env.CCMS_SAML_IDP_METADATA_URL !== undefined &&
    isLoopbackHost(new URL(env.CCMS_SAML_IDP_METADATA_URL).hostname);
  if (env.CCMS_API_TOKEN !== undefined && !loopback) {
    issue(
      'CCMS_API_TOKEN',
      "cannot be set with sign-in (CCMS_SAML_IDP_METADATA_URL or _FILE): the shared token reads everything without signing in. Unset it (and the editor proxy's CCMS_EDITOR_API_TOKEN); machine clients use service account tokens.",
    );
  }
}
