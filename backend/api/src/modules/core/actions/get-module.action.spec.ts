import type { Actor } from '../../../access/core/actor.js';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  FakeSnapshot,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import {
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { GetModuleAction } from './get-module.action.js';

const action = new GetModuleAction();
const content: FakeContent = { modules: [module('a'), module('a', 'de')] };
const read = (actor: Actor, id: string, lang: string, from = content) =>
  action.handle({ actor, snapshot: readable(from, actor), id, lang });

describe('GetModuleAction', () => {
  it('returns the module with its validation issues', async () => {
    const result = await read(READER, 'a', 'en');
    expect(result.module.id).toBe('a');
    expect(result.issues).toEqual([]);
  });

  it('is not found in a missing language or under another ID', async () => {
    await expect(
      read(READER, 'a', 'de', { modules: [module('a')] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(read(READER, 'nope', 'en')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('is not found, as if missing, outside the reader’s scope', async () => {
    const germanReader = actorWith(['content.read'], { languages: ['de'] });
    expect((await read(germanReader, 'a', 'de')).module.meta.lang).toBe('de');
    const outside = read(germanReader, 'a', 'en');
    await expect(outside).rejects.toBeInstanceOf(NotFoundError);
    await expect(outside).rejects.toThrow('No module "a" in "en".');
  });

  it('reports a broken file only to a reader of everything in its language', async () => {
    const broken = { brokenModules: [{ id: 'b', lang: 'en' }] };
    for (const actor of [
      READER,
      actorWith(['content.read'], { languages: ['en'] }),
    ]) {
      await expect(read(actor, 'b', 'en', broken)).rejects.toBeInstanceOf(
        InvalidContentError,
      );
    }
    for (const actor of [
      actorWith(['content.read'], { languages: ['de'] }),
      actorWith(['content.read'], { maxAudience: 'public' }),
      actorWith(['content.read'], { moduleTypes: ['concept'] }),
    ]) {
      await expect(read(actor, 'b', 'en', broken)).rejects.toThrow(
        'No module "b" in "en".',
      );
    }
  });

  it('fails on a broken configuration whether or not the module exists', async () => {
    class BrokenConfig extends FakeSnapshot {
      override config() {
        return Promise.reject(
          new InvalidContentError('openfolia.yaml', 'broken'),
        );
      }
    }
    const scoped = actorWith(['content.read'], { languages: ['de'] });
    const snapshot = readable(
      new BrokenConfig({ modules: [module('a')] }),
      scoped,
    );
    for (const id of ['a', 'nope']) {
      await expect(
        action.handle({ actor: scoped, snapshot, id, lang: 'en' }),
      ).rejects.toBeInstanceOf(InvalidContentError);
    }
  });
});
