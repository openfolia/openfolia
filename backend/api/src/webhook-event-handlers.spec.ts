import { readdirSync, readFileSync } from 'node:fs';
import { DiscoveryService } from '@nestjs/core';
import { createTestApp } from '../tests/test-app.js';
import { WebhookEventHandler } from './webhooks/core/webhook-event-handler.js';
import { REGISTERED_WEBHOOK_EVENTS } from './webhook-events.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SRC = new URL('./', import.meta.url);

/** A handler's class, made here without its dependencies. */
type HandlerClass = new (...args: never[]) => WebhookEventHandler;

/**
 * Every class in `src/` (specs left out) declared as `extends WebhookEventHandler`, with the
 * folder of its file and the group it says it handles.
 */
async function definedHandlers() {
  const found: { folder: string; handler: HandlerClass; group: string }[] = [];
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
  );
  for (const file of files) {
    const text = readFileSync(new URL(file, SRC), 'utf8');
    const names = [
      ...text.matchAll(/class\s+(\w+)\s+extends\s+WebhookEventHandler\b/g),
    ].map((m) => m[1]!);
    if (names.length === 0) continue;
    const module = (await import(
      new URL(file.replace(/\.ts$/, '.js'), SRC).href
    )) as Record<string, unknown>;
    for (const name of names) {
      const handler = module[name];
      // A handler the folder check cannot see (not exported) is no handler of the app either.
      if (typeof handler !== 'function')
        throw new Error(`${file}: ${name} is not exported`);
      // Its group is a field: made without its dependencies, none of which it reads to say it.
      const { group } = new (handler as HandlerClass)();
      found.push({
        folder: file.split('/')[0]!,
        handler: handler as HandlerClass,
        group,
      });
    }
  }
  return found;
}

describe('the webhook event handlers', () => {
  it('are each defined in the folder of the component whose group they handle, one per registered group', async () => {
    const defined = await definedHandlers();
    // So no component handles another's events: the registry trusts the group a handler names.
    for (const { folder, group } of defined) expect(group).toBe(folder);
    expect(defined.map((d) => d.group).sort()).toEqual(
      [...new Set(REGISTERED_WEBHOOK_EVENTS.map((e) => e.group))].sort(),
    );
  });

  it('are what the app loads: exactly those classes, each once', async () => {
    const defined = await definedHandlers();
    const t = await createTestApp();
    try {
      const loaded = t.app
        .get(DiscoveryService)
        .getProviders()
        .map((w) => w.instance as unknown)
        .filter(
          (i): i is WebhookEventHandler => i instanceof WebhookEventHandler,
        );
      // A handler made some other way (a subclass of a subclass, a factory) is not one of them.
      const byName = (a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name);
      expect(loaded.map((h) => h.constructor).sort(byName)).toEqual(
        defined.map((d) => d.handler).sort(byName),
      );
    } finally {
      await t.close();
    }
  });
});
