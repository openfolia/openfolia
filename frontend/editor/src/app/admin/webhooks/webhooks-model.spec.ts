import type { Me } from '../../permissions/me';
import {
  audiencesUpTo,
  checkUrl,
  coversAnyOwner,
  deliveryTone,
  headerDrafts,
  headerApiErrors,
  headerErrorText,
  headerProblems,
  headersBody,
  headersChanged,
  headersProblem,
  sensitiveHeaderName,
  urlProblemText,
  webhookErrorText,
} from './webhooks-model';

const me = (unrestricted: string[]): Me => ({
  id: 'jane',
  kind: 'user',
  name: 'Jane',
  role: '',
  permissions: new Set(unrestricted),
  unrestricted: new Set(unrestricted),
});

describe('checkUrl', () => {
  it('takes an https URL, and http with a warning', () => {
    expect(checkUrl(' https://receiver.example/hook ')).toEqual({
      problem: null,
      insecure: false,
      local: false,
    });
    expect(checkUrl('http://receiver.example/hook')).toEqual({
      problem: null,
      insecure: true,
      local: false,
    });
  });

  it('names what the API would refuse', () => {
    expect(checkUrl('').problem).toBe('empty');
    expect(checkUrl('receiver.example').problem).toBe('not-a-url');
    expect(checkUrl('ftp://receiver.example').problem).toBe('scheme');
    expect(checkUrl('https://u:p@receiver.example').problem).toBe(
      'credentials',
    );
    expect(checkUrl('https://receiver.example/#x').problem).toBe('fragment');
    expect(
      checkUrl(`https://receiver.example/${'a'.repeat(2000)}`).problem,
    ).toBe('too-long');
  });

  it('warns of a local name, which the API takes only where it allows local testing', () => {
    expect(checkUrl('http://localhost:4000/hook')).toEqual({
      problem: null,
      insecure: true,
      local: true,
    });
    expect(checkUrl('https://box.internal./hook').local).toBe(true);
  });

  it('reads an unknown API problem as not a URL', () => {
    expect(urlProblemText('scheme')).toBe('editor.admin.webhooks.url.scheme');
    expect(urlProblemText('something-new')).toBe(
      'editor.admin.webhooks.url.notAUrl',
    );
    expect(urlProblemText(undefined)).toBe('editor.admin.webhooks.url.notAUrl');
  });
});

describe('audiencesUpTo', () => {
  const levels = [{ id: 'public' }, { id: 'customer' }, { id: 'internal' }];

  it('lets through the limit and every less restricted level', () => {
    expect(audiencesUpTo(levels, 'customer').map((l) => l.id)).toEqual([
      'public',
      'customer',
    ]);
    expect(audiencesUpTo(levels, null)).toBe(levels);
  });

  it('lets nothing through for a level no longer configured', () => {
    expect(audiencesUpTo(levels, 'gone')).toEqual([]);
  });
});

describe('coversAnyOwner', () => {
  it('needs content.read unrestricted, and for imports drafts and translations too', () => {
    expect(coversAnyOwner(me(['content.read']), ['module.released'])).toBe(
      true,
    );
    expect(coversAnyOwner(me([]), ['module.released'])).toBe(false);
    expect(coversAnyOwner(me(['content.read']), ['translation.imported'])).toBe(
      false,
    );
    expect(
      coversAnyOwner(
        me(['content.read', 'content.read.draft', 'translation.manage']),
        ['translation.imported'],
      ),
    ).toBe(true);
  });
});

describe('deliveryTone', () => {
  it('reads a pending delivery that has failed before as a warning', () => {
    expect(deliveryTone({ status: 'pending', attempts: 0 })).toBe('muted');
    expect(deliveryTone({ status: 'pending', attempts: 2 })).toBe('warning');
    expect(deliveryTone({ status: 'failed', attempts: 9 })).toBe('destructive');
    expect(deliveryTone({ status: 'succeeded', attempts: 1 })).toBe('success');
  });
});

describe('webhookErrorText', () => {
  const failure = (code: string) => ({
    kind: 'not-found' as const,
    code,
    errors: [],
  });

  it('says webhooks are off for not-configured, and anything else as every call does', () => {
    expect(webhookErrorText(failure('not-configured'))).toEqual({
      key: 'editor.admin.webhooks.notConfigured',
    });
    expect(webhookErrorText(failure('not-found')).key).toBe(
      'editor.apiErrors.codes.not-found',
    );
  });
});

describe('custom headers (#457)', () => {
  const stored = [
    { name: 'Authorization', secret: true, value: null },
    { name: 'X-Api-Version', secret: false, value: '2' },
  ];

  it('checks rows as the API does', () => {
    expect(
      headerProblems(
        [
          { name: 'Host', value: 'x', secret: false, kept: false },
          { name: 'X Bad', value: 'x', secret: false, kept: false },
          { name: 'X-Ccms-Signature', value: 'x', secret: false, kept: false },
          {
            name: 'Proxy-Authorization',
            value: 'x',
            secret: true,
            kept: false,
          },
          { name: 'X-A', value: 'ü', secret: false, kept: false },
          { name: 'x-a', value: 'v', secret: false, kept: false },
          { name: 'X-B', value: '  ', secret: true, kept: false },
          { name: 'X-C', value: 'a b', secret: false, kept: false },
        ],
        false,
      ),
    ).toEqual([
      'name-refused',
      'name-invalid',
      'name-refused',
      'name-refused',
      'value-invalid',
      'name-duplicate',
      'value-required',
      null,
    ]);
  });

  it('keeps a stored secret, except when the URL changes', () => {
    const drafts = headerDrafts(stored);
    expect(drafts[0]).toEqual({
      name: 'Authorization',
      value: '',
      secret: true,
      kept: true,
    });
    expect(headerProblems(drafts, false)).toEqual([null, null]);
    expect(headerProblems(drafts, true)).toEqual(['value-again', null]);
    expect(headersChanged(drafts, stored)).toBe(false);
    expect(headersBody(drafts)).toEqual([
      { name: 'Authorization', secret: true },
      { name: 'X-Api-Version', value: '2', secret: false },
    ]);
  });

  it('sees a replaced secret, a changed value, a removed or reordered row as a change', () => {
    const drafts = headerDrafts(stored);
    expect(
      headersChanged(
        [{ ...drafts[0]!, kept: false, value: 'x' }, drafts[1]!],
        stored,
      ),
    ).toBe(true);
    expect(
      headersChanged([drafts[0]!, { ...drafts[1]!, value: '3' }], stored),
    ).toBe(true);
    expect(headersChanged([drafts[0]!], stored)).toBe(true);
    expect(headersChanged([drafts[1]!, drafts[0]!], stored)).toBe(true);
  });

  it('has a text for each code the API sends', () => {
    for (const code of [
      'header-name-invalid',
      'header-name-refused',
      'header-name-duplicate',
      'header-value-invalid',
      'header-value-required',
      'too-many-headers',
      'headers-too-large',
    ]) {
      expect(headerErrorText(code)?.key).toMatch(
        /^editor\.admin\.webhooks\.headers\.problems\./,
      );
    }
    expect(headerErrorText('headers-too-large')?.params).toEqual({
      max: 8192,
    });
    // Each text naming a limit is given it, the API's answers too.
    expect(headerErrorText('header-name-invalid')?.params).toEqual({
      max: 100,
    });
    expect(headerErrorText('too-many-headers')?.params).toEqual({ max: 20 });
    expect(headerErrorText('not-found')).toBeUndefined();
  });

  // #560: each problem on the row its `source.pointer` names.
  it('maps the API’s problems to their rows by `source.pointer`', () => {
    expect(
      headerApiErrors([
        {
          code: 'header-name-refused',
          source: { pointer: '/data/attributes/headers/1/name' },
        },
        {
          code: 'header-value-required',
          source: { pointer: '/data/attributes/headers/0/value' },
        },
        {
          code: 'headers-too-large',
          source: { pointer: '/data/attributes/headers' },
        },
      ]),
    ).toEqual([
      expect.objectContaining({ index: 1, field: 'name' }),
      expect.objectContaining({ index: 0, field: 'value' }),
      expect.objectContaining({ index: null, field: null }),
    ]);
    // Another problem in the answer: not the headers' to say.
    expect(
      headerApiErrors([
        { code: 'header-name-refused' },
        { code: 'invalid-url' },
      ]),
    ).toBeNull();
    expect(headerApiErrors([])).toBeNull();
  });

  it('checks the size before sending, counting only the name of a kept secret', () => {
    const row = (name: string, value: string, kept = false) => ({
      name,
      value,
      secret: kept,
      kept,
    });
    expect(headersProblem([row('X-A', 'v'.repeat(8189))])).toBeNull();
    expect(headersProblem([row('X-A', 'v'.repeat(8190))])).toBe('too-large');
    expect(headersProblem([row('Authorization', '', true)])).toBeNull();
    expect(
      headersProblem(Array.from({ length: 21 }, (_, i) => row(`X-${i}`, 'v'))),
    ).toBe('too-many');
  });

  it('takes a credential’s name, in any case, as secret', () => {
    expect(sensitiveHeaderName('Authorization')).toBe(true);
    expect(sensitiveHeaderName(' x-api-KEY ')).toBe(true);
    expect(sensitiveHeaderName('X-Tenant')).toBe(false);
  });
});
