import { type SendResult, WebhookSender } from '../core/webhook-ports.js';

/**
 * The `WebhookSender` of a public sandbox (#826): never connects anywhere, whatever the
 * subscriber's URL. Each attempt fails as `blocked-url` at once, so a delivery ends as failed
 * after its retries, with nothing sent.
 */
export class SandboxWebhookSender extends WebhookSender {
  send(): Promise<SendResult> {
    return Promise.resolve({
      ok: false,
      error: 'blocked-url',
      statusCode: null,
    });
  }
}
