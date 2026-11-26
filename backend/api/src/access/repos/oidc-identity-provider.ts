import { Logger } from '@nestjs/common';
import * as client from 'openid-client';
import { isLoopbackHost } from '../../config/sign-in-env.js';
import {
  type BegunSignIn,
  type ExternalIdentity,
  IdentityProvider,
  type PendingSignIn,
  SignInFailedError,
} from '../core/identity-provider.js';

/** How long one call to the provider may take, in seconds. */
const TIMEOUT_SECONDS = 10;
/** After a failed discovery, the next sign-in tries again; not more often than this. */
const RETRY_DISCOVERY_MS = 5_000;

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  /** Unset: a public client, authenticated by PKCE alone. */
  readonly clientSecret?: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  /** A claim name, or a dotted path into nested claims (`org.groups`). */
  readonly groupsClaim: string;
  readonly displayName?: string;
}

/**
 * The value of `claim` in `claims`: the claim of that exact name, else the
 * dotted path into nested objects (`a.b` → `claims.a.b`).
 */
export function claimAt(
  claims: Record<string, unknown>,
  claim: string,
): unknown {
  if (Object.hasOwn(claims, claim)) return claims[claim];
  let value: unknown = claims;
  for (const key of claim.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Groups as a provider sends them: a list of strings or one string; anything else is none. */
export function groupsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

const textClaim = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** A failure reaching the provider (network, timeout), as opposed to an answer refused. */
function unreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    (error instanceof TypeError && /fetch/i.test(error.message)) ||
    (error instanceof client.ClientError &&
      error.code === 'OAUTH_RESPONSE_IS_NOT_CONFORM' &&
      /status code/i.test(error.message))
  );
}

/**
 * The core's identity provider (#37): OpenID Connect, the authorization
 * code flow with PKCE (S256), a state and a nonce, against any provider
 * found by discovery (`openid-client`). Nothing provider-specific: the
 * groups are read from a configured claim of the ID token, else of the
 * userinfo answer. The provider's metadata is read at the first sign-in
 * (not at start-up, so an unreachable provider never stops the server)
 * and kept; a failed read is tried again at a later sign-in.
 */
export class OidcIdentityProvider extends IdentityProvider {
  readonly id = 'oidc';
  readonly displayName: string | null;
  private readonly log = new Logger('Sign-in');
  private configuration: Promise<client.Configuration> | undefined;
  private failedAt = 0;

  constructor(private readonly settings: OidcSettings) {
    super();
    this.displayName = settings.displayName ?? null;
  }

  async begin(): Promise<BegunSignIn> {
    const config = await this.config();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.settings.redirectUrl,
      scope: this.settings.scopes.join(' '),
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { authorizationUrl: url.href, pending: { verifier, state, nonce } };
  }

  async complete(
    callback: URLSearchParams,
    pending: PendingSignIn,
  ): Promise<ExternalIdentity> {
    const { verifier, state, nonce } = pending;
    if (!verifier || !state || !nonce) {
      throw new SignInFailedError(
        'sign-in-failed',
        'The sign-in was not begun here.',
      );
    }
    if (callback.get('error') === 'access_denied') {
      throw new SignInFailedError(
        'access-denied',
        'The provider refused the sign-in.',
      );
    }
    const config = await this.config();
    // The address as the provider sent the browser back: the configured one
    // and the query, never the request's own Host.
    const current = new URL(this.settings.redirectUrl);
    current.search = callback.toString();
    try {
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims();
      if (!idClaims) throw new Error('no ID token');
      let claims: Record<string, unknown> = { ...idClaims };
      // Groups (or a name) not in the ID token: asked of the userinfo endpoint.
      if (
        config.serverMetadata().userinfo_endpoint !== undefined &&
        (claimAt(claims, this.settings.groupsClaim) === undefined ||
          claims['email'] === undefined)
      ) {
        const info = await client.fetchUserInfo(
          config,
          tokens.access_token,
          idClaims.sub,
        );
        // The ID token's claims win; the address and whether it is verified come as a pair from
        // one answer, never one from each.
        const fromToken = idClaims['email'] !== undefined;
        claims = {
          ...info,
          ...claims,
          email: fromToken ? idClaims['email'] : info['email'],
          email_verified: fromToken
            ? idClaims['email_verified']
            : info['email_verified'],
        };
      }
      return {
        issuer: idClaims.iss,
        subject: idClaims.sub,
        email: textClaim(claims['email']),
        emailVerified: claims['email_verified'] === true,
        name: textClaim(claims['name']),
        username: textClaim(claims['preferred_username']),
        groups: groupsFrom(claimAt(claims, this.settings.groupsClaim)),
      };
    } catch (error) {
      if (error instanceof SignInFailedError) throw error;
      if (
        error instanceof client.AuthorizationResponseError &&
        error.error === 'access_denied'
      ) {
        throw new SignInFailedError(
          'access-denied',
          'The provider refused the sign-in.',
        );
      }
      if (unreachable(error)) {
        this.log.warn(
          `The identity provider could not be reached: ${describe(error)}`,
        );
        throw new SignInFailedError(
          'provider-unavailable',
          'The identity provider could not be reached.',
        );
      }
      // Said in the log (never a token: openid-client's messages name checks, not values).
      this.log.warn(`A sign-in was refused: ${describe(error)}`);
      throw new SignInFailedError(
        'sign-in-failed',
        'The sign-in could not be completed.',
      );
    }
  }

  async signOutUrl(returnTo: string): Promise<string | undefined> {
    try {
      const config = await this.config();
      if (!config.serverMetadata().end_session_endpoint) return undefined;
      return client.buildEndSessionUrl(config, {
        client_id: this.settings.clientId,
        post_logout_redirect_uri: returnTo,
      }).href;
    } catch {
      return undefined;
    }
  }

  override async answersNow(): Promise<void> {
    this.configuration = Promise.resolve(await this.discover());
  }

  /** The provider's metadata, read once (again after a failure, at most every few seconds). */
  private config(): Promise<client.Configuration> {
    if (this.configuration) return this.configuration;
    if (Date.now() - this.failedAt < RETRY_DISCOVERY_MS) {
      return Promise.reject(
        new SignInFailedError(
          'provider-unavailable',
          'The identity provider could not be reached.',
        ),
      );
    }
    const discovered = this.discover().catch((error: unknown) => {
      this.configuration = undefined;
      this.failedAt = Date.now();
      throw error;
    });
    this.configuration = discovered;
    return discovered;
  }

  private discover(): Promise<client.Configuration> {
    const issuer = new URL(this.settings.issuer);
    return client
      .discovery(
        issuer,
        this.settings.clientId,
        undefined,
        this.settings.clientSecret === undefined
          ? client.None()
          : client.ClientSecretBasic(this.settings.clientSecret),
        {
          timeout: TIMEOUT_SECONDS,
          // Plain http only on a loopback host (local runs, tests): the settings refuse it elsewhere.
          ...(issuer.protocol === 'http:' && isLoopbackHost(issuer.hostname)
            ? { execute: [client.allowInsecureRequests] }
            : {}),
        },
      )
      .catch((error: unknown) => {
        this.log.warn(
          `The identity provider's metadata could not be read from ${this.settings.issuer}: ${describe(error)}`,
        );
        throw new SignInFailedError(
          'provider-unavailable',
          'The identity provider could not be reached.',
        );
      });
  }
}

/** An error's name and message, for the log; never more. */
function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
