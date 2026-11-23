import { describe, expect, it } from 'vitest';
import { fixtureFiles } from './testing/fixture.js';
import { validateDita } from './testing/grammars.js';

describe('the fixtures', () => {
  it('are valid DITA 1.3 by the OASIS grammars (fetched once; xmllint fetches nothing)', async () => {
    const documents = new Map<string, string>();
    for (const [path, bytes] of fixtureFiles()) {
      if (!/\.(dita|ditamap|ditaval)$/.test(path)) continue;
      documents.set(path, new TextDecoder().decode(bytes));
    }
    const { errors, checked } = await validateDita(documents);
    expect(errors).toEqual([]);
    expect(checked.length).toBeGreaterThanOrEqual(17);
  }, 120_000);
});
