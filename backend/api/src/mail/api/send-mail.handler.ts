import { Injectable } from '@nestjs/common';
import { type JobContext, JobHandler } from '../../jobs/core/job.js';
import {
  FailMailAction,
  SendMailAction,
} from '../core/actions/send-mail.action.js';
import { SEND_MAIL, type SendMailPayload } from '../core/mail-job.js';

/** Runs `mail.send` jobs: `SendMailAction`, and `FailMailAction` once one failed for good. */
@Injectable()
export class SendMailJobHandler extends JobHandler<SendMailPayload> {
  readonly kind = SEND_MAIL;

  constructor(
    private readonly send: SendMailAction,
    private readonly fail: FailMailAction,
  ) {
    super();
  }

  async run(payload: SendMailPayload, context: JobContext): Promise<void> {
    await this.send.handle({
      messageId: payload.messageId,
      signal: context.signal,
    });
  }

  override failed(payload: SendMailPayload): Promise<void> {
    return this.fail.handle({ messageId: payload.messageId });
  }
}
