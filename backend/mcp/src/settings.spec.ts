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
    const token = '9f3c2a71e04b8d65c1a7f0e93b42d8a6';
    expect(
      loadSettings('http', {
        ...API,
        CCMS_MCP_HTTP_TOKEN: token,
        CCMS_MCP_HTTP_PORT: '',
      }),
    ).toEqual({
      ...API,
      CCMS_MCP_HTTP_HOST: '127.0.0.1',
      CCMS_MCP_HTTP_PORT: 3200,
      CCMS_MCP_HTTP_TOKEN: token,
      CCMS_MCP_HTTP_ALLOWED_ORIGINS: [],
      CCMS_MCP_HTTP_TRUST_PROXY: 0,
      CCMS_MCP_HTTP_PROXY_ADDRESSES: [],
    });
  });

  it('needs no token of its own over HTTP (#861): callers bring theirs; the deprecated shared one needs the API token', () => {
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
    expect(http.CCMS_MCP_HTTP_TOKEN).toBeUndefined();
    expect(() =>
      loadSettings('http', {
        CCMS_MCP_API_URL: API.CCMS_MCP_API_URL,
        CCMS_MCP_HTTP_TOKEN: '9f3c2a71e04b8d65c1a7f0e93b42d8a6',
      }),
    ).toThrow(/CCMS_MCP_API_TOKEN: required with CCMS_MCP_HTTP_TOKEN/);
  });

  it('takes none or a hop count from 1 to 10 for CCMS_MCP_HTTP_TRUST_PROXY, with the proxies named', () => {
    const http = (env: Record<string, string>) =>
      loadSettings('http', {
        ...API,
        CCMS_MCP_HTTP_TOKEN: '9f3c2a71e04b8d65c1a7f0e93b42d8a6',
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

  it('refuses a short HTTP token, one equal to the API token, and a URL that is no http(s), naming no value', () => {
    expect(() =>
      loadSettings('http', { ...API, CCMS_MCP_HTTP_TOKEN: 'short-secret' }),
    ).toThrow(/at least 32/);
    expect(() =>
      loadSettings('http', { ...API, CCMS_MCP_HTTP_TOKEN: 'short-secret' }),
    ).not.toThrow(/short-secret/);
    const same = '4be0c95a7d1f36e28a0b5c9d7e14f3a26b8c0d9e';
    expect(() =>
      loadSettings('http', {
        ...API,
        CCMS_MCP_API_TOKEN: same,
        CCMS_MCP_HTTP_TOKEN: same,
      }),
    ).toThrow(/must differ/);
    expect(() =>
      loadSettings('stdio', { ...API, CCMS_MCP_API_URL: 'file:///etc/passwd' }),
    ).toThrow(/CCMS_MCP_API_URL/);
  });

  it('refuses an HTTP token that is plainly not random', () => {
    expect(() =>
      loadSettings('http', { ...API, CCMS_MCP_HTTP_TOKEN: 'a'.repeat(64) }),
    ).toThrow(/different characters/);
    expect(() =>
      loadSettings('http', { ...API, CCMS_MCP_HTTP_TOKEN: 'secret'.repeat(8) }),
    ).toThrow(/different characters/);
    expect(() =>
      loadSettings('http', {
        ...API,
        CCMS_MCP_HTTP_TOKEN: '0123456789abcdef'.repeat(2),
      }),
    ).toThrow(/repeated pattern/);
  });

  it('reads the allowed origins as a list', () => {
    const s = loadSettings('http', {
      ...API,
      CCMS_MCP_HTTP_TOKEN: 'd27a9c0e5b41f863a7e2c9b05d14f68e',
      CCMS_MCP_HTTP_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(s.CCMS_MCP_HTTP_ALLOWED_ORIGINS).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
