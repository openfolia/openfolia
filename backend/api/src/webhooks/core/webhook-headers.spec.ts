import { UnprocessableProblems } from '../../base/core/errors.js';
import {
  checkHeaders,
  type HeaderContext,
  headerChanges,
  MAX_HEADERS,
  publicHeaders,
  refusedHeaderName,
  type StoredHeader,
} from './webhook-headers.js';

const context = (overrides: Partial<HeaderContext> = {}): HeaderContext => ({
  existing: [],
  seal: (value, name) => `sealed(${name.toLowerCase()}):${value}`,
  lengthOf: (h) => h.sealed.length,
  urlChanges: false,
  ...overrides,
});

const problems = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableProblems);
    const e = error as UnprocessableProblems;
    expect(e.code).toBe('invalid-headers');
    return e.problems.map((p) => [p.code, p.pointer]);
  }
  throw new Error('no problem');
};

describe('custom webhook headers (#457)', () => {
  it('seals a secret value, keeps a plain one, trims, and shows a secret one never with its value', () => {
    const stored = checkHeaders(
      [
        { name: 'Authorization', value: '  Bearer abc  ', secret: true },
        { name: 'X-Api-Version', value: '2' },
      ],
      context(),
    );
    expect(stored).toEqual([
      { name: 'Authorization', sealed: 'sealed(authorization):Bearer abc' },
      { name: 'X-Api-Version', value: '2' },
    ]);
    expect(publicHeaders(stored)).toEqual([
      { name: 'Authorization', secret: true, value: null },
      { name: 'X-Api-Version', secret: false, value: '2' },
    ]);
  });

  it('refuses what the server sets or would break delivery, in any case', () => {
    for (const name of [
      'Host',
      'content-length',
      'Content-Type',
      'Transfer-Encoding',
      'CONNECTION',
      'Keep-Alive',
      'TE',
      'Trailer',
      'Upgrade',
      'Expect',
      'Cookie',
      'User-Agent',
      'Idempotency-Key',
      'Content-Encoding',
      'X-Ccms-Signature',
      'x-ccms-anything',
      'Proxy-Authorization',
      'Proxy-Connection',
    ]) {
      expect(refusedHeaderName(name)).toBe(true);
    }
    for (const name of ['Authorization', 'X-Api-Key', 'X-Ccms', 'Proxy']) {
      expect(refusedHeaderName(name)).toBe(false);
    }
  });

  it('names every problem with its own code and pointer, never a value', () => {
    const found = problems(() =>
      checkHeaders(
        [
          { name: 'Host', value: 'a' },
          { name: 'Bad:Name', value: 'a' },
          { name: '', value: 'a' },
          { name: 'X-A', value: 'line\r\nX-Evil: 1' },
          { name: 'X-B', value: 'nul\u0000' },
          { name: 'X-C', value: 'ümlaut' },
          { name: 'X-D', value: '   ' },
          { name: 'X-Dup', value: '1' },
          { name: 'x-dup', value: '2' },
          { name: 'X-Plain' },
          { name: 'X-Secret', secret: true },
          { name: 'X'.repeat(101), value: 'a' },
        ],
        context(),
      ),
    );
    expect(found).toEqual([
      ['header-name-refused', '/data/attributes/headers/0/name'],
      ['header-name-invalid', '/data/attributes/headers/1/name'],
      ['header-name-invalid', '/data/attributes/headers/2/name'],
      ['header-value-invalid', '/data/attributes/headers/3/value'],
      ['header-value-invalid', '/data/attributes/headers/4/value'],
      ['header-value-invalid', '/data/attributes/headers/5/value'],
      ['header-value-invalid', '/data/attributes/headers/6/value'],
      ['header-name-duplicate', '/data/attributes/headers/8/name'],
      ['header-value-required', '/data/attributes/headers/9/value'],
      ['header-value-required', '/data/attributes/headers/10/value'],
      ['header-name-invalid', '/data/attributes/headers/11/name'],
    ]);
    try {
      checkHeaders([{ name: 'X-A', value: 'top\nsecret' }], context());
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secret');
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('allows tabs and spaces inside a value', () => {
    expect(checkHeaders([{ name: 'X-A', value: 'a\tb c' }], context())).toEqual(
      [{ name: 'X-A', value: 'a\tb c' }],
    );
  });

  it('limits the count and the size', () => {
    expect(
      problems(() =>
        checkHeaders(
          Array.from({ length: MAX_HEADERS + 1 }, (_, i) => ({
            name: `X-${i}`,
            value: 'v',
          })),
          context(),
        ),
      ),
    ).toEqual([['too-many-headers', '/data/attributes/headers']]);
    expect(
      problems(() =>
        checkHeaders(
          [
            { name: 'X-A', value: 'a'.repeat(4_000) },
            { name: 'X-B', value: 'b'.repeat(4_200) },
          ],
          context(),
        ),
      ),
    ).toEqual([['headers-too-large', '/data/attributes/headers']]);
    // A kept secret counts at its opened length.
    const existing: StoredHeader[] = [{ name: 'X-S', sealed: 'S' }];
    expect(
      problems(() =>
        checkHeaders(
          [
            { name: 'X-S', secret: true },
            { name: 'X-A', value: 'a' },
          ],
          context({ existing, lengthOf: () => 8_190 }),
        ),
      ),
    ).toEqual([['headers-too-large', '/data/attributes/headers']]);
  });

  it('keeps a stored secret value left out, in any case; never when the URL changes, and never for a plain header', () => {
    const existing: StoredHeader[] = [
      { name: 'Authorization', sealed: 'sealed(authorization):old' },
      { name: 'X-Plain', value: 'p' },
    ];
    expect(
      checkHeaders(
        [{ name: 'authorization', secret: true }],
        context({ existing }),
      ),
    ).toEqual([{ name: 'authorization', sealed: 'sealed(authorization):old' }]);
    expect(
      problems(() =>
        checkHeaders(
          [{ name: 'Authorization', secret: true }],
          context({ existing, urlChanges: true }),
        ),
      ),
    ).toEqual([['header-value-required', '/data/attributes/headers/0/value']]);
    expect(
      problems(() =>
        checkHeaders([{ name: 'X-Plain' }], context({ existing })),
      ),
    ).toEqual([['header-value-required', '/data/attributes/headers/0/value']]);
    // A stored value the key no longer opens is not kept.
    expect(
      problems(() =>
        checkHeaders(
          [{ name: 'Authorization', secret: true }],
          context({ existing, lengthOf: () => undefined }),
        ),
      ),
    ).toEqual([['header-value-required', '/data/attributes/headers/0/value']]);
    // A plain header made secret needs its value given.
    expect(
      problems(() =>
        checkHeaders(
          [{ name: 'X-Plain', secret: true }],
          context({ existing }),
        ),
      ),
    ).toEqual([['header-value-required', '/data/attributes/headers/0/value']]);
  });

  it('says what changed by name only', () => {
    const before: StoredHeader[] = [
      { name: 'Authorization', sealed: 's1' },
      { name: 'X-Kept', sealed: 'k' },
      { name: 'X-Plain', value: 'a' },
      { name: 'X-Gone', value: 'g' },
      { name: 'X-Flip', value: 'f' },
    ];
    const after: StoredHeader[] = [
      { name: 'Authorization', sealed: 's2' },
      { name: 'x-kept', sealed: 'k' },
      { name: 'X-Plain', value: 'b' },
      { name: 'X-Flip', sealed: 'f2' },
      { name: 'X-New', value: 'n' },
    ];
    expect(headerChanges(before, after)).toEqual({
      added: ['X-New'],
      removed: ['X-Gone'],
      changed: ['x-kept', 'X-Plain', 'X-Flip'],
      secretChanged: ['Authorization'],
    });
  });
});
