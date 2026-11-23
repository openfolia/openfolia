import { pageEtag, type PageInputs } from './page-etag.js';

const address = {
  product: 'north',
  slug: 'operating',
  variant: 'model=large',
  lang: 'en',
};
const inputs: PageInputs = {
  buildId: 'build-1',
  files: ['"css-1"'],
  commit: 'a'.repeat(40),
  manualId: 'operating',
  address,
  pinned: { ...address, revision: '1.0' },
  readingKey: 'reader',
  theme: 'auto',
  root: '../../../../',
};

describe('pageEtag (#552)', () => {
  it('is the same for the same inputs, a quoted hash', () => {
    expect(pageEtag(inputs)).toBe(pageEtag({ ...inputs }));
    expect(pageEtag(inputs)).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('changes with every input the page is made from', () => {
    const changed: Partial<PageInputs>[] = [
      { buildId: 'build-2' },
      { files: ['"css-2"'] },
      { commit: 'b'.repeat(40) },
      { manualId: 'service' },
      { address: { ...address, lang: 'de' } },
      { pinned: { ...address, revision: '1.1' } },
      { readingKey: 'another reader' },
      { theme: 'dark' },
      { root: '../../../../../' },
    ];
    const etags = new Set([
      pageEtag(inputs),
      ...changed.map((c) => pageEtag({ ...inputs, ...c })),
    ]);
    expect(etags.size).toBe(changed.length + 1);
  });
});
