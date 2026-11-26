import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import { SECOND_STEPS } from '../core/pending-sign-ins.js';

/** A code as typed: of the app, or a recovery code; read by the action. */
const SentCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe(
    'The six digits the authenticator app shows, or a recovery code; spaces and dashes are left out.',
  );

const SentPassword = z.string().min(1).max(1024);

const RecoveryCodes = z
  .array(z.string())
  .describe(
    'Ten recovery codes, each for one sign-in without the app. Shown only now: only hashes are kept.',
  );

/** A set-up begun: shown to the person once. */
const SetUpMeta = z.object({
  secret: z
    .string()
    .describe(
      'The secret in base32, to type into an app that cannot scan. Shown only now.',
    ),
  otpauthUrl: z
    .string()
    .describe(
      'The same as the QR code holds (`otpauth://totp/…`), to open an app on this device.',
    ),
  qrCode: z
    .string()
    .describe('The QR code as an SVG, black on white with its quiet zone.'),
  account: z.string().describe('The account as the app lists it.'),
});

export const SecondFactorSetUpDocument = z
  .object({ meta: SetUpMeta })
  .meta({ id: 'SecondFactorSetUpDocument' });

export const SecondFactorResource = resourceObject('SecondFactor', {
  attributes: z.object({
    enabledAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('Since when it is on; null: off.'),
  }),
  meta: z.object({
    recoveryCodesLeft: z.number().int().describe('Recovery codes not used.'),
    required: z
      .boolean()
      .describe('The installation requires it of you (`GET /settings`).'),
    available: z
      .boolean()
      .describe(
        'It can be set up: the server has an instance secret key to seal the secret with.',
      ),
    hasPassword: z
      .boolean()
      .describe(
        'You have a password: setting it up asks for it, and it proves you for a change.',
      ),
  }),
})
  .describe('Your own second factor. `id` is always `own`.')
  .meta({ id: 'SecondFactorResource' });

export const SecondFactorDocument = singleDocument(SecondFactorResource).meta({
  id: 'SecondFactorDocument',
});

/** `POST /me/second-factor/set-up`. */
export const BeginSecondFactorDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('SecondFactorSetUp'),
      attributes: z.strictObject({
        password: SentPassword.optional().describe(
          'Your password; needed when you have one.',
        ),
      }),
    }),
  })
  .meta({ id: 'BeginSecondFactorDocument' });
export type BeginSecondFactorDocument = z.output<
  typeof BeginSecondFactorDocument
>;

/** A code alone: confirming a set-up, or the second step of a sign-in. */
export const SecondFactorCodeDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('SecondFactorCode'),
      attributes: z.strictObject({ code: SentCode }),
    }),
  })
  .meta({ id: 'SecondFactorCodeDocument' });
export type SecondFactorCodeDocument = z.output<
  typeof SecondFactorCodeDocument
>;

/** Proof it is still you: your password, or a code. */
export const SecondFactorProofDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('SecondFactorProof'),
      attributes: z
        .strictObject({
          password: SentPassword.optional(),
          code: SentCode.optional(),
        })
        .refine(
          (proof) =>
            (proof.password === undefined) !== (proof.code === undefined),
          { message: 'Give either the password or a code.' },
        ),
    }),
  })
  .meta({ id: 'SecondFactorProofDocument' });
export type SecondFactorProofDocument = z.output<
  typeof SecondFactorProofDocument
>;

export const SecondFactorOnDocument = z
  .object({
    meta: z.object({
      recoveryCodes: RecoveryCodes,
      sessionsEnded: z
        .number()
        .int()
        .describe('Your other sessions that ended (this one goes on).'),
    }),
  })
  .meta({ id: 'SecondFactorOnDocument' });

export const RecoveryCodesDocument = z
  .object({ meta: z.object({ recoveryCodes: RecoveryCodes }) })
  .meta({ id: 'RecoveryCodesDocument' });

/** `GET /auth/second-factor`: the second step open in this browser. */
export const SecondStepDocument = z
  .object({
    meta: z.object({
      secondFactor: z
        .enum(SECOND_STEPS)
        .describe(
          '`verify`: a code for a second factor that is on; `set-up`: turn one on first, the installation requires it.',
        ),
      email: z.string().nullable().describe('Whose sign-in it is.'),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  })
  .meta({ id: 'SecondStepDocument' });

export const SecondStepDoneDocument = z
  .object({
    meta: z.object({
      userId: z.string().describe('Who is signed in now.'),
    }),
  })
  .meta({ id: 'SecondStepDoneDocument' });

export const SecondStepSetUpDoneDocument = z
  .object({
    meta: z.object({
      userId: z.string().describe('Who is signed in now.'),
      recoveryCodes: RecoveryCodes,
    }),
  })
  .meta({ id: 'SecondStepSetUpDoneDocument' });
