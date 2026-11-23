import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import type {
  MailSettingsReport,
  QueuedTestMail,
} from '../core/actions/mail-settings.actions.js';
import { MAIL_LANGUAGE_VALUES } from '../core/mail.js';

const Language = z.enum(MAIL_LANGUAGE_VALUES);

export const MailSettingsResource = resourceObject('MailSettings', {
  attributes: z.object({
    state: z
      .enum(['on', 'off', 'no-secret-key'])
      .describe(
        '`on`: emails are sent. `off`: no mail server is set (`CCMS_MAIL_URL`); what would be emailed is offered as a link to copy. `no-secret-key`: a server is set, but the instance has no secret key (`CCMS_SECRET_KEY`, or the key file), which seals what a queued email holds; emails are off until there is one.',
      ),
    host: z
      .string()
      .nullable()
      .describe('The mail server’s host; null while none is set.'),
    port: z
      .number()
      .int()
      .nullable()
      .describe('Its port; null while none is set.'),
    tls: z
      .enum(['implicit', 'starttls', 'opportunistic'])
      .nullable()
      .describe(
        'How the connection is protected: `implicit` (`smtps://`, TLS from the start), `starttls` (`smtp://`, STARTTLS required: nothing is sent without it), `opportunistic` (`smtp://` with `CCMS_MAIL_REQUIRE_TLS=false`: STARTTLS when offered). The certificate is always verified. Null while no server is set.',
      ),
    authenticated: z
      .boolean()
      .describe(
        'Whether the server is signed in to (`CCMS_MAIL_USER`). Never the user or the password.',
      ),
    from: z
      .string()
      .nullable()
      .describe(
        'The sender’s address (`CCMS_MAIL_FROM`); null while no server is set.',
      ),
    senderName: z
      .string()
      .describe('The sender’s name: the branding’s product name.'),
    language: Language.describe(
      'The language of an email to someone whose language is not known (`CCMS_MAIL_LANGUAGE`).',
    ),
  }),
})
  .describe(
    '`id` is always `instance`. Read-only: the settings are in the environment.',
  )
  .meta({ id: 'MailSettingsResource' });

export const MailSettingsDocument = singleDocument(MailSettingsResource).meta({
  id: 'MailSettingsDocument',
});

export function toMailSettingsDocument(
  report: MailSettingsReport,
): z.infer<typeof MailSettingsDocument> {
  return {
    data: {
      type: 'MailSettings',
      id: 'instance',
      attributes: {
        state: report.state,
        host: report.server?.host ?? null,
        port: report.server?.port ?? null,
        tls: report.server?.tls ?? null,
        authenticated: report.server?.authenticated ?? false,
        from: report.from,
        senderName: report.senderName,
        language: report.language,
      },
    },
  };
}

/** `POST /mail/test`. */
export const SendTestMailDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('MailTest'),
      attributes: z
        .strictObject({
          language: Language.optional().describe(
            'The language to write it in (the editor’s); left out, the installation’s.',
          ),
        })
        .optional(),
    }),
  })
  .meta({ id: 'SendTestMailDocument' });
export type SendTestMailDocument = z.output<typeof SendTestMailDocument>;

export const MailMessageResource = resourceObject('MailMessage', {
  attributes: z.object({
    template: z.literal('test').describe('What kind of email it is.'),
    to: z.string().describe('The address it goes to: the administrator’s own.'),
    language: Language.describe('The language it is written in.'),
    status: z
      .literal('queued')
      .describe(
        'Queued: it is sent in the background, retried for about half an hour; a failure for good is in the audit log (`mail.failed`).',
      ),
  }),
})
  .describe('`id` is the message’s ID (a UUID), as the audit log names it.')
  .meta({ id: 'MailMessageResource' });

export const MailMessageDocument = singleDocument(MailMessageResource).meta({
  id: 'MailMessageDocument',
});

export function toMailMessageDocument(
  queued: QueuedTestMail,
): z.infer<typeof MailMessageDocument> {
  return {
    data: {
      type: 'MailMessage',
      id: queued.id,
      attributes: {
        template: 'test',
        to: queued.to,
        language: queued.language,
        status: 'queued',
      },
    },
  };
}
