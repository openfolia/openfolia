import { z } from 'zod';
import type { MailLanguage } from '../mail.js';
import type { MailContent } from './layout.js';

/** What a template's words are made from besides its params. */
export interface TemplateContext {
  readonly productName: string;
  /**
   * `path` under `CCMS_PUBLIC_URL` (`invite/abc`, no leading `/`) as an absolute URL; null when
   * no public URL is set.
   */
  readonly link: (path: string) => string | null;
}

/** One kind of email: its params' schema and its words in each language. */
export interface MailTemplate<P extends Record<string, unknown>> {
  readonly name: string;
  /**
   * Checked when an email is queued and again before it is sent. Params are small and plain
   * (IDs, a link's token, a name): never a whole text, never markup.
   */
  readonly params: z.ZodType<P>;
  readonly texts: Readonly<
    Record<
      MailLanguage,
      (params: P, context: TemplateContext) => Omit<MailContent, 'footer'>
    >
  >;
}

const define = <P extends Record<string, unknown>>(
  template: MailTemplate<P>,
): MailTemplate<P> => template;

/** The test email of Admin › System › Email. */
export const TEST_MAIL = define({
  name: 'test',
  params: z.strictObject({}),
  texts: {
    en: (_, { productName, link }) => {
      const home = link('');
      return {
        subject: `Test email from ${productName}`,
        heading: 'Email works',
        paragraphs: [
          `This is a test email from ${productName}. If you can read it, ${productName} can send email through your mail server.`,
        ],
        action: home ? { label: `Open ${productName}`, href: home } : null,
        reason:
          'You get this email because you sent a test email from Admin › System.',
      };
    },
    de: (_, { productName, link }) => {
      const home = link('');
      return {
        subject: `Test-E-Mail von ${productName}`,
        heading: 'E-Mail funktioniert',
        paragraphs: [
          `Dies ist eine Test-E-Mail von ${productName}. Wenn Sie sie lesen können, kann ${productName} E-Mails über Ihren Mailserver senden.`,
        ],
        action: home ? { label: `${productName} öffnen`, href: home } : null,
        reason:
          'Sie erhalten diese E-Mail, weil Sie unter Admin › System eine Test-E-Mail gesendet haben.',
      };
    },
  },
});

/**
 * A one-time link's token (#610, `access/core/sign-in-links.ts`): its prefix and 64 hex digits.
 * The link opens the editor's page to set a password, the token after `#`.
 */
const LinkToken = z.string().regex(/^ccms_pwl_[0-9a-f]{64}$/);

const setPasswordLink = (
  link: TemplateContext['link'],
  token: string,
): string => {
  const href = link(`set-password#${token}`);
  // Queued only with a public URL (`MailOutbox.linksEnabled`): without one, nothing to open.
  if (href === null) throw new Error('A sign-in link needs CCMS_PUBLIC_URL.');
  return href;
};

/** An invite (#610): a person an admin added picks their password and is signed in. */
export const INVITE_MAIL = define({
  name: 'invite',
  params: z.strictObject({
    token: LinkToken,
    /** How many days the link is valid. */
    days: z.number().int().min(1).max(90),
  }),
  texts: {
    en: ({ token, days }, { productName, link }) => ({
      subject: `You are invited to ${productName}`,
      heading: `Welcome to ${productName}`,
      paragraphs: [
        `An administrator added you to ${productName}. Choose your password to sign in.`,
        `The link works once and for ${days === 1 ? '1 day' : `${days} days`}. If it has run out, ask your administrator for a new one.`,
      ],
      action: {
        label: 'Choose your password',
        href: setPasswordLink(link, token),
      },
      reason: `You get this email because an administrator of ${productName} invited this address.`,
    }),
    de: ({ token, days }, { productName, link }) => ({
      subject: `Einladung zu ${productName}`,
      heading: `Willkommen bei ${productName}`,
      paragraphs: [
        `Eine Administratorin oder ein Administrator hat Sie zu ${productName} hinzugefügt. Wählen Sie Ihr Passwort, um sich anzumelden.`,
        `Der Link funktioniert einmal und ${days === 1 ? '1 Tag' : `${days} Tage`} lang. Ist er abgelaufen, bitten Sie um einen neuen.`,
      ],
      action: { label: 'Passwort wählen', href: setPasswordLink(link, token) },
      reason: `Sie erhalten diese E-Mail, weil diese Adresse zu ${productName} eingeladen wurde.`,
    }),
  },
});

/** A password reset (#610): "Forgot password", or a reset link an admin made. */
export const PASSWORD_RESET_MAIL = define({
  name: 'password-reset',
  params: z.strictObject({ token: LinkToken }),
  texts: {
    en: ({ token }, { productName, link }) => ({
      subject: `Reset your ${productName} password`,
      heading: 'Choose a new password',
      paragraphs: [
        `Someone asked to reset the password of your ${productName} account. Choose a new one with the link below; it works once, for 1 hour.`,
        'If you did not ask for this, you can ignore this email: your password stays as it is.',
      ],
      action: {
        label: 'Choose a new password',
        href: setPasswordLink(link, token),
      },
      reason: `You get this email because a password reset was asked for this address at ${productName}.`,
    }),
    de: ({ token }, { productName, link }) => ({
      subject: `Passwort für ${productName} zurücksetzen`,
      heading: 'Neues Passwort wählen',
      paragraphs: [
        `Für Ihr Konto bei ${productName} wurde ein neues Passwort angefordert. Wählen Sie es über den Link unten; er funktioniert einmal, 1 Stunde lang.`,
        'Wenn Sie das nicht angefordert haben, können Sie diese E-Mail ignorieren: Ihr Passwort bleibt, wie es ist.',
      ],
      action: {
        label: 'Neues Passwort wählen',
        href: setPasswordLink(link, token),
      },
      reason: `Sie erhalten diese E-Mail, weil für diese Adresse bei ${productName} ein neues Passwort angefordert wurde.`,
    }),
  },
});

/** A code-by-email link's token (#634, `access/core/email-codes.ts`): its prefix and 64 hex digits. */
const CodeLinkToken = z.string().regex(/^ccms_ecl_[0-9a-f]{64}$/);

/**
 * A one-time code to sign in (#634), and a link that signs in at once: asked for on the sign-in
 * page. The link only with a public URL (`CCMS_PUBLIC_URL`); without one, the code alone.
 */
export const EMAIL_CODE_MAIL = define({
  name: 'email-code',
  params: z.strictObject({
    code: z.string().regex(/^[0-9]{6}$/),
    token: CodeLinkToken,
    /** How many minutes the code and the link work. */
    minutes: z.number().int().min(1).max(60),
  }),
  texts: {
    en: ({ code, token, minutes }, { productName, link }) => {
      const href = link(`sign-in-code#${token}`);
      return {
        subject: `Your sign-in code for ${productName}`,
        heading: 'Your sign-in code',
        paragraphs: [
          `Enter this code on the ${productName} sign-in page${href ? ', or sign in with the button below' : ''}. It works once, for ${minutes === 1 ? '1 minute' : `${minutes} minutes`}.`,
        ],
        code,
        action: href ? { label: `Sign in to ${productName}`, href } : null,
        reason: `You get this email because someone asked to sign in to ${productName} with this address. If it was not you, ignore it: nobody can sign in without the code.`,
      };
    },
    de: ({ code, token, minutes }, { productName, link }) => {
      const href = link(`sign-in-code#${token}`);
      return {
        subject: `Ihr Anmeldecode für ${productName}`,
        heading: 'Ihr Anmeldecode',
        paragraphs: [
          `Geben Sie diesen Code auf der Anmeldeseite von ${productName} ein${href ? ' oder melden Sie sich mit der Schaltfläche unten an' : ''}. Er funktioniert einmal, ${minutes === 1 ? '1 Minute' : `${minutes} Minuten`} lang.`,
        ],
        code,
        action: href ? { label: `Bei ${productName} anmelden`, href } : null,
        reason: `Sie erhalten diese E-Mail, weil mit dieser Adresse eine Anmeldung bei ${productName} angefordert wurde. Waren Sie das nicht, ignorieren Sie sie: Ohne den Code kann sich niemand anmelden.`,
      };
    },
  },
});

/** Every template, by name: a later issue adds its own (notifications). */
export const MAIL_TEMPLATES = {
  test: TEST_MAIL,
  invite: INVITE_MAIL,
  'password-reset': PASSWORD_RESET_MAIL,
  'email-code': EMAIL_CODE_MAIL,
} as const satisfies Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MailTemplate<any>
>;

export type MailTemplateName = keyof typeof MAIL_TEMPLATES;

/** The params a template takes. */
export type MailParams<N extends MailTemplateName> = z.input<
  (typeof MAIL_TEMPLATES)[N]['params']
>;

export const isMailTemplateName = (name: string): name is MailTemplateName =>
  Object.hasOwn(MAIL_TEMPLATES, name);

/** The footer line in each language: who sent it, and where it lives. */
export function footer(
  language: MailLanguage,
  productName: string,
  publicUrl: string | null,
): string {
  const sent =
    language === 'de'
      ? `Gesendet von ${productName}`
      : `Sent by ${productName}`;
  return publicUrl ? `${sent} · ${publicUrl}` : sent;
}
