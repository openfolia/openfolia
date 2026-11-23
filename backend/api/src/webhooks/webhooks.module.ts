import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SecretSealer } from '../base/core/secret-sealer.js';
import type { Env } from '../config/env.js';
import { ContentModule } from '../content/content.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { DeliverWebhookJobHandler } from './api/deliver-webhook.handler.js';
import { WebhooksConsumer } from './api/webhooks-consumer.js';
import { WebhooksController } from './api/webhooks.controller.js';
import {
  DeliverWebhookAction,
  FailWebhookDeliveryAction,
} from './core/actions/deliver-webhook.action.js';
import { FanOutWebhooksAction } from './core/actions/fan-out-webhooks.action.js';
import {
  CreateWebhookAction,
  DeleteWebhookAction,
  GetWebhookAction,
  ListWebhookDeliveriesAction,
  ListWebhooksAction,
  RotateWebhookSecretAction,
  UpdateWebhookAction,
} from './core/actions/manage-webhooks.action.js';
import {
  RetryWebhookDeliveryAction,
  TestWebhookAction,
} from './core/actions/test-webhook.action.js';
import { PruneWebhookDeliveriesAction } from './core/actions/prune-webhook-deliveries.action.js';
import { WebhookEventBuilder } from './core/webhook-events.js';
import {
  WebhookOwners,
  WebhookSecrets,
  WebhookSender,
  WebhookSettings,
} from './core/webhook-ports.js';
import { WebhookStore } from './core/webhook-store.js';
import { DrizzleWebhookOwners } from './repos/drizzle-webhook-owners.js';
import { DrizzleWebhookStore } from './repos/drizzle-webhook-store.js';
import { NodeWebhookSender } from './repos/node-webhook-sender.js';
import { SealedWebhookSecrets } from './repos/sealed-webhook-secrets.js';

/**
 * Webhooks (#42): subscribers (`webhook.manage`), a second outbox consumer
 * (`WebhooksConsumer`) that turns released and imported content into
 * deliveries, judged by what each subscriber's owner may read, and a
 * background job per delivery (`webhook.deliver`) that signs and sends
 * it, retried with backoff. The secrets are sealed under the instance
 * secret key (`SecretSealer`, #470); off only when there is none.
 */
@Module({
  imports: [
    AccessModule,
    AuditModule,
    ContentModule,
    OutboxModule,
    ReleasesModule,
  ],
  controllers: [WebhooksController],
  providers: [
    {
      provide: WebhookSettings,
      inject: [ConfigService, SecretSealer],
      useFactory: (
        config: ConfigService<Env, true>,
        sealer: SecretSealer,
      ): WebhookSettings => {
        const settings: WebhookSettings = {
          // Read when asked: the key is opened as the server starts, after this is made.
          get enabled() {
            return sealer.available;
          },
          rules: {
            allowHttp: config.get('CCMS_WEBHOOKS_ALLOW_HTTP', { infer: true }),
            allowPrivate: config.get('CCMS_WEBHOOKS_ALLOW_PRIVATE', {
              infer: true,
            }),
          },
          timeoutMs: config.get('CCMS_WEBHOOKS_TIMEOUT_MS', { infer: true }),
          keepDays: config.get('CCMS_WEBHOOKS_KEEP_DAYS', { infer: true }),
        };
        if (settings.rules.allowHttp || settings.rules.allowPrivate) {
          new Logger('Webhooks').warn(
            'Webhooks may go to http:// URLs or private addresses (CCMS_WEBHOOKS_ALLOW_HTTP, CCMS_WEBHOOKS_ALLOW_PRIVATE): for local testing only.',
          );
        }
        return settings;
      },
    },
    { provide: WebhookSecrets, useClass: SealedWebhookSecrets },
    {
      provide: WebhookSender,
      inject: [WebhookSettings],
      useFactory: (settings: WebhookSettings) =>
        new NodeWebhookSender(settings.rules, settings.timeoutMs),
    },
    { provide: WebhookStore, useClass: DrizzleWebhookStore },
    { provide: WebhookOwners, useClass: DrizzleWebhookOwners },
    WebhookEventBuilder,
    ListWebhooksAction,
    GetWebhookAction,
    CreateWebhookAction,
    UpdateWebhookAction,
    DeleteWebhookAction,
    RotateWebhookSecretAction,
    ListWebhookDeliveriesAction,
    TestWebhookAction,
    RetryWebhookDeliveryAction,
    FanOutWebhooksAction,
    DeliverWebhookAction,
    FailWebhookDeliveryAction,
    PruneWebhookDeliveriesAction,
    DeliverWebhookJobHandler,
    WebhooksConsumer,
  ],
})
export class WebhooksModule {}
