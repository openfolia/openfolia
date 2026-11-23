import {
  parseCondition,
  ProjectConfig,
  type Manifest,
  type VariantValues,
} from '@openfolia/content-model';
import { actorWith, NOBODY, READER } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  manifest,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import {
  ForbiddenError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { ListVariantAttributesAction } from './list-variant-attributes.action.js';
import { MatchVariantsAction } from './match-variants.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [
    ...baseConfig.variantAttributes,
    { id: 'software', label: 'Software', kind: 'version' },
  ],
});

const manual = (
  id: string,
  variants: VariantValues[],
  audience = 'public',
): Manifest => ({ ...manifest(id, ['m']), variants, audience });

const content = {
  config,
  manifests: [
    manual('b', [
      { model: 'small', software: '2.10' },
      { model: 'large', software: '2.3' },
    ]),
    manual('a', [{ model: 'large', software: '2.9' }, { model: 'small' }]),
    manual('secret', [{ model: 'large', software: '3' }], 'internal'),
  ],
  brokenManifests: ['broken'],
};

const page = { number: 1, size: 50 };

describe('ListVariantAttributesAction', () => {
  const action = new ListVariantAttributesAction();

  it('pages the configured attributes in their order, with their values', async () => {
    const first = await action.handle({
      actor: READER,
      snapshot: readable({ config }),
      page: { number: 1, size: 1 },
    });
    expect(first).toEqual({
      total: 2,
      items: [
        {
          id: 'model',
          label: 'Model',
          kind: 'enum',
          values: [
            { id: 'small', label: 'Small' },
            { id: 'large', label: 'Large' },
          ],
        },
      ],
    });
    const second = await action.handle({
      actor: READER,
      snapshot: readable({ config }),
      page: { number: 2, size: 1 },
    });
    expect(second.items).toEqual([
      { id: 'software', label: 'Software', kind: 'version' },
    ]);
  });

  it('refuses an actor who may not read', async () => {
    await expect(
      action.handle({ actor: NOBODY, snapshot: readable({ config }), page }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('MatchVariantsAction', () => {
  const action = new MatchVariantsAction();
  const match = (when: string, actor = READER) =>
    action.handle({
      actor,
      snapshot: readable(content, actor),
      when: parseCondition(when),
      page,
    });
  const names = (result: Awaited<ReturnType<typeof match>>) =>
    result.items.map((b) => `${b.manualId} ${b.variant.slug}`);

  it('lists the builds a condition holds for, by manual ID, then listed order', async () => {
    const result = await match('model in (large)');
    expect(names(result)).toEqual([
      'a model=large,software=2.9',
      'b model=large,software=2.3',
      'secret model=large,software=3',
    ]);
    expect(result.total).toBe(3);
    expect(result.items[0]).toEqual({
      manualId: 'a',
      manualTitle: 'Manual a',
      variant: {
        slug: 'model=large,software=2.9',
        label: 'Large · Software 2.9',
        values: { model: 'large', software: '2.9' },
      },
    });
  });

  it('compares versions numerically, and an unset attribute never holds', async () => {
    expect(names(await match('software >= 2.9'))).toEqual([
      'a model=large,software=2.9',
      'b model=small,software=2.10',
      'secret model=large,software=3',
    ]);
    expect(names(await match('software in (2.3.0)'))).toEqual([
      'b model=large,software=2.3',
    ]);
    // `a`'s second build sets no software: neither the test nor its negation holds.
    expect(names(await match('!(software >= 2.9)'))).toEqual([
      'b model=large,software=2.3',
    ]);
  });

  it('combines with all, any and not', async () => {
    expect(
      names(
        await match(
          'model in (small) && !(software < 2.10) || software > 2.9.5',
        ),
      ),
    ).toEqual(['b model=small,software=2.10', 'secret model=large,software=3']);
  });

  it('never names nor counts a manual outside the reader’s scope', async () => {
    const result = await match(
      'model in (large)',
      actorWith(['content.read'], { maxAudience: 'public' }),
    );
    expect(names(result)).toEqual([
      'a model=large,software=2.9',
      'b model=large,software=2.3',
    ]);
    expect(result.total).toBe(2);
  });

  it('pages the builds', async () => {
    const result = await action.handle({
      actor: READER,
      snapshot: readable(content),
      when: parseCondition('model in (small, large)'),
      page: { number: 2, size: 2 },
    });
    expect(result.total).toBe(5);
    expect(result.items.map((b) => b.manualId)).toEqual(['b', 'b']);
  });

  it('refuses a condition the configuration does not hold, one problem each', async () => {
    const refused = await match(
      'colour in (red) || model in (huge) || model > 2 || software >= abc',
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnprocessableProblems);
    const problems = refused as UnprocessableProblems;
    expect(problems.code).toBe('unknown-variant');
    expect(problems.problems).toEqual([
      {
        detail: 'variant attribute "colour" is not configured',
        meta: { issue: 'unknown-variant-attribute' },
      },
      {
        detail: '"huge" is not a value of variant attribute "model"',
        meta: { issue: 'unknown-variant-value' },
      },
      {
        detail: `"model" is not a version, so it can't be compared with >`,
        meta: { issue: 'version-compare-on-enum' },
      },
      {
        detail: '"abc" is not a version (variant attribute "software")',
        meta: { issue: 'invalid-version-value' },
      },
    ]);
  });

  it('refuses an actor who may not read', async () => {
    await expect(match('model in (large)', NOBODY)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
