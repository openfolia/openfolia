import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  manifest,
  module,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { RecordingRenderer } from '../../../../tests/fakes/recording-pdf-renderer.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { ManualLayoutWarningsAction } from './manual-layout-warnings.action.js';
import { RenderManualPageAction } from './render-manual-page.action.js';
import { ResolveManualAction } from './resolve-manual.action.js';

const DESIGN = (name: string) =>
  [
    'schemaVersion: 1',
    `name: ${name}`,
    'preset: minimal',
    'colours:',
    '  primary: "#1f4e79"',
    '  accent: "#b45309"',
    '  text: "#1f2328"',
    '',
  ].join('\n');

const content = {
  manifests: [manifest('op', ['intro'])],
  modules: [module('intro')],
  pageDesigns: { plain: DESIGN('Plain'), bold: DESIGN('Bold') },
};
const input = { id: 'op', variant: 'model=small', lang: 'en' };
const page = { number: 1, size: 50 };

const truncated = {
  code: 'running-head-truncated' as const,
  at: 'header.default.left',
  page: 2,
  pages: 3,
  text: 'A long head',
};

describe('ManualLayoutWarningsAction', () => {
  it('lists what the layout of the PDF the pages show could not fit (the same key)', async () => {
    const renderer = new RecordingRenderer();
    renderer.warnings = (r) => (r.design?.name === 'Bold' ? [truncated] : []);
    const snapshot = readable(content, READER);
    const action = new ManualLayoutWarningsAction(
      new ResolveManualAction(),
      renderer,
    );
    await new RenderManualPageAction(
      new ResolveManualAction(),
      renderer,
    ).handle({
      actor: READER,
      snapshot,
      ...input,
      design: 'bold',
      page: 1,
      width: 320,
    });
    const listed = await action.handle({
      actor: READER,
      snapshot,
      ...input,
      design: 'bold',
      page,
    });
    expect(listed).toEqual({ items: [truncated], total: 1 });
    expect(renderer.warned).toEqual([renderer.pages[0]?.key]);
    // Another design, another PDF.
    const plain = await action.handle({
      actor: READER,
      snapshot,
      ...input,
      design: 'plain',
      page,
    });
    expect(plain).toEqual({ items: [], total: 0 });
    expect(renderer.warned[1]).not.toBe(renderer.warned[0]);
  });

  it('leaves out a callout legend cut off and a safety message split: the checks report them (#548, #668)', async () => {
    const renderer = new RecordingRenderer();
    renderer.warnings = () => [
      {
        code: 'callout-label-overflow',
        at: 'callouts.intro.photo.lid',
        page: 3,
        pages: 1,
      },
      {
        code: 'safety-message-split',
        at: 'safety.intro.notice',
        page: 4,
        pages: 1,
        text: 'Crushing',
      },
      truncated,
    ];
    const listed = await new ManualLayoutWarningsAction(
      new ResolveManualAction(),
      renderer,
    ).handle({
      actor: READER,
      snapshot: readable(content, READER),
      ...input,
      page,
    });
    expect(listed).toEqual({ items: [truncated], total: 1 });
  });

  it('pages the warnings', async () => {
    const renderer = new RecordingRenderer();
    renderer.warnings = () => [
      truncated,
      { code: 'page-design-overflow', at: 'regions.footer', page: 1, pages: 1 },
    ];
    const listed = await new ManualLayoutWarningsAction(
      new ResolveManualAction(),
      renderer,
    ).handle({
      actor: READER,
      snapshot: readable(content, READER),
      ...input,
      page: { number: 2, size: 1 },
    });
    expect(listed.total).toBe(2);
    expect(listed.items.map((w) => w.code)).toEqual(['page-design-overflow']);
  });

  it('needs content.read', async () => {
    const actor = actorWith([]);
    await expect(
      new ManualLayoutWarningsAction(
        new ResolveManualAction(),
        new RecordingRenderer(),
      ).handle({ actor, snapshot: readable(content, actor), ...input, page }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
