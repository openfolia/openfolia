import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  manifest,
  module,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { RecordingRenderer } from '../../../../tests/fakes/recording-pdf-renderer.js';
import { RenderManualPageAction } from './render-manual-page.action.js';
import { RenderManualPdfAction } from './render-manual-pdf.action.js';
import { ResolveManualAction } from './resolve-manual.action.js';

const content = {
  manifests: [manifest('op', ['intro', 'other'])],
  modules: [module('intro'), module('other', 'de')],
};
const input = { id: 'op', variant: 'model=small', lang: 'de' };

describe('RenderManualPageAction', () => {
  it('renders the page of the same PDF (same key) at the asked width', async () => {
    const renderer = new RecordingRenderer();
    const snapshot = readable(content, READER);
    await new RenderManualPdfAction(new ResolveManualAction(), renderer).handle(
      { actor: READER, snapshot, ...input },
    );
    const result = await new RenderManualPageAction(
      new ResolveManualAction(),
      renderer,
    ).handle({ actor: READER, snapshot, ...input, page: 2, width: 320 });
    expect(result).toEqual({ png: new Uint8Array([4, 5, 6]) });
    expect(renderer.pages).toEqual([
      { key: renderer.keys[0], number: 2, width: 320 },
    ]);
  });

  it('never shares a key between readers who may see differently', async () => {
    const renderer = new RecordingRenderer();
    const action = new RenderManualPageAction(
      new ResolveManualAction(),
      renderer,
    );
    for (const actor of [
      READER,
      actorWith(['content.read'], { languages: ['de'] }),
    ]) {
      await action.handle({
        actor,
        snapshot: readable(content, actor),
        ...input,
        page: 1,
        width: 480,
      });
    }
    expect(new Set(renderer.pages.map((p) => p.key)).size).toBe(2);
  });

  it('needs content.read', async () => {
    const actor = actorWith([]);
    await expect(
      new RenderManualPageAction(
        new ResolveManualAction(),
        new RecordingRenderer(),
      ).handle({
        actor,
        snapshot: readable(content, actor),
        ...input,
        page: 1,
        width: 480,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
