import { validateEnv } from './env.js';

const base = {
  CCMS_CONTENT_DIR: '/srv/content',
  CCMS_API_TOKEN: 'x'.repeat(32),
  CCMS_DATABASE_URL: 'postgres://ccms:secret@db:5432/ccms',
  CCMS_BLOB_DRIVER: 'fs',
  CCMS_BLOB_FS_ROOT: '/srv/blobs',
};

describe('email settings', () => {
  it('are off by default, TLS required, English', () => {
    const env = validateEnv(base);
    expect(env.CCMS_MAIL_URL).toBeUndefined();
    expect(env.CCMS_MAIL_REQUIRE_TLS).toBe(true);
    expect(env.CCMS_MAIL_LANGUAGE).toBe('en');
  });

  it.each([
    [
      'smtp://mail.example.com',
      { host: 'mail.example.com', port: 587, implicitTls: false },
    ],
    [
      'smtps://mail.example.com',
      { host: 'mail.example.com', port: 465, implicitTls: true },
    ],
    [
      'smtp://mail.example.com:2525/',
      { host: 'mail.example.com', port: 2525, implicitTls: false },
    ],
    ['smtp://[::1]:25', { host: '::1', port: 25, implicitTls: false }],
  ])('reads %s', (url, server) => {
    expect(
      validateEnv({
        ...base,
        CCMS_MAIL_URL: url,
        CCMS_MAIL_FROM: 'docs@example.com',
      }).CCMS_MAIL_URL,
    ).toEqual(server);
  });

  it.each([
    'http://mail.example.com',
    'smtp://user:pass@mail.example.com',
    'smtp://user@mail.example.com',
    'smtp://mail.example.com/path',
    'smtp://mail.example.com?x=1',
    'smtp://',
    'mail.example.com',
  ])('refuses %s, never repeating it', (url) => {
    let message = '';
    try {
      validateEnv({
        ...base,
        CCMS_MAIL_URL: url,
        CCMS_MAIL_FROM: 'a@example.com',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('CCMS_MAIL_URL');
    expect(message).not.toContain('pass@');
  });

  it('needs a sender with a server', () => {
    expect(() =>
      validateEnv({ ...base, CCMS_MAIL_URL: 'smtp://mail.example.com' }),
    ).toThrow(/required with CCMS_MAIL_URL[\s\S]*CCMS_MAIL_FROM/);
  });

  it.each([
    'Docs <docs@example.com>',
    'docs@example.com\r\nBcc: x@example.com',
    'not-an-address',
  ])('refuses %j as the sender', (from) => {
    expect(() =>
      validateEnv({
        ...base,
        CCMS_MAIL_URL: 'smtp://mail.example.com',
        CCMS_MAIL_FROM: from,
      }),
    ).toThrow(/CCMS_MAIL_FROM/);
  });

  it('takes a user with a password or a password file, not one without the other', () => {
    const server = {
      ...base,
      CCMS_MAIL_URL: 'smtp://mail.example.com',
      CCMS_MAIL_FROM: 'docs@example.com',
    };
    expect(
      validateEnv({ ...server, CCMS_MAIL_USER: 'u', CCMS_MAIL_PASSWORD: 'p' })
        .CCMS_MAIL_USER,
    ).toBe('u');
    expect(
      validateEnv({
        ...server,
        CCMS_MAIL_USER: 'u',
        CCMS_MAIL_PASSWORD_FILE: '/run/secrets/mail',
      }).CCMS_MAIL_PASSWORD_FILE,
    ).toBe('/run/secrets/mail');
    expect(() => validateEnv({ ...server, CCMS_MAIL_USER: 'u' })).toThrow(
      /CCMS_MAIL_PASSWORD/,
    );
    expect(() =>
      validateEnv({ ...server, CCMS_MAIL_PASSWORD: 'secret-value' }),
    ).toThrow(/CCMS_MAIL_USER/);
    expect(() =>
      validateEnv({ ...server, CCMS_MAIL_PASSWORD_FILE: 'relative/file' }),
    ).toThrow(/absolute path/);
  });

  it('never repeats the password in an error', () => {
    let message = '';
    try {
      validateEnv({ ...base, CCMS_MAIL_PASSWORD: 'secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('secret-value');
  });

  it('takes en or de as the language', () => {
    expect(
      validateEnv({ ...base, CCMS_MAIL_LANGUAGE: 'de' }).CCMS_MAIL_LANGUAGE,
    ).toBe('de');
    expect(() => validateEnv({ ...base, CCMS_MAIL_LANGUAGE: 'fr' })).toThrow(
      /CCMS_MAIL_LANGUAGE/,
    );
  });
});
