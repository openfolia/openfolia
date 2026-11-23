import { ProjectConfig, type Module } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config,
  FakeSnapshot,
  manifest,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import {
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import type { ManualResolution } from '../../../content/core/content.repository.js';
import {
  HtmlRenderer,
  type HtmlFragment,
  type HtmlRenderOptions,
} from '../html-renderer.js';
import { PreviewManualAction } from './preview-manual.action.js';
import { PreviewModuleAction } from './preview-module.action.js';

/** The URLs the renderer gets for two configured symbols, one with artwork (`w001`), one without. */
const symbolsOf = (options: HtmlRenderOptions) =>
  ['w001', 'p001'].map((id) => options.symbolUrl?.(id) ?? '-').join(' ');

/** Writes what it was given, so the tests see what the actions passed on. */
class SpyRenderer extends HtmlRenderer {
  manual(resolution: ManualResolution, options: HtmlRenderOptions) {
    return {
      html: `manual ${resolution.manual.id} ${JSON.stringify(resolution.manual.variant)} ${options.subtitle ?? '-'} ${options.assetUrl('h')} ${symbolsOf(options)}`,
    };
  }
  module(
    resolution: ManualResolution,
    id: string,
    options: HtmlRenderOptions,
  ): HtmlFragment | undefined {
    const found = JSON.stringify(resolution.manual.entries).includes(
      `"module":"${id}"`,
    );
    return found
      ? {
          html: `module ${id} ${JSON.stringify(resolution.manual.variant)} ${options.assetUrl('h')} ${symbolsOf(options)}`,
        }
      : undefined;
  }
}

const assetUrl = (h: string) => `/a/${h}`;
const symbolUrl = (id: string) => `/s/${id}`;
const withBlocks = (id: string, when: string): Module => ({
  ...module(id),
  blocks: [
    {
      type: 'variant',
      id: 'v',
      when: { op: 'in', attr: 'model', values: [when] },
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: 'Only for ' + when }],
        },
      ],
    },
  ],
});
const content: FakeContent = {
  config: ProjectConfig.parse({
    ...config,
    safetySymbols: [
      { id: 'w001', label: 'General warning' },
      { id: 'p001', label: 'No entry' },
    ],
  }),
  modules: [module('a'), module('a', 'de'), module('b')],
  manifests: [manifest('op', ['a', 'b'])],
  symbols: { 'symbols/w001.svg': new TextEncoder().encode('<svg></svg>') },
};
const previewModule = (
  actor: Actor,
  id: string,
  lang = 'en',
  variant?: Record<string, string>,
  from = content,
) =>
  new PreviewModuleAction(new SpyRenderer()).handle({
    actor,
    snapshot: readable(from, actor),
    id,
    lang,
    ...(variant && { variant }),
    assetUrl,
    symbolUrl,
  });

describe('PreviewModuleAction', () => {
  it('renders the module resolved for the variant, with its title and language', async () => {
    const result = await previewModule(READER, 'a', 'de', { model: 'large' });
    expect(result).toEqual({
      // The symbol without artwork has no URL: the HTML leaves it out.
      html: 'module a {"model":"large"} /a/h /s/w001 -',
      title: 'Title of a',
      lang: 'de',
      dir: 'ltr',
      issueCount: 0,
    });
    expect((await previewModule(READER, 'a')).html).toContain('module a {}');
  });

  it('is not found for a module that is missing, in another language or outside the reader’s scope, all alike', async () => {
    const german = actorWith(['content.read'], { languages: ['de'] });
    const asserts = [
      previewModule(READER, 'nope'),
      previewModule(READER, 'b', 'de'),
      previewModule(german, 'a', 'en'),
    ];
    for (const result of asserts) {
      await expect(result).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(previewModule(german, 'a', 'en')).rejects.toThrow(
      'No module "a" in "en".',
    );
  });

  it('refuses a variant the configuration does not hold', async () => {
    const unknown: Record<string, string>[] = [
      { colour: 'red' },
      { model: 'huge' },
    ];
    for (const variant of unknown) {
      await expect(
        previewModule(READER, 'a', 'en', variant),
      ).rejects.toBeInstanceOf(UnprocessableError);
    }
  });

  it('applies the conditions inside the module for the variant', async () => {
    const real = new FakeSnapshot({ modules: [withBlocks('c', 'large')] });
    const actor = READER;
    const resolution = await readable(real, actor).resolveModule(
      'c',
      { model: 'small' },
      'en',
    );
    expect(JSON.stringify(resolution?.manual.entries)).not.toContain(
      'Only for large',
    );
    const large = await readable(real, actor).resolveModule(
      'c',
      { model: 'large' },
      'en',
    );
    expect(JSON.stringify(large?.manual.entries)).toContain('Only for large');
  });
});

describe('PreviewManualAction', () => {
  const previewManual = (actor: Actor, variant: string, lang = 'en') =>
    new PreviewManualAction(
      new ResolveManualAction(),
      new SpyRenderer(),
    ).handle({
      actor,
      snapshot: readable(content, actor),
      id: 'op',
      variant,
      lang,
      assetUrl,
      symbolUrl,
    });

  it('renders the resolved manual with the variant named by its labels', async () => {
    expect(await previewManual(READER, 'model=large')).toEqual({
      html: 'manual op {"model":"large"} Large /a/h /s/w001 -',
      title: 'Manual op',
      lang: 'en',
      dir: 'ltr',
      issueCount: 0,
    });
  });

  it('is not found for a variant, language or manual it does not hold', async () => {
    await expect(previewManual(READER, 'model=huge')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      previewManual(READER, 'model=large', 'es'),
    ).rejects.toBeInstanceOf(NotFoundError);
    const none = actorWith(['content.read'], { maxAudience: 'nothing' });
    await expect(previewManual(none, 'model=large')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
