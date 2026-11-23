import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  startMockProvider,
  type MockProvider,
} from '../../../tests/oidc/mock-provider.js';
import { signInThroughMock } from '../../../tests/oidc/sign-in-driver.js';
import { SignInFailedError } from '../core/identity-provider.js';
import {
  claimAt,
  groupsFrom,
  OidcIdentityProvider,
} from './oidc-identity-provider.js';

describe('claims', () => {
  it('reads a claim by its name, else by a dotted path', () => {
    const claims = {
      groups: ['a'],
      'org.groups': ['exact'],
      realm: { roles: ['nested'], list: [1] },
    };
    expect(claimAt(claims, 'groups')).toEqual(['a']);
    expect(claimAt(claims, 'org.groups')).toEqual(['exact']);
    expect(claimAt(claims, 'realm.roles')).toEqual(['nested']);
    expect(claimAt(claims, 'realm.list.0')).toBeUndefined();
    expect(claimAt(claims, 'realm.missing')).toBeUndefined();
    expect(claimAt(claims, 'toString')).toBeUndefined();
  });

  it('takes groups as a list of strings, or one string', () => {
    expect(groupsFrom(['a', 2, 'b'])).toEqual(['a', 'b']);
    expect(groupsFrom('a')).toEqual(['a']);
    expect(groupsFrom({ a: 1 })).toEqual([]);
    expect(groupsFrom(undefined)).toEqual([]);
  });
});

describe('OidcIdentityProvider against a local provider', () => {
  let mock: MockProvider;
  let landing: Server;
  let redirectUrl: string;

  beforeAll(async () => {
    // Where the browser comes back to: answers anything, so the driver stops there.
    landing = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) =>
      landing.listen(0, '127.0.0.1', resolve),
    );
    redirectUrl = `http://127.0.0.1:${(landing.address() as AddressInfo).port}/api/auth/oidc/callback`;
    mock = await startMockProvider({
      clientId: 'public-client',
      redirectUris: [redirectUrl],
      groupsClaim: 'org.groups',
      accounts: {
        pat: {
          name: 'Pat',
          email: 'pat@example.org',
          groups: ['writers', 'admins'],
        },
        quiet: {},
      },
    });
  });
  afterAll(async () => {
    await mock?.close();
    await new Promise((resolve) => landing?.close(resolve));
  });

  const provider = (overrides: Partial<{ issuer: string }> = {}) =>
    new OidcIdentityProvider({
      issuer: mock.issuer,
      clientId: 'public-client',
      redirectUrl,
      scopes: ['openid', 'profile', 'email'],
      groupsClaim: 'org.groups',
      displayName: 'Local',
      ...overrides,
    });

  async function signIn(oidc: OidcIdentityProvider, login: string) {
    const begun = await oidc.begin();
    const url = new URL(begun.authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const { finalUrl } = await signInThroughMock({
      signInUrl: begun.authorizationUrl,
      login,
    });
    return { callback: new URL(finalUrl).searchParams, pending: begun.pending };
  }

  it('signs in as a public client with PKCE, reading the groups from the configured claim', async () => {
    const oidc = provider();
    const { callback, pending } = await signIn(oidc, 'pat');
    expect(await oidc.complete(callback, pending)).toEqual({
      issuer: mock.issuer,
      subject: 'pat',
      email: 'pat@example.org',
      emailVerified: true,
      name: 'Pat',
      username: 'pat',
      groups: ['writers', 'admins'],
    });
  });

  it('takes someone without email or groups', async () => {
    const oidc = provider();
    const { callback, pending } = await signIn(oidc, 'quiet');
    expect(await oidc.complete(callback, pending)).toMatchObject({
      subject: 'quiet',
      email: null,
      groups: [],
    });
  });

  it('refuses an answer to another sign-in, and a code used twice', async () => {
    const oidc = provider();
    const first = await signIn(oidc, 'pat');
    const second = await oidc.begin();
    await expect(oidc.complete(first.callback, second.pending)).rejects.toThrow(
      SignInFailedError,
    );
    await oidc.complete(first.callback, first.pending);
    await expect(
      oidc.complete(first.callback, first.pending),
    ).rejects.toMatchObject({ reason: 'sign-in-failed' });
  });

  it('says a cancelled sign-in, and a provider it cannot reach', async () => {
    const oidc = provider();
    const { pending } = await oidc.begin();
    await expect(
      oidc.complete(
        new URLSearchParams({ error: 'access_denied', state: 'x' }),
        pending,
      ),
    ).rejects.toMatchObject({ reason: 'access-denied' });
    const down = provider({ issuer: 'http://127.0.0.1:1' });
    await expect(down.begin()).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
  });

  it('builds the provider’s sign-out address', async () => {
    const url = await provider().signOutUrl('http://127.0.0.1:9/sign-in');
    expect(url).toMatch(new RegExp(`^${mock.issuer}/session/end\\?`));
    expect(new URL(url!).searchParams.get('client_id')).toBe('public-client');
  });
});
