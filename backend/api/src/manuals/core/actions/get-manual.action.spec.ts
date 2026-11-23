import { READER } from '../../../../tests/fakes/actors.js';
import {
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { ProjectConfig } from '@openfolia/content-model';
import {
  config,
  readable,
  manifest,
} from '../../../../tests/fakes/fake-content.js';
import { GetManualAction } from './get-manual.action.js';

const action = new GetManualAction();

describe('GetManualAction', () => {
  const snapshot = readable({
    manifests: [manifest('op', ['x'])],
    brokenManifests: ['bad'],
  });

  it('returns the manifest, its variants and issues', async () => {
    const result = await action.handle({ actor: READER, snapshot, id: 'op' });
    expect(result.manifest.title).toBe('Manual op');
    expect(result.variants.map((v) => v.slug)).toEqual([
      'model=small',
      'model=large',
    ]);
    expect(result.issues).toEqual(expect.any(Array));
  });

  it('is not found for an unknown ID and reports a broken manifest', async () => {
    await expect(
      action.handle({ actor: READER, snapshot, id: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      action.handle({ actor: READER, snapshot, id: 'bad' }),
    ).rejects.toBeInstanceOf(InvalidContentError);
  });

  it('names the page design the manual is printed with (#589)', async () => {
    const DESIGN = [
      'schemaVersion: 1',
      'name: House style',
      'preset: minimal',
      'colours:',
      '  primary: "#333333"',
      '  accent: "#555555"',
      '  text: "#111111"',
      '',
    ].join('\n');
    const read = (design: string | undefined, own?: string) =>
      action.handle({
        actor: READER,
        snapshot: readable({
          config: ProjectConfig.parse({
            ...config,
            ...(design && { pdf: { design } }),
          }),
          manifests: [
            { ...manifest('op', ['x']), ...(own && { design: own }) },
          ],
          pageDesigns: { house: DESIGN },
        }),
        id: 'op',
      });
    expect((await read(undefined)).design).toEqual({
      id: 'builtin',
      name: null,
      source: 'builtin',
      missing: false,
    });
    expect((await read('house')).design).toEqual({
      id: 'house',
      name: 'House style',
      source: 'project',
      missing: false,
    });
    expect((await read('house', 'gone')).design).toEqual({
      id: 'gone',
      name: null,
      source: 'manual',
      missing: true,
    });
  });
});
