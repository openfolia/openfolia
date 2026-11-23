import {
  parseCondition,
  type Manifest,
  type Module,
} from '@openfolia/content-model';
import { actorWith, NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { manifest, module } from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { fakeModuleIndex } from '../../../../tests/fakes/fake-module-index-store.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { ListVariantUsesAction } from './list-variant-uses.action.js';

/** `m` with a variant block on `when`. */
const conditional = (
  m: Module,
  when: string,
  title = m.meta.title,
): Module => ({
  ...m,
  meta: { ...m.meta, title },
  blocks: [
    ...m.blocks,
    {
      type: 'variant',
      id: 'only',
      when: parseCondition(when),
      blocks: [
        {
          type: 'paragraph',
          id: 'only-p',
          content: [{ type: 'text', text: 'x' }],
        },
      ],
    },
  ],
});

const history = new FakeHistory({
  modules: [
    conditional(module('zeta'), 'model in (large)', 'Alpha'),
    conditional(module('zeta', 'de'), 'model in (large)', 'Alpha (de)'),
    conditional(module('beta', 'de'), 'model in (small)', 'Beta'),
    module('plain'),
    { ...module('gamma'), meta: { ...module('gamma').meta, title: 'Gamma' } },
    conditional(module('gamma', 'de'), 'colour in (red)', 'Gamma (de)'),
  ],
  manifests: [
    { ...manifest('guide', ['zeta']), variants: [{ model: 'small' }] },
    manifest('both', ['plain']),
  ] as Manifest[],
});
const action = new ListVariantUsesAction(fakeModuleIndex(history).readable);
const page = { number: 1, size: 50 };

const open = (actor = READER) =>
  history.openSnapshot.handle({ actor, ref: 'main' });

describe('ListVariantUsesAction', () => {
  it('lists the manuals, then the modules naming a value, by title', async () => {
    const snapshot = await open();
    expect(
      await action.handle({
        actor: READER,
        snapshot,
        attribute: 'model',
        value: 'large',
        page,
      }),
    ).toEqual({
      total: 2,
      items: [
        { kind: 'manual', id: 'both', title: 'Manual both' },
        {
          kind: 'module',
          id: 'zeta',
          title: 'Alpha',
          languages: ['de', 'en'],
        },
      ],
    });
    const small = await action.handle({
      actor: READER,
      snapshot,
      attribute: 'model',
      value: 'small',
      page,
    });
    expect(small.items.map((u) => `${u.kind}/${u.id}`)).toEqual([
      'manual/both',
      'manual/guide',
      'module/beta',
    ]);
  });

  it('lists where the attribute is named at all without a value, paged', async () => {
    const snapshot = await open();
    const all = await action.handle({
      actor: READER,
      snapshot,
      attribute: 'model',
      page: { number: 2, size: 2 },
    });
    expect(all.total).toBe(4);
    expect(all.items.map((u) => u.id)).toEqual(['zeta', 'beta']);
    expect(
      await action.handle({
        actor: READER,
        snapshot,
        attribute: 'software',
        page,
      }),
    ).toEqual({ total: 0, items: [] });
  });

  it('counts only what the reader may see', async () => {
    const english = actorWith(['content.read'], { languages: ['en'] });
    const snapshot = await open(english);
    const found = await action.handle({
      actor: english,
      snapshot,
      attribute: 'model',
      value: 'small',
      page,
    });
    expect(found.items.map((u) => u.id)).toEqual(['both', 'guide']);
  });

  it('titles a module by its source-language file even when only another language names the value', async () => {
    const snapshot = await open();
    const found = await action.handle({
      actor: READER,
      snapshot,
      attribute: 'colour',
      value: 'red',
      page,
    });
    expect(found.items).toEqual([
      { kind: 'module', id: 'gamma', title: 'Gamma', languages: ['de'] },
    ]);
  });

  it('needs content.read', async () => {
    const snapshot = await open();
    await expect(
      action.handle({ actor: NOBODY, snapshot, attribute: 'model', page }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
