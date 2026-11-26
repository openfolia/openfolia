import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '../config/env.js';
import { Database } from '../database/database.js';
import { samlAddresses } from '../config/saml-env.js';
import { emailCodeSignInOn, passwordSignInOn } from '../config/sign-in-env.js';
import { EMAIL_CODE_PROVIDER } from './core/email-codes.js';
import { SignInSettings } from './api/sign-in-settings.js';
import { AuthenticateSessionAction } from './core/actions/authenticate-session.action.js';
import {
  type IdentityProvider,
  IdentityProviders,
  StaticIdentityProviders,
} from './core/identity-provider.js';
import { SeenAssertions } from './core/seen-assertions.js';
import { DrizzleSeenAssertions } from './repos/drizzle-seen-assertions.js';
import { SamlIdentityProvider } from './repos/saml-identity-provider.js';
import { SessionPolicy } from './core/session-policy.js';
import { SecondFactors } from './core/second-factors.js';
import { SessionStore } from './core/sessions.js';
import { AccessAdmin } from './core/access-admin.js';
import { DrizzleAccessAdmin } from './repos/drizzle-access-admin.js';
import { RefusedSignIns } from './core/refused-sign-ins.js';
import { SignInRules, SignInSetup } from './core/sign-in-rules.js';
import { DrizzleRefusedSignIns } from './repos/drizzle-refused-sign-ins.js';
import { DrizzleSignInRules } from './repos/drizzle-sign-in-rules.js';
import { EnvSignInSetup } from './repos/env-sign-in-setup.js';
import { DrizzleSecondFactors } from './repos/drizzle-second-factors.js';
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
import {
  FailedAuthentications,
  NetworkAnswers,
} from './api/failed-authentications.js';
import { DrizzleServiceAccountStore } from './repos/drizzle-service-accounts.js';
import { DrizzleUserDirectory } from './repos/drizzle-user-directory.js';
import { Sandbox } from '../sandbox/core/sandbox.js';

/**
 * The identity providers offered: OpenID Connect when `CCMS_OIDC_ISSUER` is set (#37), SAML
 * when the identity provider's metadata is named (#376), in that order.
 */
function identityProviders(
  config: ConfigService<Env, true>,
  sandbox: Sandbox,
  seen: SeenAssertions,
): IdentityProviders {
  // A public sandbox (#826) has the demo's people only: no provider, nothing fetched from one.
  if (sandbox.on) return new StaticIdentityProviders([]);
  return new StaticIdentityProviders(
    [oidcProvider(config), samlProvider(config, seen)].filter(
      (provider) => provider !== undefined,
    ),
  );
}

function oidcProvider(
  config: ConfigService<Env, true>,
): IdentityProvider | undefined {
  const issuer = config.get('CCMS_OIDC_ISSUER', { infer: true });
  const clientId = config.get('CCMS_OIDC_CLIENT_ID', { infer: true });
  const redirectUrl = config.get('CCMS_OIDC_REDIRECT_URL', { infer: true });
  // The settings refuse an issuer without the others (`checkSignInEnv`).
  if (
    issuer === undefined ||
    clientId === undefined ||
    redirectUrl === undefined
  ) {
    return undefined;
  }
  const clientSecret = config.get('CCMS_OIDC_CLIENT_SECRET', { infer: true });
  const displayName = config.get('CCMS_OIDC_NAME', { infer: true });
  return new OidcIdentityProvider({
    issuer,
    clientId,
    redirectUrl,
    scopes: config.get('CCMS_OIDC_SCOPES', { infer: true }),
    groupsClaim: config.get('CCMS_OIDC_GROUPS_CLAIM', { infer: true }),
    ...(clientSecret !== undefined && { clientSecret }),
    ...(displayName !== undefined && { displayName }),
  });
}

function samlProvider(
  config: ConfigService<Env, true>,
  seen: SeenAssertions,
): IdentityProvider | undefined {
  const url = config.get('CCMS_SAML_IDP_METADATA_URL', { infer: true });
  const file = config.get('CCMS_SAML_IDP_METADATA_FILE', { infer: true });
  const editorUrl = config.get('CCMS_EDITOR_URL', { infer: true });
  const metadata =
    url !== undefined ? { url } : file !== undefined ? { file } : undefined;
  // The settings refuse metadata without the editor's address (`checkSamlEnv`).
  if (metadata === undefined || editorUrl === undefined) return undefined;
  const addresses = samlAddresses(
    editorUrl,
    config.get('CCMS_SAML_SP_ENTITY_ID', { infer: true }),
  );
  const displayName = config.get('CCMS_SAML_NAME', { infer: true });
  return new SamlIdentityProvider(
    {
      metadata,
      entityId: addresses.entityId,
      acsUrl: addresses.acsUrl,
      nameIdFormat: config.get('CCMS_SAML_NAME_ID_FORMAT', { infer: true }),
      emailAttribute: config.get('CCMS_SAML_EMAIL_ATTRIBUTE', { infer: true }),
      nameAttribute: config.get('CCMS_SAML_NAME_ATTRIBUTE', { infer: true }),
      groupsAttribute: config.get('CCMS_SAML_GROUPS_ATTRIBUTE', {
        infer: true,
      }),
      emailVerified: config.get('CCMS_SAML_EMAIL_VERIFIED', { infer: true }),
      idpInitiated: config.get('CCMS_SAML_IDP_INITIATED', { infer: true }),
      ...(displayName !== undefined && { displayName }),
    },
    seen,
  );
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
    // Read by the settings too, to require them (#611).
    { provide: SecondFactors, useClass: DrizzleSecondFactors },
    { provide: SeenAssertions, useClass: DrizzleSeenAssertions },
    {
      provide: IdentityProviders,
      inject: [ConfigService, Sandbox, SeenAssertions],
      useFactory: identityProviders,
    },
    {
      // The rule about signing in (#378): read from the settings' row here rather than through
      // `SettingsModule`, which itself needs this module.
      provide: SignInRules,
      inject: [Database, ConfigService],
      useFactory: (database: Database, config: ConfigService<Env, true>) =>
        new DrizzleSignInRules(
          database,
          passwordSignInOn({
            CCMS_PASSWORD_SIGN_IN: config.get('CCMS_PASSWORD_SIGN_IN', {
              infer: true,
            }),
            CCMS_AUTH_MODE: config.get('CCMS_AUTH_MODE', { infer: true }),
          }),
        ),
    },
    { provide: SignInSetup, useClass: EnvSignInSetup },
    { provide: RefusedSignIns, useClass: DrizzleRefusedSignIns },
    { provide: AccessAdmin, useClass: DrizzleAccessAdmin },
    {
      provide: SessionPolicy,
      inject: [ConfigService, SignInRules, SignInSetup],
      useFactory: (
        config: ConfigService<Env, true>,
        rules: SignInRules,
        setup: SignInSetup,
      ) =>
        new EnvSessionPolicy(rules, setup, {
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
    NetworkAnswers,
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
    SecondFactors,
    IdentityProviders,
    SessionPolicy,
    SignInRules,
    SignInSetup,
    RefusedSignIns,
    AccessAdmin,
    SignInSettings,
    FailedAuthentications,
    NetworkAnswers,
  ],
})
export class AccessModule {}
