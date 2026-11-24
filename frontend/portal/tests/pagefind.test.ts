// @vitest-environment jsdom
import {
  excerptNodes,
  passageScore,
  passagesOf,
  sameSite,
} from '../src/scripts/pagefind.ts';

/** The search module the search page and the typeahead share (#845). */
describe('excerptNodes', () => {
  it('keeps text and marks, and nothing else, as nodes', () => {
    const nodes = excerptNodes(
      'Park at the <mark>dock</mark> &amp; <img src=x onerror="alert(1)"><b>wait</b>',
    );
    const holder = document.createElement('p');
    holder.append(...nodes);
    expect(holder.innerHTML).toBe('Park at the <mark>dock</mark> &amp; wait');
    expect(holder.querySelector('img, b')).toBeNull();
  });

  it('turns markup inside a mark into its text', () => {
    const holder = document.createElement('p');
    holder.append(...excerptNodes('<mark><script>x()</script>dock</mark>'));
    expect(holder.innerHTML).toBe('<mark>x()dock</mark>');
  });
});

describe('sameSite', () => {
  it('keeps a path of this site and drops another origin', () => {
    expect(sameSite('/en/alpha/operating/x/#charging')).toBe(
      '/en/alpha/operating/x/#charging',
    );
    expect(sameSite('https://elsewhere.example/en/')).toBe('#');
    expect(sameSite('javascript:alert(1)')).toBe('#');
  });
});

describe('passagesOf and passageScore', () => {
  it('reads the sections, or the page itself when it has none', () => {
    const page = { url: '/p/', meta: { title: 'Manual' }, excerpt: 'e' };
    expect(passagesOf(page)).toEqual([
      { title: 'Manual', url: '/p/', excerpt: 'e' },
    ]);
    const sub = { title: 'S', url: '/p/#s', excerpt: 'x' };
    expect(passagesOf({ ...page, sub_results: [sub] })).toEqual([sub]);
  });

  it('scores by the weighted words, else by how many there are', () => {
    const base = { title: '', url: '', excerpt: '' };
    expect(
      passageScore({
        ...base,
        weighted_locations: [{ balanced_score: 2 }, { balanced_score: 3 }],
      }),
    ).toBe(5);
    expect(passageScore({ ...base, locations: [1, 2, 3] })).toBe(3);
    expect(
      passageScore({ ...base, weighted_locations: [], locations: [1, 2] }),
    ).toBe(2);
    expect(passageScore(base)).toBe(0);
  });
});
