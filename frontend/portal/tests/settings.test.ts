import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSettings, SettingsError } from '../build/settings.ts';

const TOKEN = `ccms_sat_${'a'.repeat(16)}_${'b'.repeat(64)}`;
const settingsOf = (over: Record<string, string | undefined> = {}) => ({
  CCMS_PORTAL_API_URL: 'https://docs-api.example.com/api',
  CCMS_PORTAL_TOKEN: TOKEN,
  CCMS_PORTAL_AUDIENCE: 'public',
  ...over,
});

describe('portal settings', () => {
  it('reads the defaults', () => {
    const s = readSettings(settingsOf(), '/work');
    expect(s.apiUrl.href).toBe('https://docs-api.example.com/api/');
    expect(s).toMatchObject({
      audience: 'public',
      languages: undefined,
      releases: undefined,
      releasesPerProduct: 1,
      olderNoindex: true,
      outDir: '/work/dist',
      basePath: '/',
      branding: true,
    });
  });

  it('reads how many releases per product, and the older pages’ noindex (#896)', () => {
    expect(
      readSettings(
        settingsOf({
          CCMS_PORTAL_RELEASES_PER_PRODUCT: ' 3 ',
          CCMS_PORTAL_OLDER_NOINDEX: 'off',
        }),
        '/work',
      ),
    ).toMatchObject({ releasesPerProduct: 3, olderNoindex: false });
    expect(
      readSettings(
        settingsOf({ CCMS_PORTAL_RELEASES_PER_PRODUCT: '20' }),
        '/work',
      ).releasesPerProduct,
    ).toBe(20);
  });

  it('reads the start page and the portal’s own address (#897)', () => {
    const read = (over: Record<string, string>) =>
      readSettings(settingsOf(over), '/work');
    expect(read({})).toMatchObject({
      start: undefined,
      portalOrigin: undefined,
    });
    expect(
      read({
        CCMS_PORTAL_START: 'internal-start, portal-start',
        CCMS_PORTAL_URL: 'https://docs.example.com',
      }),
    ).toMatchObject({
      start: ['internal-start', 'portal-start'],
      portalOrigin: 'https://docs.example.com',
    });
    expect(
      read({
        CCMS_PORTAL_URL: 'http://docs.example.com:8090/manuals',
        CCMS_PORTAL_BASE_PATH: '/manuals/',
      }).portalOrigin,
    ).toBe('http://docs.example.com:8090');
    for (const CCMS_PORTAL_START of ['Start', '../start', 'a b', 'a,B'])
      expect(() => read({ CCMS_PORTAL_START })).toThrow(SettingsError);
    for (const CCMS_PORTAL_URL of [
      'docs.example.com',
      'ftp://docs.example.com',
      'https://docs.example.com/other/',
      'https://user@docs.example.com',
      'https://docs.example.com/?q',
    ])
      expect(() => read({ CCMS_PORTAL_URL })).toThrow('CCMS_PORTAL_URL: the');
  });

  it('turns the branding off', () => {
    expect(
      readSettings(settingsOf({ CCMS_PORTAL_BRANDING: 'off' }), '/work')
        .branding,
    ).toBe(false);
    expect(
      readSettings(settingsOf({ CCMS_PORTAL_BRANDING: 'on' }), '/work')
        .branding,
    ).toBe(true);
  });

  it('reads the lists, the folder and the path', () => {
    const s = readSettings(
      settingsOf({
        CCMS_PORTAL_LANGUAGES: 'en, de,en',
        CCMS_PORTAL_RELEASES: '0193a8d0-0000-7000-8000-000000000001',
        CCMS_PORTAL_OUT_DIR: 'site',
        CCMS_PORTAL_BASE_PATH: '/docs/',
      }),
      '/work',
    );
    expect(s).toMatchObject({
      languages: ['en', 'de'],
      releases: ['0193a8d0-0000-7000-8000-000000000001'],
      outDir: '/work/site',
      basePath: '/docs/',
    });
  });

  it.each([
    [{ CCMS_PORTAL_API_URL: undefined }, 'CCMS_PORTAL_API_URL: is required'],
    [{ CCMS_PORTAL_TOKEN: '' }, 'CCMS_PORTAL_TOKEN: is required'],
    [
      { CCMS_PORTAL_TOKEN: 'not-a-token' },
      'CCMS_PORTAL_TOKEN: a service account token',
    ],
    [{ CCMS_PORTAL_AUDIENCE: 'Public!' }, 'CCMS_PORTAL_AUDIENCE'],
    [
      { CCMS_PORTAL_API_URL: 'http://api.example.com' },
      'https, or http only to this machine',
    ],
    [{ CCMS_PORTAL_API_URL: 'ftp://127.0.0.1' }, 'http or https only'],
    [
      { CCMS_PORTAL_API_URL: 'https://user:pw@api.example.com' },
      'no user, password',
    ],
    [{ CCMS_PORTAL_LANGUAGES: 'en,../x' }, 'CCMS_PORTAL_LANGUAGES'],
    [{ CCMS_PORTAL_RELEASES: 'v1' }, 'CCMS_PORTAL_RELEASES'],
    [{ CCMS_PORTAL_BASE_PATH: 'docs' }, 'CCMS_PORTAL_BASE_PATH'],
    [{ CCMS_PORTAL_OUT_DIR: '.' }, 'CCMS_PORTAL_OUT_DIR: a folder of its own'],
    [{ CCMS_PORTAL_OUT_DIR: '..' }, 'CCMS_PORTAL_OUT_DIR'],
    [{ CCMS_PORTAL_OUT_DIR: '/' }, 'CCMS_PORTAL_OUT_DIR'],
    [{ CCMS_PORTAL_LANGUAGES: 'en,de,EN' }, 'differ only in case'],
    [{ CCMS_PORTAL_BRANDING: 'yes' }, 'CCMS_PORTAL_BRANDING: on or off'],
    [{ CCMS_PORTAL_RELEASES_PER_PRODUCT: '0' }, 'from 1 to 20'],
    [{ CCMS_PORTAL_RELEASES_PER_PRODUCT: '21' }, 'from 1 to 20'],
    [{ CCMS_PORTAL_RELEASES_PER_PRODUCT: '2.5' }, 'from 1 to 20'],
    [{ CCMS_PORTAL_RELEASES_PER_PRODUCT: 'all' }, 'from 1 to 20'],
    [
      {
        CCMS_PORTAL_RELEASES_PER_PRODUCT: '2',
        CCMS_PORTAL_RELEASES: '0193a8d0-0000-7000-8000-000000000001',
      },
      'not with CCMS_PORTAL_RELEASES',
    ],
    [
      { CCMS_PORTAL_OLDER_NOINDEX: 'no' },
      'CCMS_PORTAL_OLDER_NOINDEX: on or off',
    ],
  ])('refuses %o', (over, message) => {
    expect(() => readSettings(settingsOf(over), '/work')).toThrow(
      SettingsError,
    );
    expect(() => readSettings(settingsOf(over), '/work')).toThrow(message);
  });

  it('tells a folder named "..x" from a parent folder', () => {
    // The build runs in a child folder named `..x` of the output folder: refused, it holds it.
    expect(() =>
      readSettings(
        settingsOf({ CCMS_PORTAL_OUT_DIR: '/work/site' }),
        '/work/site/..x',
      ),
    ).toThrow('CCMS_PORTAL_OUT_DIR: a folder of its own');
    // A child folder named `..x` of the current folder is a folder of its own.
    expect(
      readSettings(settingsOf({ CCMS_PORTAL_OUT_DIR: '..x' }), '/work').outDir,
    ).toBe('/work/..x');
    expect(
      readSettings(settingsOf({ CCMS_PORTAL_OUT_DIR: '../site' }), '/work/a')
        .outDir,
    ).toBe('/work/site');
  });

  it('never names the token in a message', () => {
    const bad = `${TOKEN}x`;
    expect(() =>
      readSettings(settingsOf({ CCMS_PORTAL_TOKEN: bad }), '/work'),
    ).toThrow(SettingsError);
    try {
      readSettings(settingsOf({ CCMS_PORTAL_TOKEN: bad }), '/work');
    } catch (error) {
      expect(String(error)).not.toContain(bad.slice(10));
    }
  });

  it('allows http to this machine only', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]'])
      expect(
        readSettings(
          settingsOf({ CCMS_PORTAL_API_URL: `http://${host}:3103` }),
          '/',
        ).apiUrl.protocol,
      ).toBe('http:');
  });

  it('allows http to a host of CCMS_PORTAL_HTTP_HOSTS too (a container network), no other', () => {
    const hosts = { CCMS_PORTAL_HTTP_HOSTS: 'api, Docs-API.internal' };
    for (const url of ['http://api:3000', 'http://docs-api.internal/v1'])
      expect(
        readSettings(settingsOf({ ...hosts, CCMS_PORTAL_API_URL: url }), '/')
          .apiUrl.protocol,
      ).toBe('http:');
    expect(() =>
      readSettings(
        settingsOf({ ...hosts, CCMS_PORTAL_API_URL: 'http://api2:3000' }),
        '/',
      ),
    ).toThrow('or a host of CCMS_PORTAL_HTTP_HOSTS');
    expect(() =>
      readSettings(settingsOf({ CCMS_PORTAL_HTTP_HOSTS: 'api:3000' }), '/'),
    ).toThrow('CCMS_PORTAL_HTTP_HOSTS: comma-separated host names');
  });

  it('documents every setting in .env.example', () => {
    const example = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '.env.example'),
      'utf8',
    );
    for (const key of [
      'CCMS_PORTAL_API_URL',
      'CCMS_PORTAL_TOKEN',
      'CCMS_PORTAL_AUDIENCE',
      'CCMS_PORTAL_LANGUAGES',
      'CCMS_PORTAL_RELEASES',
      'CCMS_PORTAL_OUT_DIR',
      'CCMS_PORTAL_BASE_PATH',
      'CCMS_PORTAL_BRANDING',
      'CCMS_PORTAL_HTTP_HOSTS',
      'CCMS_PORTAL_REFRESH_SECONDS',
      'CCMS_PORTAL_TOKEN_FILE',
      'OPENFOLIA_PORTAL_PORT',
    ])
      expect(example).toMatch(new RegExp(`^${key}=$`, 'm'));
  });
});
