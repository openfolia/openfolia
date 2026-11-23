import { labelOf } from '@openfolia/content-model';
import { ContentRepo } from '@openfolia/content-repo';
import { createSampleRepo } from '@openfolia/content-repo/testing';
import { rmSync } from 'node:fs';
import { renderManualHtml } from './render.js';

// Snapshots of every manual in the sample content repository, for each
// shipped variant and every configured language, at each of its refs.

const { dir } = createSampleRepo();
const repo = ContentRepo.open(dir);

afterAll(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the sample repository’s manuals', () => {
  it.each(['v1', 'main', 'draft'])('render at %s', async (ref) => {
    const snapshot = await repo.at(ref);
    if (!snapshot) throw new Error(`no ${ref}`);
    const config = await snapshot.config();
    const symbols = await snapshot.symbols();
    const languages = [config.languages.source, ...config.languages.targets];
    const out: Record<string, string> = {};
    for (const id of await snapshot.manifests()) {
      const manifest = await snapshot.manifest(id);
      for (const variant of manifest?.variants ?? []) {
        for (const lang of languages) {
          const resolution = await snapshot.resolve(id, variant, lang);
          if (!resolution) throw new Error(`no manual ${id}`);
          const { html } = renderManualHtml(resolution.manual, {
            assetUrl: (hash) => `/assets/${hash}`,
            symbolUrl: (s) => (symbols.has(s) ? `/symbols/${s}` : undefined),
            symbolLabel: (s) => labelOf(config, 'safetySymbols', s, lang),
            outputLabels: config.outputLabels,
          });
          const ids = [...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);
          expect(new Set(ids).size).toBe(ids.length);
          out[`${id} ${JSON.stringify(variant)} ${lang}`] = html;
        }
      }
    }
    expect(Object.keys(out).length).toBeGreaterThan(0);
    expect(out).toMatchSnapshot();
  });
});
