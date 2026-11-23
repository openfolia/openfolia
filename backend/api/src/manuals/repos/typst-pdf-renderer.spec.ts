import {
  compilePdfReportInWorker,
  type WorkerOptions,
} from '@openfolia/render-typst';
import { config } from '../../../tests/fakes/fake-content.js';
import type {
  ManualResolution,
  RenderSource,
} from '../../content/core/content.repository.js';
import { TypstPdfRenderer } from './typst-pdf-renderer.js';

// The pool itself is `@openfolia/render-typst`'s (its specs): here only what the renderer asks of it.
vi.mock('@openfolia/render-typst', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openfolia/render-typst')>()),
  renderTypst: vi.fn(() => ({
    source: '= A manual',
    assets: [],
    symbols: [],
    fonts: [],
    inputs: {},
  })),
  compilePdfReportInWorker: vi.fn(),
}));

const compile = vi.mocked(compilePdfReportInWorker);

const source = {
  symbols: async () => new Map(),
  template: async () => undefined,
  committedAt: async () => 0,
  asset: async () => undefined,
  file: async () => undefined,
} as unknown as RenderSource;
const resolution = {
  manual: { variant: {}, entries: [] },
  config,
} as unknown as ManualResolution;

describe('TypstPdfRenderer and the pool’s priorities (#497)', () => {
  const settings = { get: () => undefined } as unknown as ConstructorParameters<
    typeof TypstPdfRenderer
  >[0];
  let finish: (pdf: Uint8Array) => void;
  const calls: WorkerOptions[] = [];

  beforeEach(() => {
    calls.length = 0;
    compile.mockReset();
    compile.mockImplementation((_input, options) => {
      calls.push(options ?? {});
      return new Promise((resolve) => {
        finish = (pdf) => resolve({ pdf, warnings: [] } as never);
      });
    });
  });

  it('renders a release’s file in the background, raised once a reader asks for the same PDF', async () => {
    const renderer = new TypstPdfRenderer(settings);
    const bulk = renderer.render(source, resolution, 'k', { background: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [options] = calls;
    expect(options).toMatchObject({ priority: 'background' });
    expect(options?.waitMs).toBeGreaterThan(0);
    expect(options?.raise?.aborted).toBe(false);
    // A reader joins: the same render, now ahead of the other background work.
    const reader = renderer.render(source, resolution, 'k');
    expect(options?.raise?.aborted).toBe(true);
    finish(new Uint8Array([1, 2]));
    expect(await bulk).toEqual(new Uint8Array([1, 2]));
    expect(await reader).toEqual(new Uint8Array([1, 2]));
    // One render for both, and the reader's copy kept for the next reader.
    expect(compile).toHaveBeenCalledTimes(1);
    expect(await renderer.render(source, resolution, 'k')).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('never raises for another background render, nor for a reader’s own render', async () => {
    const renderer = new TypstPdfRenderer(settings);
    const bulk = renderer.render(source, resolution, 'k', { background: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const again = renderer.render(source, resolution, 'k', {
      background: true,
    });
    expect(calls[0]?.raise?.aborted).toBe(false);
    finish(new Uint8Array([3]));
    await Promise.all([bulk, again]);
    // A reader's render is interactive from the start: nothing to raise.
    const reader = renderer.render(source, resolution, 'other');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ priority: 'interactive' });
    expect(calls[1]?.raise).toBeUndefined();
    finish(new Uint8Array([4]));
    await reader;
  });
});
