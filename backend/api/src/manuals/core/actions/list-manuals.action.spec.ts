import { READER } from '../../../../tests/fakes/actors.js';
import { readable, manifest } from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { ListManualsAction } from './list-manuals.action.js';

const history = new FakeHistory({});
const action = new ListManualsAction(
  new ReadableRefs(history),
  history.openSnapshot,
);

describe('ListManualsAction', () => {
  it('pages manuals and lists unreadable ones with their error', async () => {
    const snapshot = readable({
      manifests: [manifest('a', ['x']), manifest('c', ['x'])],
      brokenManifests: ['b'],
    });
    const first = await action.handle({
      actor: READER,
      snapshot,
      page: { number: 1, size: 2 },
    });
    expect(first.total).toBe(3);
    expect(first.items[0]).toMatchObject({
      id: 'a',
      variants: [
        { slug: 'model=small', label: 'Small', values: { model: 'small' } },
        { slug: 'model=large', label: 'Large', values: { model: 'large' } },
      ],
    });
    expect(first.items[1]).toEqual({
      id: 'b',
      error: 'manuals/b.yaml: not a module',
    });
    const second = await action.handle({
      actor: READER,
      snapshot,
      page: { number: 2, size: 2 },
    });
    expect(second.items.map((i) => i.id)).toEqual(['c']);
  });
});
