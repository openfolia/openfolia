import type { Manifest, Module } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config,
  manifest,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import {
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import { LABEL_LENGTH } from '../hidden-content.js';
import {
  ListHiddenManualContentAction,
  ListHiddenModuleContentAction,
} from './list-hidden-content.action.js';

const onlyFor = (value: string) => ({
  op: 'in' as const,
  attr: 'model',
  values: [value],
});

/** A module with a variant block for `large` (a section, then a long paragraph) and one for `small`. */
const conditional: Module = {
  ...module('c'),
  blocks: [
    {
      type: 'variant',
      id: 'big',
      when: onlyFor('large'),
      blocks: [
        {
          type: 'section',
          id: 's',
          title: [{ type: 'text', text: '  Big   battery ' }],
          blocks: [],
        },
      ],
    },
    {
      type: 'variant',
      id: 'tiny',
      when: onlyFor('small'),
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: 'x'.repeat(200) }],
        },
      ],
    },
  ],
};
const internal: Module = {
  ...module('secret'),
  meta: { ...module('secret').meta, type: 'procedure' },
};
const withEntries: Manifest = {
  ...manifest('op', ['c']),
  entries: [
    { module: 'c' },
    { module: 'a', when: onlyFor('large') },
    { module: 'secret', when: onlyFor('large') },
    { title: 'Small only', when: onlyFor('small'), entries: [{ module: 'a' }] },
  ],
};
const content: FakeContent = {
  config: {
    ...config,
    moduleTypes: [
      { id: 'concept', label: 'Concept', restricted: false, snippet: false },
      {
        id: 'procedure',
        label: 'Procedure',
        restricted: false,
        snippet: false,
      },
    ],
  },
  modules: [conditional, module('a'), internal],
  manifests: [withEntries],
};
const page = { number: 1, size: 50 };

const forModule = (
  actor: Actor,
  variant?: Record<string, string>,
  id = 'c',
  lang = 'en',
) =>
  new ListHiddenModuleContentAction().handle({
    actor,
    snapshot: readable(content, actor),
    id,
    lang,
    ...(variant && { variant }),
    page,
  });

const forManual = (actor: Actor, variant: string, lang = 'en') =>
  new ListHiddenManualContentAction(new ResolveManualAction()).handle({
    actor,
    snapshot: readable(content, actor),
    id: 'op',
    variant,
    lang,
    page,
  });

describe('ListHiddenModuleContentAction', () => {
  it('lists the variant blocks the variant leaves out, labelled by their first text', async () => {
    const small = await forModule(READER, { model: 'small' });
    expect(small.total).toBe(1);
    expect(small.items).toEqual([
      {
        kind: 'block',
        module: 'c',
        block: 'big',
        when: onlyFor('large'),
        label: 'Big battery',
      },
    ]);
    const large = await forModule(READER, { model: 'large' });
    const label = large.items[0]?.label ?? '';
    expect([...label]).toHaveLength(LABEL_LENGTH);
    expect(label.endsWith('…')).toBe(true);
    expect(typeof small.commit).toBe('string');
  });

  it('lists every variant block when no variant is set', async () => {
    const none = await forModule(READER);
    expect(none.items.map((i) => i.block)).toEqual(['big', 'tiny']);
  });

  it('pages', async () => {
    const second = await new ListHiddenModuleContentAction().handle({
      actor: READER,
      snapshot: readable(content, READER),
      id: 'c',
      lang: 'en',
      page: { number: 2, size: 1 },
    });
    expect(second).toMatchObject({ total: 2, items: [{ block: 'tiny' }] });
  });

  it('is not found, and refuses an unknown variant, as the preview does', async () => {
    await expect(forModule(READER, undefined, 'nope')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const german = actorWith(['content.read'], { languages: ['de'] });
    await expect(forModule(german)).rejects.toBeInstanceOf(NotFoundError);
    await expect(forModule(READER, { model: 'huge' })).rejects.toBeInstanceOf(
      UnprocessableError,
    );
    await expect(forModule(actorWith([]))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('ListHiddenManualContentAction', () => {
  it('lists hidden blocks, module entries and groups, in document order', async () => {
    const small = await forManual(READER, 'model=small');
    expect(small.items.map((i) => [i.kind, i.module ?? null, i.label])).toEqual(
      [
        ['block', 'c', 'Big battery'],
        ['module', 'a', 'Title of a'],
        ['module', 'secret', 'Title of secret'],
      ],
    );
    const large = await forManual(READER, 'model=large');
    expect(large.items.map((i) => [i.kind, i.label])).toEqual([
      ['block', 'x'.repeat(LABEL_LENGTH - 1) + '…'],
      ['group', 'Small only'],
    ]);
  });

  it('lists no module the reader may not read', async () => {
    const outside = actorWith(['content.read'], { moduleTypes: ['concept'] });
    const small = await forManual(outside, 'model=small');
    expect(small.items.map((i) => i.module)).toEqual(['c', 'a']);
  });

  it('is not found for a variant or language the manual does not have', async () => {
    await expect(forManual(READER, 'model=huge')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(forManual(READER, 'model=small', 'es')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
