import type { Actor } from '../../../access/core/actor.js';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  FakeSnapshot,
  manifest,
  module,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { RecordingRenderer } from '../../../../tests/fakes/recording-pdf-renderer.js';
import type { PdfRenderer } from '../pdf-renderer.js';
import { RenderManualPdfAction } from './render-manual-pdf.action.js';
import { ResolveManualAction } from './resolve-manual.action.js';

const shared = new FakeSnapshot({
  manifests: [manifest('op', ['intro', 'other'])],
  modules: [module('intro'), module('other', 'de')],
});
const render = (renderer: PdfRenderer, actor: Actor, snapshot = shared) =>
  new RenderManualPdfAction(new ResolveManualAction(), renderer).handle({
    actor,
    snapshot: readable(snapshot, actor),
    id: 'op',
    variant: 'model=small',
    lang: 'de',
  });

describe('RenderManualPdfAction', () => {
  it('renders the resolved manual under a key unique to commit and request', async () => {
    const renderer = new RecordingRenderer();
    const action = new RenderManualPdfAction(
      new ResolveManualAction(),
      renderer,
    );
    // A draft reader: the missing module is reported to it.
    const actor = actorWith(['content.read', 'content.read.draft']);
    const snapshot = readable(
      {
        manifests: [manifest('op', ['intro', 'missing'])],
        modules: [module('intro')],
      },
      actor,
    );
    const result = await action.handle({
      actor,
      snapshot,
      id: 'op',
      variant: 'model=small',
      lang: 'en',
    });
    expect(result).toEqual({
      pdf: new Uint8Array([1, 2, 3]),
      issueCount: 1,
      filename: 'op-model=small-en.pdf',
    });
    expect(renderer.keys).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${snapshot.commit}\\|op\\|model=small\\|en\\|${snapshot.readingKey}\\|ua-1\\|[0-9a-f]{64}$`,
        ),
      ),
    ]);
  });

  it('never shares a key between readers who may see differently', async () => {
    const renderer = new RecordingRenderer();
    // Same content for both: still another scope, so another key.
    await render(renderer, READER);
    await render(
      renderer,
      actorWith(['content.read'], { maxAudience: 'public' }),
    );
    // Different content: the German reader sees only "other".
    await render(renderer, actorWith(['content.read'], { languages: ['de'] }));
    expect(new Set(renderer.keys).size).toBe(3);
    // The same reader again: the same key, so the cache is used.
    await render(renderer, READER);
    expect(renderer.keys[3]).toBe(renderer.keys[0]);
  });
});
