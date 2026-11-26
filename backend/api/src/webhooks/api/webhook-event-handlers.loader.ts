import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  WebhookEventHandler,
  WebhookEventHandlers,
} from '../core/webhook-event-handler.js';

/**
 * Loads every `WebhookEventHandler` among the app's providers (each component provides its own)
 * into `WebhookEventHandlers` as the app starts, before it serves a request or reads the outbox:
 * a registered group without its handler stops the API there (`WebhookEventHandlers.load`).
 */
@Injectable()
export class WebhookEventHandlersLoader implements OnModuleInit {
  constructor(
    private readonly handlers: WebhookEventHandlers,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit(): void {
    // Every provider is made before any is initialised: all handlers are there.
    this.handlers.load(
      this.discovery
        .getProviders()
        .map((wrapper) => wrapper.instance as unknown)
        .filter(
          (instance): instance is WebhookEventHandler =>
            instance instanceof WebhookEventHandler,
        ),
    );
  }
}
