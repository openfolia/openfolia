import { DomainError } from '../../base/core/errors.js';

/**
 * Who a provider says signed in (#37): its issuer and subject (together the
 * person's stable key), and what it says about them. Never a token.
 */
export interface ExternalIdentity {
  /** The provider's issuer identifier (OIDC `iss`; another protocol's entity ID). */
  readonly issuer: string;
  /** The person's ID at the provider (OIDC `sub`). */
  readonly subject: string;
  readonly email: string | null;
  /** Whether the provider vouches for `email` (OIDC `email_verified`). */
  readonly emailVerified: boolean;
  /** A display name, when the provider sends one. */
  readonly name: string | null;
  /** A login name, when the provider sends one (OIDC `preferred_username`). */
  readonly username: string | null;
  /** The groups the provider puts the person in, each once. */
  readonly groups: readonly string[];
}

/**
 * What a provider needs back to finish a sign-in it began (OIDC: the state,
 * the nonce and the PKCE verifier). Kept by the browser, sealed (the API
 * layer's job), for the one sign-in: opaque to everyone but the provider.
 */
export type PendingSignIn = Readonly<Record<string, string>>;

/** A sign-in begun: where to send the browser, and what to keep until it comes back. */
export interface BegunSignIn {
  readonly authorizationUrl: string;
  readonly pending: PendingSignIn;
}

/**
 * Why a provider could not finish a sign-in, as the sign-in page tells it:
 * - `provider-unavailable`: the provider could not be reached (try again);
 * - `access-denied`: the person cancelled, or the provider refused them;
 * - `sign-in-failed`: anything else (a forged, replayed or mangled answer,
 *   a token that does not verify): nothing more is said.
 */
export type SignInFailure =
  'provider-unavailable' | 'access-denied' | 'sign-in-failed';

/** A provider could not finish (or begin) a sign-in; `reason` says which way. */
export class SignInFailedError extends DomainError {
  readonly code: string;

  constructor(
    readonly reason: SignInFailure,
    message: string,
  ) {
    super(message);
    this.code = reason;
  }
}

/**
 * Port: one way people sign in (#37). OpenID Connect is one
 * (`repos/oidc-identity-provider.ts`); another module may register more
 * (SAML, #376) through `IdentityProviders`. A provider only says who
 * signed in: users, roles and sessions are the core's, the same whichever
 * provider it was.
 */
export abstract class IdentityProvider {
  /** Its key in routes and sessions, e.g. `oidc`: a lowercase key. */
  abstract readonly id: string;
  /** What the sign-in button names; null for the editor's default wording. */
  abstract readonly displayName: string | null;

  /**
   * Begins a sign-in: the address to send the browser to, and what to
   * keep until it comes back. Rejects with `SignInFailedError`
   * (`provider-unavailable`) when the provider cannot be reached.
   */
  abstract begin(): Promise<BegunSignIn>;

  /**
   * Finishes a sign-in from the provider's answer (`callback`: the query
   * the browser came back with) and what `begin` gave to keep. Rejects with
   * `SignInFailedError` for anything it does not accept.
   */
  abstract complete(
    callback: URLSearchParams,
    pending: PendingSignIn,
  ): Promise<ExternalIdentity>;

  /**
   * Where to send the browser to sign out at the provider too, coming back
   * to `returnTo`; undefined when the provider offers no such address (or
   * cannot be reached: signing out here never waits for it).
   */
  abstract signOutUrl(returnTo: string): Promise<string | undefined>;
}

/**
 * Port: the identity providers this server offers, in the order the
 * sign-in page shows them. Empty when sign-in is not set up (demo mode,
 * tokens only). Another module (SAML, #376) may provide its own, adding
 * to these.
 */
export abstract class IdentityProviders {
  abstract list(): readonly IdentityProvider[];

  /** The provider `id`; undefined when there is none. */
  find(id: string): IdentityProvider | undefined {
    return this.list().find((provider) => provider.id === id);
  }
}

/** `IdentityProviders` over a fixed list. */
export class StaticIdentityProviders extends IdentityProviders {
  constructor(private readonly providers: readonly IdentityProvider[]) {
    super();
  }

  list(): readonly IdentityProvider[] {
    return this.providers;
  }
}
