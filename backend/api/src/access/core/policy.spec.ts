import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { actorWith, NOBODY } from '../../../tests/fakes/actors.js';
import { ForbiddenError } from '../../base/core/errors.js';
import type { Actor } from './actor.js';
import { PERMISSIONS } from './permissions.js';
import { ActorAction, authorize, type Policy } from './policy.js';

describe('authorize', () => {
  it('lets an actor holding the permission in some role through', () => {
    for (const permission of PERMISSIONS) {
      expect(() =>
        authorize(actorWith([permission], { languages: ['de'] }), permission),
      ).not.toThrow();
    }
    expect(() => authorize(NOBODY, 'any-actor')).not.toThrow();
  });

  it('refuses one without it, and fails closed on anything else', () => {
    expect(() => authorize(NOBODY, 'content.read')).toThrow(ForbiddenError);
    expect(() =>
      authorize(actorWith(['content.read']), 'content.read.draft'),
    ).toThrow('This needs the content.read.draft permission.');
    expect(() => authorize(undefined, 'any-actor')).toThrow(ForbiddenError);
    expect(() =>
      authorize(actorWith([...PERMISSIONS]), 'public' as never),
    ).toThrow(ForbiddenError);
  });
});

/** Every exported `…Action` class in `src/**\/*.action.ts`. */
async function everyAction(): Promise<[string, new () => object][]> {
  const src = join(import.meta.dirname, '../..');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.action.ts'))
    .sort();
  const found: [string, new () => object][] = [];
  for (const file of files) {
    const exports = (await import(join(src, file))) as Record<string, unknown>;
    const actions = Object.entries(exports).filter(
      (entry): entry is [string, new () => object] =>
        typeof entry[1] === 'function' && entry[0].endsWith('Action'),
    );
    expect([file, actions.length]).not.toEqual([file, 0]);
    found.push(...actions);
  }
  return found;
}

const actions = await everyAction();
const UNGUARDED: readonly Policy[] = ['public', 'internal'];

describe('every action', () => {
  it('is found', () => {
    expect(actions.length).toBeGreaterThanOrEqual(15);
  });

  // Constructed without its dependencies: the check must come before any
  // use of them, so an action that reads first fails with a TypeError.
  const instances = actions.map(([name, Action]) => ({
    name,
    action: Reflect.construct(Action, []) as { policy?: unknown },
  }));

  it.each(instances)('$name declares its policy', ({ action }) => {
    expect([...PERMISSIONS, 'any-actor', ...UNGUARDED]).toContain(
      action.policy,
    );
  });

  it.each(instances)(
    '$name checks it before anything else, in the inherited handle()',
    async ({ action }) => {
      if (UNGUARDED.includes(action.policy as Policy)) {
        // Acting for nobody: not an ActorAction at all.
        expect(action).not.toBeInstanceOf(ActorAction);
        return;
      }
      expect(action).toBeInstanceOf(ActorAction);
      // Inherited unchanged, also through any class in between.
      expect((action as ActorAction<never, unknown>).handle).toBe(
        ActorAction.prototype.handle,
      );
      const guarded = action as ActorAction<{ actor: Actor }, unknown>;
      await expect(guarded.handle(undefined as never)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      if (action.policy === 'any-actor') return;
      // Every permission but the one it needs, everywhere: still refused.
      const others = actorWith(PERMISSIONS.filter((p) => p !== action.policy));
      for (const actor of [NOBODY, others]) {
        await expect(guarded.handle({ actor } as never)).rejects.toBeInstanceOf(
          ForbiddenError,
        );
      }
    },
  );
});
