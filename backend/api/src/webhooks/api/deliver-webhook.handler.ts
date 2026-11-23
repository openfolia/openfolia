import { Injectable } from '@nestjs/common';
import { type JobContext, JobHandler } from '../../jobs/core/job.js';
import {
  DeliverWebhookAction,
  FailWebhookDeliveryAction,
} from '../core/actions/deliver-webhook.action.js';
import {
  DELIVER_WEBHOOK,
  type DeliverWebhookPayload,
} from '../core/webhook-job.js';

/** Runs `webhook.deliver` jobs: `DeliverWebhookAction`, and `FailWebhookDeliveryAction` once one failed for good. */
@Injectable()
export class DeliverWebhookJobHandler extends JobHandler<DeliverWebhookPayload> {
  readonly kind = DELIVER_WEBHOOK;

  constructor(
    private readonly deliver: DeliverWebhookAction,
    private readonly fail: FailWebhookDeliveryAction,
  ) {
    super();
  }

  async run(
    payload: DeliverWebhookPayload,
    context: JobContext,
  ): Promise<void> {
    await this.deliver.handle({
      deliveryId: payload.deliveryId,
      deferrals: payload.deferrals ?? 0,
      lastAttempt: context.lastAttempt,
      signal: context.signal,
    });
  }

  override failed(payload: DeliverWebhookPayload): Promise<void> {
    return this.fail.handle({ deliveryId: payload.deliveryId });
  }
}
