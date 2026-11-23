import { Injectable, Logger } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { SecretSealer } from '../../../base/core/secret-sealer.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { MAIL_ACTOR, mailSubject } from '../mail.js';
import {
  mailParamsContext,
  MailBrandSource,
  Mailer,
  MailSendError,
  MailSettings,
  MailStore,
  type StoredMail,
} from '../mail-ports.js';
import { renderMail } from '../templates/render.js';
import { isMailTemplateName } from '../templates/templates.js';

/** How long a queued email may wait before it counts as stale (its job is long gone): two days. */
export const STALE_AFTER_MS = 2 * 86_400_000;
/** Stale rows removed after one send, at most. */
export const STALE_BATCH = 100;

/**
 * An attempt that failed and is tried again (the job's retry). Its message names the email and
 * the error's kind, never an address or the server's reply: the job keeps it.
 */
export class MailAttemptFailed extends Error {
  constructor(messageId: string, kind: string, code: string) {
    super(`Email ${messageId} was not sent (${kind} ${code}); retried.`);
    this.name = 'MailAttemptFailed';
  }
}

/** Why an email failed for good, as `mail.failed` records it. */
export type MailFailure =
  'rejected' | 'unavailable' | 'tls' | 'auth' | 'unreadable' | 'off';

/**
 * Marks a queued email as failed for good (#609): removes its row and records `mail.failed`
 * (the message ID, its template and why; never the address or what it said), in one
 * transaction, once: gone already, nothing. Called by `SendMailAction` and by the job once its
 * last attempt failed (`reason` then the last attempt's error kind, `unavailable` if none).
 */
@Injectable()
export class FailMailAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: MailStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({
    messageId,
    reason,
  }: {
    messageId: string;
    reason?: MailFailure;
  }): Promise<void> {
    const mail = await this.store.find(messageId);
    if (!mail) return;
    const why = reason ?? lastError(mail) ?? 'unavailable';
    await this.unit.run(async (tx) => {
      if (!(await this.store.remove(tx, mail.id))) return;
      await this.auditLog.record(tx, MAIL_ACTOR, {
        action: 'mail.failed',
        subject: mailSubject(mail.id),
        data: {
          template: mail.template,
          reason: why,
          attempts: mail.attempts + (reason === 'rejected' ? 1 : 0),
        },
      });
    }, BOUNDED);
  }
}

/**
 * Sends one queued email (`mail.send`, #609): reads its row, opens its params, renders it in its
 * language with the branding as it is now, sends it and removes the row, so nothing of it stays.
 * Gone already (sent by an earlier attempt): nothing. A failure the server gives as final (5xx),
 * params that do not open (another key) or a template this server does not know: failed for good
 * at once (`mail.failed`); any other failure throws, and the job tries again. Runs at least once:
 * an attempt cut off after the server took the email and before the row went sends it again.
 */
@Injectable()
export class SendMailAction implements UnguardedAction {
  readonly policy = 'internal';
  private readonly logger = new Logger('Mail');
  now: () => number = Date.now;

  constructor(
    private readonly store: MailStore,
    private readonly settings: MailSettings,
    private readonly sealer: SecretSealer,
    private readonly brand: MailBrandSource,
    private readonly mailer: Mailer,
    private readonly fail: FailMailAction,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({
    messageId,
    signal,
  }: {
    messageId: string;
    signal?: AbortSignal;
  }): Promise<'sent' | 'failed' | 'gone'> {
    const mail = await this.store.find(messageId);
    if (!mail) return 'gone';
    const from = this.settings.from;
    if (this.settings.state !== 'on' || from === null) {
      // Turned off since it was queued (the server, or the key): it can never be sent here.
      await this.fail.handle({ messageId, reason: 'off' });
      return 'failed';
    }
    let params: unknown;
    try {
      params = JSON.parse(
        this.sealer.open(mail.paramsSealed, mailParamsContext(mail.id)),
      );
    } catch {
      await this.fail.handle({ messageId, reason: 'unreadable' });
      return 'failed';
    }
    if (!isMailTemplateName(mail.template)) {
      await this.fail.handle({ messageId, reason: 'unreadable' });
      return 'failed';
    }
    const rendered = renderMail({
      template: mail.template,
      params,
      language: mail.language,
      to: { address: mail.toAddress, name: mail.toName },
      from,
      brand: await this.brand.read(),
      publicUrl: this.settings.publicUrl,
    });
    try {
      await this.mailer.send(rendered, signal);
    } catch (error) {
      return this.failed(mail, error);
    }
    await this.unit.run((tx) => this.store.remove(tx, mail.id), BOUNDED);
    await this.removeStale();
    return 'sent';
  }

  private async failed(mail: StoredMail, error: unknown): Promise<'failed'> {
    const sendError =
      error instanceof MailSendError
        ? error
        : new MailSendError('unavailable', errorCode(error));
    if (sendError.final) {
      await this.fail.handle({ messageId: mail.id, reason: sendError.kind });
      return 'failed';
    }
    await this.store.recordFailure(mail.id, sendError.kind);
    throw new MailAttemptFailed(mail.id, sendError.kind, sendError.code);
  }

  /** Emails whose job the queue dropped unsent: never sent now, so not kept. */
  private async removeStale(): Promise<void> {
    try {
      const removed = await this.store.removeStale(
        new Date(this.now() - STALE_AFTER_MS),
        STALE_BATCH,
      );
      if (removed > 0) {
        this.logger.warn(
          `Removed ${removed} emails that waited more than two days unsent.`,
        );
      }
    } catch {
      // The next send tries again.
    }
  }
}

const FAILURES: ReadonlySet<string> = new Set<MailFailure>([
  'rejected',
  'unavailable',
  'tls',
  'auth',
  'unreadable',
  'off',
]);

function lastError(mail: StoredMail): MailFailure | undefined {
  const error = mail.lastError;
  return error !== null && FAILURES.has(error)
    ? (error as MailFailure)
    : undefined;
}

/** An error's code only (never its message, which may hold an address or a reply). */
function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}
