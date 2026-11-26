import { PasswordAttempts } from './core/password-attempts.js';
import { DrizzlePasswordAttempts } from './repos/drizzle-password-attempts.js';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { BrandingModule } from '../branding/branding.module.js';
import { MailModule } from '../mail/mail.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SecondFactorController } from './api/second-factor.controller.js';
import { SignInAnswer } from './api/sign-in-answer.js';
import { SignInAttempts } from './api/sign-in-attempts.js';
import {
  BeginSetUpAction,
  ConfirmSetUpAction,
  GetSecondFactorAction,
  NewRecoveryCodesAction,
  OwnPassword,
  ProvenChange,
  ResetSecondFactorAction,
  TurnOffSecondFactorAction,
} from './core/actions/second-factor.action.js';
import {
  BeginRequiredSetUpAction,
  ConfirmRequiredSetUpAction,
  ReadSecondStepAction,
  SecondSteps,
  VerifySecondStepAction,
} from './core/actions/second-factor-sign-in.action.js';
import { PendingSignIns } from './core/pending-sign-ins.js';
import { SecondFactorCodes } from './core/second-factor-codes.js';
import { SessionStart } from './core/session-start.js';
import { DrizzlePendingSignIns } from './repos/drizzle-second-factors.js';
import { EmailCodeController } from './api/email-code.controller.js';
import { PasswordController } from './api/password.controller.js';
import {
  RequestEmailCodeAction,
  SignInWithEmailCodeAction,
  SignInWithEmailLinkAction,
} from './core/actions/email-code.action.js';
import {
  EmailCodeHasher,
  EmailCodes,
  EmailCodeSignIn,
} from './core/email-codes.js';
import {
  DrizzleEmailCodeHasher,
  DrizzleEmailCodes,
} from './repos/drizzle-email-codes.js';
import { EnvEmailCodeSignIn } from './repos/env-email-code-sign-in.js';
import {
  ChangePasswordAction,
  PasswordSignInAction,
} from './core/actions/password-sign-in.action.js';
import {
  CreateSignInLinkAction,
  ForgotPasswordAction,
  ReadSignInLinkAction,
  SetPasswordWithLinkAction,
  WithdrawInviteAction,
} from './core/actions/sign-in-links.action.js';
import {
  PasswordHasher,
  PasswordSignIn,
  PasswordStore,
} from './core/passwords.js';
import { SignInLinks } from './core/sign-in-links.js';
import { WaysIn } from './core/ways-in.js';
import { Argon2PasswordHasher } from './repos/argon2-password-hasher.js';
import {
  DrizzlePasswordStore,
  DrizzleSignInLinks,
} from './repos/drizzle-passwords.js';
import { EnvPasswordSignIn } from './repos/env-password-sign-in.js';
import { FirstAdminAtStart } from './repos/first-admin-at-start.js';
import { AccessAdminController } from './api/access-admin.controller.js';
import { AuthController } from './api/auth.controller.js';
import { SignInController } from './api/sign-in.controller.js';
import { CompleteSignInAction } from './core/actions/complete-sign-in.action.js';
import {
  CreateGroupMappingAction,
  DeleteGroupMappingAction,
  GetGroupMappingAction,
  ListGroupMappingsAction,
} from './core/actions/group-mappings.action.js';
import {
  BeginSignInAction,
  ListIdentityProvidersAction,
  SignOutAction,
} from './core/actions/sign-in.action.js';
import { GroupMappings } from './core/group-mappings.js';
import { UserIdentities } from './core/user-identities.js';
import {
  DrizzleGroupMappings,
  DrizzleUserIdentities,
} from './repos/drizzle-sign-in.js';
import { ServiceAccountsController } from './api/service-accounts.controller.js';
import { CreateServiceAccountAction } from './core/actions/create-service-account.action.js';
import {
  DeactivateServiceAccountAction,
  ReactivateServiceAccountAction,
} from './core/actions/deactivate-service-account.action.js';
import {
  GetServiceAccountAction,
  ListServiceAccountsAction,
} from './core/actions/list-service-accounts.action.js';
import {
  IssueServiceTokenAction,
  ListServiceTokensAction,
  RevokeServiceTokenAction,
} from './core/actions/service-tokens.action.js';
import { UpdateServiceAccountAction } from './core/actions/update-service-account.action.js';
import { CreateRoleAction } from './core/actions/create-role.action.js';
import { CreateUserAction } from './core/actions/create-user.action.js';
import {
  DeactivateUserAction,
  ReactivateUserAction,
} from './core/actions/deactivate-user.action.js';
import { DeleteRoleAction } from './core/actions/delete-role.action.js';
import { GetUserAction } from './core/actions/get-user.action.js';
import {
  GetRoleAction,
  ListRolesAction,
} from './core/actions/list-roles.action.js';
import { UpdateRoleAction } from './core/actions/update-role.action.js';
import { UpdateUserAction } from './core/actions/update-user.action.js';
import { AccessModule } from './access.module.js';

/**
 * Administering access (#39): roles, users and assignments, deactivation;
 * service accounts and their tokens (#38); signing in and out, and group
 * mappings (#37); passwords, invites and resets (#610); codes by email (#634);
 * two-factor sign-in (#611).
 * Apart from `AccessModule` because deactivating a user releases its locks
 * (`LockStore` from `ChangeSetsModule`, which itself needs `AccessModule`).
 */
@Module({
  imports: [
    AccessModule,
    AuditModule,
    BrandingModule,
    ChangeSetsModule,
    MailModule,
    SettingsModule,
  ],
  controllers: [
    AccessAdminController,
    ServiceAccountsController,
    AuthController,
    SignInController,
    PasswordController,
    EmailCodeController,
    SecondFactorController,
  ],
  providers: [
    // Password sign-in, invites and resets (#610).
    { provide: PasswordStore, useClass: DrizzlePasswordStore },
    { provide: PasswordAttempts, useClass: DrizzlePasswordAttempts },
    { provide: SignInLinks, useClass: DrizzleSignInLinks },
    { provide: PasswordHasher, useValue: new Argon2PasswordHasher() },
    { provide: PasswordSignIn, useClass: EnvPasswordSignIn },
    PasswordSignInAction,
    ChangePasswordAction,
    CreateSignInLinkAction,
    WithdrawInviteAction,
    ReadSignInLinkAction,
    SetPasswordWithLinkAction,
    ForgotPasswordAction,
    // The first admin from CCMS_FIRST_ADMIN_EMAIL, on the first start (#373).
    FirstAdminAtStart,
    // Sign-in by a code by email (#634).
    { provide: EmailCodes, useClass: DrizzleEmailCodes },
    { provide: EmailCodeHasher, useClass: DrizzleEmailCodeHasher },
    { provide: EmailCodeSignIn, useClass: EnvEmailCodeSignIn },
    RequestEmailCodeAction,
    SignInWithEmailCodeAction,
    SignInWithEmailLinkAction,
    // Two-factor sign-in (#611): the one way a sign-in here starts a session, and its second step.
    { provide: PendingSignIns, useClass: DrizzlePendingSignIns },
    SessionStart,
    SecondFactorCodes,
    SecondSteps,
    OwnPassword,
    ProvenChange,
    GetSecondFactorAction,
    BeginSetUpAction,
    ConfirmSetUpAction,
    NewRecoveryCodesAction,
    TurnOffSecondFactorAction,
    ResetSecondFactorAction,
    ReadSecondStepAction,
    VerifySecondStepAction,
    BeginRequiredSetUpAction,
    ConfirmRequiredSetUpAction,
    SignInAttempts,
    SignInAnswer,
    // Ends a person's sessions, links and codes when a credential changes (#645).
    WaysIn,
    { provide: UserIdentities, useClass: DrizzleUserIdentities },
    { provide: GroupMappings, useClass: DrizzleGroupMappings },
    ListIdentityProvidersAction,
    BeginSignInAction,
    CompleteSignInAction,
    SignOutAction,
    ListGroupMappingsAction,
    GetGroupMappingAction,
    CreateGroupMappingAction,
    DeleteGroupMappingAction,
    ListRolesAction,
    GetRoleAction,
    CreateRoleAction,
    UpdateRoleAction,
    DeleteRoleAction,
    GetUserAction,
    CreateUserAction,
    UpdateUserAction,
    DeactivateUserAction,
    ReactivateUserAction,
    ListServiceAccountsAction,
    GetServiceAccountAction,
    CreateServiceAccountAction,
    UpdateServiceAccountAction,
    DeactivateServiceAccountAction,
    ReactivateServiceAccountAction,
    ListServiceTokensAction,
    IssueServiceTokenAction,
    RevokeServiceTokenAction,
  ],
  // For provisioning over SCIM (#377, `ScimModule`): it changes users and their groups' roles.
  exports: [GroupMappings, UserIdentities, WaysIn],
})
export class AccessAdminModule {}
