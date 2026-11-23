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
    });
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
