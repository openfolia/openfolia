import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '../config/env.js';
import { emailCodeSignInOn } from '../config/sign-in-env.js';
import { EMAIL_CODE_PROVIDER } from './core/email-codes.js';
import { SignInSettings } from './api/sign-in-settings.js';
import { AuthenticateSessionAction } from './core/actions/authenticate-session.action.js';
import {
  IdentityProviders,
  StaticIdentityProviders,
} from './core/identity-provider.js';
import { SessionPolicy } from './core/session-policy.js';
import { SessionStore } from './core/sessions.js';
import { DrizzleSessionStore } from './repos/drizzle-sign-in.js';
import { EnvSessionPolicy } from './repos/env-session-policy.js';
import { OidcIdentityProvider } from './repos/oidc-identity-provider.js';
import { AccessController } from './api/access.controller.js';
import { ActorGuard } from './api/actor.guard.js';
import { AuthenticateServiceTokenAction } from './core/actions/authenticate-service-token.action.js';
import { GetMeAction } from './core/actions/get-me.action.js';
import { ListDemoUsersAction } from './core/actions/list-demo-users.action.js';
import { ListUsersAction } from './core/actions/list-users.action.js';
import { ResolveActorAction } from './core/actions/resolve-actor.action.js';
import { ServiceAccountStore } from './core/service-accounts.js';
import { UserDirectory } from './core/user-directory.js';
import { FailedAuthentications } from './api/failed-authentications.js';
import { DrizzleServiceAccountStore } from './repos/drizzle-service-accounts.js';
import { DrizzleUserDirectory } from './repos/drizzle-user-directory.js';

/** The identity providers offered (#37): OpenID Connect when `CCMS_OIDC_ISSUER` is set. */
function identityProviders(
  config: ConfigService<Env, true>,
): IdentityProviders {
  const issuer = config.get('CCMS_OIDC_ISSUER', { infer: true });
  const clientId = config.get('CCMS_OIDC_CLIENT_ID', { infer: true });
  const redirectUrl = config.get('CCMS_OIDC_REDIRECT_URL', { infer: true });
  // The settings refuse an issuer without the others (`checkSignInEnv`).
  if (
    issuer === undefined ||
    clientId === undefined ||
    redirectUrl === undefined
  ) {
    return new StaticIdentityProviders([]);
  }
  const clientSecret = config.get('CCMS_OIDC_CLIENT_SECRET', { infer: true });
  const displayName = config.get('CCMS_OIDC_NAME', { infer: true });
  return new StaticIdentityProviders([
    new OidcIdentityProvider({
      issuer,
      clientId,
      redirectUrl,
      scopes: config.get('CCMS_OIDC_SCOPES', { infer: true }),
      groupsClaim: config.get('CCMS_OIDC_GROUPS_CLAIM', { infer: true }),
      ...(clientSecret !== undefined && { clientSecret }),
      ...(displayName !== undefined && { displayName }),
    }),
  ]);
}

/**
 * Users, roles and permissions; `UserDirectory` for the components that need
 * actors. Its guard resolves every request's actor (`@CurrentActor()`):
 * from a token, or a person's session (#37). The identity providers and
 * the session policy are ports another module may provide its own of
 * (SAML #376, enforced sign-in #378); this module provides the default ones.
 */
@Module({
  controllers: [AccessController],
  providers: [
    { provide: UserDirectory, useClass: DrizzleUserDirectory },
    { provide: ServiceAccountStore, useClass: DrizzleServiceAccountStore },
    { provide: SessionStore, useClass: DrizzleSessionStore },
    {
      provide: IdentityProviders,
      inject: [ConfigService],
      useFactory: identityProviders,
    },
    {
      provide: SessionPolicy,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new EnvSessionPolicy({
          idleMinutes: config.get('CCMS_SESSION_IDLE_MINUTES', { infer: true }),
          maxHours: config.get('CCMS_SESSION_MAX_HOURS', { infer: true }),
          linkByEmail: config.get('CCMS_OIDC_LINK_BY_EMAIL', { infer: true }),
          // Codes by email turned off (#634): their sessions end too.
          off: emailCodeSignInOn({
            CCMS_EMAIL_CODE_SIGN_IN: config.get('CCMS_EMAIL_CODE_SIGN_IN', {
              infer: true,
            }),
            CCMS_PASSWORD_SIGN_IN: config.get('CCMS_PASSWORD_SIGN_IN', {
              infer: true,
            }),
            CCMS_MAIL_URL: config.get('CCMS_MAIL_URL', { infer: true }),
            CCMS_AUTH_MODE: config.get('CCMS_AUTH_MODE', { infer: true }),
          })
            ? []
            : [EMAIL_CODE_PROVIDER],
        }),
    },
    SignInSettings,
    AuthenticateSessionAction,
    ResolveActorAction,
    AuthenticateServiceTokenAction,
    FailedAuthentications,
    GetMeAction,
    ListUsersAction,
    ListDemoUsersAction,
    // Every route needs the token and gets an actor unless marked @Public().
    { provide: APP_GUARD, useClass: ActorGuard },
  ],
  exports: [
    UserDirectory,
    ServiceAccountStore,
    SessionStore,
    IdentityProviders,
    SessionPolicy,
    SignInSettings,
    FailedAuthentications,
  ],
})
export class AccessModule {}
