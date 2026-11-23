import { readFileSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import type { SecretSealer } from '../../base/core/secret-sealer.js';
import type { Env } from '../../config/env.js';
import type { MailServer } from '../../config/mail-env.js';
import { StartupError } from '../../config/startup-error.js';
import type { MailLanguage } from '../core/mail.js';
import {
  type MailServerInfo,
  MailSettings,
  type MailState,
} from '../core/mail-ports.js';
import type { SmtpOptions } from './smtp-mailer.js';

/** A file's text without its final line break (how an editor or `echo` leaves a secret file). */
function readSecretFile(path: string, setting: string): string {
  let value: string;
  try {
    value = readFileSync(path, 'utf8');
  } catch {
    throw new StartupError(`${setting} names ${path}, which cannot be read.`);
  }
  value = value.replace(/\r?\n$/, '');
  if (value === '') throw new StartupError(`${setting} names an empty file.`);
  return value;
}

/**
 * `MailSettings` from `CCMS_MAIL_*` (#609), plus what the SMTP adapter needs to connect (the
 * password, read from `CCMS_MAIL_PASSWORD_FILE` when set: the file wins; the CA file). The state
 * is read when asked, as the secret key opens after this is made.
 */
export class EnvMailSettings extends MailSettings {
  readonly server: MailServerInfo | null;
  readonly from: string | null;
  readonly language: MailLanguage;
  readonly publicUrl: string | null;
  /** For `SmtpMailer`; null while no server is set. */
  readonly smtp: SmtpOptions | null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly sealer: SecretSealer,
  ) {
    super();
    const server = config.get('CCMS_MAIL_URL', { infer: true }) as
      MailServer | undefined;
    const requireTls = config.get('CCMS_MAIL_REQUIRE_TLS', { infer: true });
    const user = config.get('CCMS_MAIL_USER', { infer: true });
    const passwordFile = config.get('CCMS_MAIL_PASSWORD_FILE', {
      infer: true,
    });
    const caFile = config.get('CCMS_MAIL_CA_FILE', { infer: true });
    this.language = config.get('CCMS_MAIL_LANGUAGE', { infer: true });
    this.publicUrl = config.get('CCMS_PUBLIC_URL', { infer: true }) ?? null;
    if (!server) {
      this.server = null;
      this.from = null;
      this.smtp = null;
      return;
    }
    this.from = config.get('CCMS_MAIL_FROM', { infer: true }) ?? null;
    const pass = passwordFile
      ? readSecretFile(passwordFile, 'CCMS_MAIL_PASSWORD_FILE')
      : config.get('CCMS_MAIL_PASSWORD', { infer: true });
    this.server = {
      host: server.host,
      port: server.port,
      tls: server.implicitTls
        ? 'implicit'
        : requireTls
          ? 'starttls'
          : 'opportunistic',
      authenticated: user !== undefined,
    };
    this.smtp = {
      server,
      requireTls,
      auth: user !== undefined && pass !== undefined ? { user, pass } : null,
      ...(caFile !== undefined && {
        ca: readSecretFile(caFile, 'CCMS_MAIL_CA_FILE'),
      }),
    };
  }

  get state(): MailState {
    if (this.server === null || this.from === null) return 'off';
    return this.sealer.available ? 'on' : 'no-secret-key';
  }
}
