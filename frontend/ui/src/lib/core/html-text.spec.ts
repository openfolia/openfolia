import { describe, expect, it } from 'vitest';

import { htmlParams, htmlText } from './html-text';

describe('htmlText', () => {
  it('escapes the characters that make markup', () => {
    expect(htmlText(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('htmlParams', () => {
  it('escapes every string, nested in plain objects and arrays too, and keeps other values', () => {
    const when = new Date(0);
    expect(
      htmlParams({
        name: '<b>',
        count: 2,
        ok: true,
        none: null,
        when,
        who: { name: '<i>', tags: ['<u>', 3] },
      }),
    ).toEqual({
      name: '&lt;b&gt;',
      count: 2,
      ok: true,
      none: null,
      when,
      who: { name: '&lt;i&gt;', tags: ['&lt;u&gt;', 3] },
    });
  });

  it('keeps a Date a Date', () => {
    const when = new Date(0);
    expect(htmlParams({ when })['when']).toBe(when);
  });
});
