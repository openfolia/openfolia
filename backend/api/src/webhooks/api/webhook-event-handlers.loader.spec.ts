import 'reflect-metadata';
import { Injectable, Module, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  type OutgoingEvent,
  WebhookEventHandler,
  WebhookEventHandlers,
} from '../core/webhook-event-handler.js';
import { WebhookEventHandlersLoader } from './webhook-event-handlers.loader.js';

abstract class Stub extends WebhookEventHandler {
  async build(): Promise<OutgoingEvent[]> {
    return [];
  }
  coversAnyOwner(): boolean {
    return true;
  }
}
@Injectable()
class Releases extends Stub {
  readonly group = 'releases';
}
@Injectable()
class ChangeSets extends Stub {
  readonly group = 'change-sets';
}
@Injectable()
class Translations extends Stub {
  readonly group = 'translations';
}

/** As a component provides its handler: in its own module. */
@Module({ providers: [Translations] })
class TranslationsComponent {}

/** The app's start with `providers` and the components given: the loader runs as it initialises. */
async function start(providers: Type<Stub>[], imports: Type[] = []) {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule, ...imports],
    providers: [
      {
        provide: WebhookEventHandlers,
        useFactory: () => new WebhookEventHandlers(),
      },
      WebhookEventHandlersLoader,
      ...providers,
    ],
  }).compile();
  await ref.init();
  return ref;
}

describe('WebhookEventHandlersLoader', () => {
  it('loads every component’s handler as the app starts, from any module', async () => {
    const ref = await start([Releases, ChangeSets], [TranslationsComponent]);
    const handlers = ref.get(WebhookEventHandlers);
    expect(handlers.ofTopic('release.published')).toBe(ref.get(Releases));
    expect(handlers.ofTopic('translation.imported')).toBeInstanceOf(
      Translations,
    );
    await ref.close();
  });

  it('stops the start when a registered group has no handler', async () => {
    await expect(start([Releases, ChangeSets])).rejects.toThrow(
      /No webhook event handler for translations/,
    );
  });
});
