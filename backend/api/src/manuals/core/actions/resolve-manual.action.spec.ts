import { READER } from '../../../../tests/fakes/actors.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  readable,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { ResolveManualAction } from './resolve-manual.action.js';

const action = new ResolveManualAction();
const snapshot = readable({
  manifests: [manifest('op', ['intro'])],
  modules: [module('intro', 'en', 'Welcome.')],
});

describe('ResolveManualAction', () => {
  it('resolves a listed variant in a configured language', async () => {
    const { manual } = await action.handle({
      actor: READER,
      snapshot,
      id: 'op',
      variant: 'model=large',
      lang: 'en',
    });
    expect(manual).toMatchObject({
      id: 'op',
      lang: 'en',
      variant: { model: 'large' },
    });
    expect(JSON.stringify(manual.entries)).toContain('Welcome.');
  });

  it('falls back to the source language and reports it', async () => {
    const { manual, issues } = await action.handle({
      actor: READER,
      snapshot,
      id: 'op',
      variant: 'model=small',
      lang: 'de',
    });
    expect(JSON.stringify(manual.entries)).toContain('Welcome.');
    expect(issues.length).toBeGreaterThan(0);
  });

  it.each([
    ['an unknown manual', 'nope', 'model=large', 'en'],
    ['an unlisted variant', 'op', 'model=huge', 'en'],
    ['an unconfigured language', 'op', 'model=large', 'fr'],
  ])('is not found for %s', async (_case, id, variant, lang) => {
    await expect(
      action.handle({ actor: READER, snapshot, id, variant, lang }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
