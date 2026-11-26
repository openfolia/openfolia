import { loadSettings } from './settings.js';

const API = {
  CCMS_MCP_API_URL: 'http://127.0.0.1:3000',
  CCMS_MCP_API_TOKEN: 'ccms_sat_x',
};

describe('loadSettings', () => {
  it('needs the API URL and token; the HTTP transport its own token too, with defaults', () => {
    expect(loadSettings('stdio', API)).toEqual(API);
    expect(() => loadSettings('stdio', {})).toThrow(
      /CCMS_MCP_API_URL[\s\S]*CCMS_MCP_API_TOKEN/,
    );
    expect(loadSettings('http', { ...API, CCMS_MCP_HTTP_PORT: '' })).toEqual({
      ...API,
      CCMS_MCP_HTTP_HOST: '127.0.0.1',
      CCMS_MCP_HTTP_PORT: 3200,
      CCMS_MCP_HTTP_ALLOWED_ORIGINS: [],
      CCMS_MCP_HTTP_TRUST_PROXY: 0,
      CCMS_MCP_HTTP_PROXY_ADDRESSES: [],
    });
  });

  it('needs no token of its own over HTTP (#861): callers bring theirs', () => {
    expect(
      loadSettings('http', { CCMS_MCP_API_URL: API.CCMS_MCP_API_URL }),
    ).toMatchObject({
      CCMS_MCP_API_URL: API.CCMS_MCP_API_URL,
      CCMS_MCP_HTTP_PORT: 3200,
    });
    const http = loadSettings('http', {
      CCMS_MCP_API_URL: API.CCMS_MCP_API_URL,
    });
    expect(http.CCMS_MCP_API_TOKEN).toBeUndefined();
  });

  it('takes none or a hop count from 1 to 10 for CCMS_MCP_HTTP_TRUST_PROXY, with the proxies named', () => {
    const http = (env: Record<string, string>) =>
      loadSettings('http', {
        ...API,
        ...env,
      });
    const trust = (value: string) =>
      http({
        CCMS_MCP_HTTP_TRUST_PROXY: value,
        CCMS_MCP_HTTP_PROXY_ADDRESSES: 'editor',
      }).CCMS_MCP_HTTP_TRUST_PROXY;
    expect(() => http({ CCMS_MCP_HTTP_TRUST_PROXY: '1' })).toThrow(
      /CCMS_MCP_HTTP_PROXY_ADDRESSES: required/,
    );
    expect(
      http({
        CCMS_MCP_HTTP_TRUST_PROXY: '1',
        CCMS_MCP_HTTP_PROXY_ADDRESSES:
          ' editor, 172.18.0.0/16 ,fd00::/16,10.0.0.2',
      }).CCMS_MCP_HTTP_PROXY_ADDRESSES,
    ).toEqual(['editor', '172.18.0.0/16', 'fd00::/16', '10.0.0.2']);
    for (const bad of [
      '0.0.0.0/0',
      '10.0.0.0/7',
      '::/8',
      'a b',
      'x/16',
      '10.0.0.1/33',
    ]) {
      expect(() =>
        http({
          CCMS_MCP_HTTP_TRUST_PROXY: '1',
          CCMS_MCP_HTTP_PROXY_ADDRESSES: bad,
        }),
      ).toThrow(/CCMS_MCP_HTTP_PROXY_ADDRESSES/);
    }
    expect(trust('none')).toBe(0);
    expect(trust(' 1 ')).toBe(1);
    expect(trust('10')).toBe(10);
    for (const bad of ['0', '11', 'true', '-1', '1.5', '10.0.0.1']) {
      expect(() => trust(bad)).toThrow(/CCMS_MCP_HTTP_TRUST_PROXY/);
    }
  });

  it('refuses to start while the removed shared CCMS_MCP_HTTP_TOKEN is set (#922), naming no value', () => {
    const shared = '9f3c2a71e04b8d65c1a7f0e93b42d8a6';
    for (const load of [
      (env: Record<string, string>) => loadSettings('http', env),
      (env: Record<string, string>) => loadSettings('stdio', env),
    ]) {
      expect(() => load({ ...API, CCMS_MCP_HTTP_TOKEN: shared })).toThrow(
        /CCMS_MCP_HTTP_TOKEN \(or CCMS_MCP_HTTP_TOKEN_FILE\) is removed[\s\S]*service account token/,
      );
      expect(() => load({ ...API, CCMS_MCP_HTTP_TOKEN: shared })).not.toThrow(
        new RegExp(shared),
      );
    }
    expect(() =>
      loadSettings('http', { ...API, CCMS_MCP_HTTP_TOKEN_FILE: '/x' }),
    ).toThrow(/is removed/);
    // An empty value counts as unset.
    expect(() =>
      loadSettings('http', { ...API, CCMS_MCP_HTTP_TOKEN: '' }),
    ).not.toThrow();
  });

  it('refuses a URL that is no http(s)', () => {
    expect(() =>
      loadSettings('stdio', { ...API, CCMS_MCP_API_URL: 'file:///etc/passwd' }),
    ).toThrow(/CCMS_MCP_API_URL/);
  });

  it('reads the allowed origins as a list', () => {
    const s = loadSettings('http', {
      ...API,
      CCMS_MCP_HTTP_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(s.CCMS_MCP_HTTP_ALLOWED_ORIGINS).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
