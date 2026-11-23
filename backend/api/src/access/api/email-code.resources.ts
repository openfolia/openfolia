import { z } from 'zod';

/** An email address as typed on the sign-in page: checked by the action, never echoed. */
const SentEmail = z.string().trim().min(1).max(320);

/** `POST /auth/email-code/request`. */
export const EmailCodeRequestDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('EmailCodeRequest'),
      attributes: z.strictObject({
        email: SentEmail,
        language: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/)
          .max(35)
          .optional()
          .describe(
            'The sign-in page’s language (`de`, `en-GB`): the email’s, when there is one in it; else the installation’s (`CCMS_MAIL_LANGUAGE`).',
          ),
      }),
    }),
  })
  .meta({ id: 'EmailCodeRequestDocument' });
export type EmailCodeRequestDocument = z.output<
  typeof EmailCodeRequestDocument
>;

/** `POST /auth/email-code/request`'s answer: the same whatever the address. */
export const EmailCodeRequestedDocument = z
  .object({
    meta: z.object({
      message: z
        .string()
        .describe('Always: if the address is known, a code is on its way.'),
    }),
  })
  .meta({ id: 'EmailCodeRequestedDocument' });

/** `POST /auth/email-code/sign-in`. */
export const EmailCodeSignInDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('EmailCodeSignIn'),
      attributes: z.strictObject({
        email: SentEmail,
        code: z
          .string()
          .min(1)
          .max(20)
          .describe(
            'The six digits from the email; spaces and dashes between them are ignored.',
          ),
      }),
    }),
  })
  .meta({ id: 'EmailCodeSignInDocument' });
export type EmailCodeSignInDocument = z.output<typeof EmailCodeSignInDocument>;

/** `POST /auth/email-code/link`: the token after `#` in the email's link. */
export const EmailCodeLinkDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('EmailCodeLink'),
      attributes: z.strictObject({ token: z.string().min(1).max(200) }),
    }),
  })
  .meta({ id: 'EmailCodeLinkDocument' });
export type EmailCodeLinkDocument = z.output<typeof EmailCodeLinkDocument>;
