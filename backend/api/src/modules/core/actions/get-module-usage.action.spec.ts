import { actorWith, NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { manifest, module } from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import {
  fakeModuleIndex,
  referring,
} from '../../../../tests/fakes/fake-module-index-store.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { GetModuleUsageAction } from './get-module-usage.action.js';

const history = new FakeHistory({
  modules: [module('a'), referring(module('b', 'de'), 'a')],
  manifests: [manifest('guide', ['a'])],
});
const action = new GetModuleUsageAction(fakeModuleIndex(history).readable);

describe('GetModuleUsageAction', () => {
  it('says where a module is used, as the reader may see it', async () => {
    const snapshot = await history.openSnapshot.handle({
      actor: READER,
      ref: 'main',
    });
    expect(await action.handle({ actor: READER, snapshot, id: 'a' })).toEqual({
      manuals: 1,
      modules: 1,
      uses: [
        {
          kind: 'manual',
          id: 'guide',
          title: 'Manual guide',
          direct: true,
          deprecated: false,
        },
        {
          kind: 'module',
          id: 'b',
          title: 'Title of b',
          direct: true,
          deprecated: false,
        },
      ],
    });
    const english = actorWith(['content.read'], { languages: ['en'] });
    const scoped = await history.openSnapshot.handle({
      actor: english,
      ref: 'main',
    });
    expect(
      await action.handle({ actor: english, snapshot: scoped, id: 'a' }),
    ).toMatchObject({ manuals: 1, modules: 0 });
  });

  it('needs content.read', async () => {
    const snapshot = await history.openSnapshot.handle({
      actor: READER,
      ref: 'main',
    });
    await expect(
      action.handle({ actor: NOBODY, snapshot, id: 'a' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
