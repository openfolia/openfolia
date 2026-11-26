import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { WebhookEventHandlersLoader } from './api/webhook-event-handlers.loader.js';
import { WebhookEventHandlers } from './core/webhook-event-handler.js';
import { WebhookEventBuilder } from './core/webhook-events.js';

/**
 * How webhook events are made (#974): every component's `WebhookEventHandler`, loaded as the app
 * starts, and `WebhookEventBuilder`, for the webhooks and the change feed (#43) alike. No
 * routes: importing it changes nothing a request reaches.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    // Filled with every component's handler as the app starts (`WebhookEventHandlersLoader`).
    {
      provide: WebhookEventHandlers,
      useFactory: () => new WebhookEventHandlers(),
    },
    WebhookEventHandlersLoader,
    WebhookEventBuilder,
  ],
  exports: [WebhookEventHandlers, WebhookEventBuilder],
})
export class WebhookEventsModule {}
