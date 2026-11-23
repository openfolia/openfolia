import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import { SIGN_IN_LINK_KINDS } from '../core/sign-in-links.js';

/** A password as sent: the rules (`passwordProblem`) are the action's; this only bounds it. */
const SentPassword = z.string().min(1).max(1024);

/** An email address as typed on the sign-in page: checked by the action, never echoed. */
const SentEmail = z.string().trim().min(1).max(320);

/** A link's token as the page read it after `#`. */
const SentToken = z.string().min(1).max(200);

export const SignInOptionsResource = resourceObject('SignInOptions', {
  attributes: z.object({
    password: z
      .boolean()
      .describe(
        'Whether people sign in with an email address and a password (`CCMS_PASSWORD_SIGN_IN`; never in demo mode).',
      ),
    passwordReset: z
      .boolean()
      .describe(
        '“Forgot password” is offered: password sign-in is on, and email (`CCMS_MAIL_URL`, `CCMS_PUBLIC_URL`) can carry the link.',
      ),
    emailCode: z
      .boolean()
      .describe(
        '“Email me a code” is offered (#634): `CCMS_EMAIL_CODE_SIGN_IN` on, and email (`CCMS_MAIL_URL`) going out.',
      ),
    providers: z
      .number()
      .int()
      .describe(
        'How many identity providers are offered (`GET /auth/providers`).',
      ),
  }),
})
  .describe('`id` is always `sign-in`.')
  .meta({ id: 'SignInOptionsResource' });

export const SignInOptionsDocument = singleDocument(SignInOptionsResource).meta(
  { id: 'SignInOptionsDocument' },
);

/** `POST /auth/password/sign-in`. */
export const PasswordSignInDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('PasswordSignIn'),
      attributes: z.strictObject({
        email: SentEmail,
        password: SentPassword,
      }),
    }),
  })
  .meta({ id: 'PasswordSignInDocument' });
export type PasswordSignInDocument = z.output<typeof PasswordSignInDocument>;

/** The answer of a sign-in that started a session (the cookie carries it). */
export const SignedInDocument = z
  .object({
    meta: z.object({
      userId: z.string().describe('Who is signed in now.'),
    }),
  })
  .meta({ id: 'SignedInDocument' });

/** `POST /auth/password/forgot`. */
export const ForgotPasswordDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('PasswordReset'),
      attributes: z.strictObject({ email: SentEmail }),
    }),
  })
  .meta({ id: 'ForgotPasswordDocument' });
export type ForgotPasswordDocument = z.output<typeof ForgotPasswordDocument>;

/** `POST /auth/password/forgot`'s answer: the same whatever the address. */
export const ForgotPasswordAcceptedDocument = z
  .object({
    meta: z.object({
      message: z
        .string()
        .describe('Always: if the address is known, an email is on its way.'),
    }),
  })
  .meta({ id: 'ForgotPasswordAcceptedDocument' });

/** `POST /auth/password/link`: the link's token, to learn what it is for. */
export const SignInLinkQueryDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('SignInLink'),
      attributes: z.strictObject({ token: SentToken }),
    }),
  })
  .meta({ id: 'SignInLinkQueryDocument' });
export type SignInLinkQueryDocument = z.output<typeof SignInLinkQueryDocument>;

/** What a link is for, for the page it opens. */
export const SignInLinkDocument = z
  .object({
    meta: z.object({
      kind: z
        .enum(SIGN_IN_LINK_KINDS)
        .describe('`invite`: a first password; `reset`: a new one.'),
      name: z.string().describe('Whose link it is.'),
      email: z.string().nullable(),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  })
  .meta({ id: 'SignInLinkDocument' });

/** `POST /auth/password/set`. */
export const SetPasswordDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('PasswordSet'),
      attributes: z.strictObject({
        token: SentToken,
        password: SentPassword,
      }),
    }),
  })
  .meta({ id: 'SetPasswordDocument' });
export type SetPasswordDocument = z.output<typeof SetPasswordDocument>;

/** `POST /me/password`. */
export const ChangePasswordDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('PasswordChange'),
      attributes: z.strictObject({
        currentPassword: SentPassword,
        newPassword: SentPassword,
      }),
    }),
  })
  .meta({ id: 'ChangePasswordDocument' });
export type ChangePasswordDocument = z.output<typeof ChangePasswordDocument>;

export const PasswordChangedDocument = z
  .object({
    meta: z.object({
      sessionsEnded: z
        .number()
        .int()
        .describe('Your other sessions that ended (this one goes on).'),
    }),
  })
  .meta({ id: 'PasswordChangedDocument' });

/** A link just made for a person: shown once. */
export const SignInLinkMadeDocument = z
  .object({
    meta: z.object({
      token: z
        .string()
        .describe(
          'The link’s secret (`ccms_pwl_` and 64 hex digits), shown only now: give it to the person as the link below.',
        ),
      url: z
        .string()
        .nullable()
        .describe(
          'The link: `<editor>/set-password#<token>`, from `CCMS_PUBLIC_URL` (else `CCMS_EDITOR_URL`); null when neither is set (build it from the editor’s own address).',
        ),
      expiresAt: z.iso.datetime({ offset: true }),
      emailed: z
        .boolean()
        .describe('Whether it was emailed to the person’s address too.'),
    }),
  })
  .meta({ id: 'SignInLinkMadeDocument' });

/** `meta.signIn` of a `User`: how the person signs in. */
export const UserSignInMeta = z
  .object({
    password: z.boolean().describe('Has a password.'),
    provider: z
      .boolean()
      .describe('Has signed in with an identity provider at least once.'),
    inviteExpiresAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        'An open invite’s end (in the past: it ran out); null for none.',
      ),
  })
  .describe(
    'How the person signs in (#610): with a password, a provider, both, or invited and not yet signed in.',
  )
  .meta({ id: 'UserSignInMeta' });
