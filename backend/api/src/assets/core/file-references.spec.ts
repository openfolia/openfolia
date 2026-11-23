import {
  manifestFileReferences,
  subjectFileReferences,
} from './file-references.js';

describe('the files a manifest names (#394)', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const manifest = {
    coverImage: {
      default: { asset: `sha256:${b}`, alt: 'Cover' },
      variants: [
        { variant: { model: 'l' }, asset: `sha256:${a}`, alt: 'Large' },
        { variant: { model: 's' }, asset: `sha256:${b}`, alt: 'Small' },
      ],
    },
  };

  it('are its cover images, each once, sorted', () => {
    expect(manifestFileReferences(manifest)).toEqual([a, b]);
    expect(subjectFileReferences('manual', manifest)).toEqual([a, b]);
  });

  it('are none without a cover image', () => {
    expect(manifestFileReferences({})).toEqual([]);
    expect(subjectFileReferences('manual', { coverImage: undefined })).toEqual(
      [],
    );
  });
});
