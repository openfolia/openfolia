import { ProjectConfig } from '@openfolia/content-model';
import { NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { config, readable } from '../../../../tests/fakes/fake-content.js';
import {
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { GetSymbolAction } from './get-symbol.action.js';

const SVG = new TextEncoder().encode(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

const withSymbols = ProjectConfig.parse({
  ...config,
  safetySymbols: [
    { id: 'w001', label: 'General warning' },
    { id: 'm001', label: 'Read the manual' },
    { id: 'p001', label: 'No entry' },
    { id: 'fake-svg', label: 'Not an SVG' },
    { id: 'fake-png', label: 'Not a PNG' },
  ],
});

const snapshot = readable({
  config: withSymbols,
  symbols: {
    'symbols/w001.svg': SVG,
    'symbols/m001.png': PNG,
    // An SVG where a PNG should be: the bytes decide, never the name.
    'symbols/fake-png.png': SVG,
    'symbols/fake-svg.svg': PNG,
    // Not configured: not served.
    'symbols/x001.svg': SVG,
  },
});

const action = new GetSymbolAction();

describe('GetSymbolAction', () => {
  it('serves a configured symbol’s artwork with the type its bytes have', async () => {
    expect(
      await action.handle({ actor: READER, snapshot, id: 'w001' }),
    ).toEqual({ bytes: SVG, type: 'image/svg+xml' });
    expect(
      await action.handle({ actor: READER, snapshot, id: 'm001' }),
    ).toEqual({ bytes: PNG, type: 'image/png' });
  });

  it('is not found for a symbol without artwork, or one that is not configured', async () => {
    for (const id of ['p001', 'x001', 'nothing']) {
      await expect(
        action.handle({ actor: READER, snapshot, id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('refuses a file whose bytes are not what its extension says', async () => {
    for (const id of ['fake-svg', 'fake-png']) {
      await expect(
        action.handle({ actor: READER, snapshot, id }),
      ).rejects.toBeInstanceOf(InvalidContentError);
    }
  });

  it('needs content.read', async () => {
    await expect(
      action.handle({ actor: NOBODY, snapshot, id: 'w001' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
