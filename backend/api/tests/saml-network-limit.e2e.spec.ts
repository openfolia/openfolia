import { inflateRawSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import {
  ADDRESS_IN_TURN,
  NETWORK_QUEUE,
} from '../src/access/api/failed-authentications.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import { IdentityProviders } from '../src/access/core/identity-provider.js';
import type { SamlIdentityProvider } from '../src/access/repos/saml-identity-provider.js';
import {
  cookiePair,
  type SamlSetup,
  setCookies,
  setUpSaml,
} from './saml/setup.js';

/**
 * The answers of one network are checked one at a time (#965): answers are checked in two workers
 * shared by every client and served in turn, so a network with several in the pool, from one
 * address or many, would hold both and the others wait behind it. At most `NETWORK_QUEUE` of a
 * network wait their turn; the next is refused (`provider-unavailable`), and that is no lockout:
 * nothing is counted over time. The checks are held (`gate`) to see what is in the pool.
 */
describe('SAML sign-in, one answer of a network in the workers at a time', () => {
  let s: SamlSetup;
  /** The checks begun, and those begun and not ended. */
  let checked = 0;
  let active = 0;
  /** Which checks wait for `gate` (by their number, from 1): the workers are busy. */
  let hold: (n: number) => boolean = () => false;
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => undefined;
  beforeAll(async () => {
    s = await setUpSaml({
      CCMS_AUTH_FAILURES_MAX: '20',
      CCMS_TRUST_PROXY: 'loopback',
    });
    const provider = s.t.app
      .get(IdentityProviders)
      .find('saml') as SamlIdentityProvider;
    const check = provider.answers.check.bind(provider.answers);
    provider.answers.check = async (...args) => {
      const n = ++checked;
      active++;
      try {
        if (hold(n)) await gate;
        return await check(...args);
      } finally {
        active--;
      }
    };
  });
  afterAll(async () => {
    await s?.close();
  });
  afterEach(() => {
    open();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    checked = 0;
    active = 0;
    hold = () => false;
    gate = new Promise((resolve) => (open = resolve));
  });

  /** Begins a sign-in and posts its answer as the client `from`; where the browser is sent. */
  async function signIn(from: string, bad = false) {
    const begun = await s.t.anonymous().get('/auth/saml/sign-in').expect(303);
    const request = inflateRawSync(
      Buffer.from(
        new URL(begun.headers['location'] as string).searchParams.get(
          'SAMLRequest',
        )!,
        'base64',
      ),
    ).toString('utf8');
    const answer = s.mock.answer({
      login: 'pat',
      inResponseTo: /\sID="([^"]+)"/.exec(request)![1]!,
      ...(bad ? { signWith: 'other' as const } : {}),
    });
    const res = await s.t
      .anonymous()
      .post('/auth/saml/callback')
      .set('X-Forwarded-For', from)
      .set('Cookie', cookiePair(setCookies(begun)[0]!))
      .type('form')
      .send({ SAMLResponse: answer })
      .expect(303);
    return {
      to: (res.headers['location'] as string).replace(s.base, ''),
      session: setCookies(res).some((line) =>
        line.startsWith(`${SESSION_COOKIE}=ccms_ses_`),
      ),
    };
  }
  const IN = { to: '/', session: true };
  const FAILED = '/sign-in?error=sign-in-failed';
  const UNAVAILABLE = '/sign-in?error=provider-unavailable';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  /** `count` bad answers at once from addresses of one network; how many were refused unchecked. */
  function crowd(address: (i: number) => string, count: number) {
    const refused = { count: 0 };
    const answers = Array.from({ length: count }, (_, i) =>
      signIn(address(i), true).then((a) => {
        if (a.to === UNAVAILABLE) refused.count++;
        return a;
      }),
    );
    return { answers, refused };
  }

  it('checks several answers of one address one after the other', async () => {
    // Two at once is within the address's limit: both are checked, the second after the first.
    hold = (n) => n === 1;
    const both = [signIn('203.0.112.1', true), signIn('203.0.112.1', true)];
    await vi.waitFor(() => expect(checked).toBe(1));
    await settle();
    expect(checked).toBe(1);
    open();
    expect((await Promise.all(both)).map((a) => a.to)).toEqual([
      FAILED,
      FAILED,
    ]);
    expect(checked).toBe(2);
  });

  it.each([
    ['IPv4 addresses of one /24', (i: number) => `203.0.113.${i + 1}`],
    ['IPv6 addresses of one /48', (i: number) => `2001:db8:1:${i + 1}::1`],
  ])(
    'puts one answer of the network in the workers, queues %s, refuses past the queue, and another network is checked meanwhile',
    async (_, address) => {
      hold = (n) => n === 1;
      const { answers, refused } = crowd(address, 40);
      await vi.waitFor(() => expect(checked).toBe(1));
      await vi.waitFor(() => expect(refused.count).toBe(40 - NETWORK_QUEUE));
      expect(checked).toBe(1);
      // A neighbour of the crowd in another network: checked at once, while the first is held.
      expect(await signIn('198.51.100.7')).toMatchObject(IN);
      expect(checked).toBe(2);
      open();
      const done = await Promise.all(answers);
      // The one, and those that waited for it, in turn; one at a time.
      expect(done.filter((a) => a.to === FAILED)).toHaveLength(NETWORK_QUEUE);
      expect(checked).toBe(NETWORK_QUEUE + 1);
      // No lockout: its answers done, the network signs in again.
      expect(await signIn(address(99))).toMatchObject(IN);
    },
  );

  it('keeps places for the neighbours of one address that floods', async () => {
    hold = (n) => n === 1;
    // One address, within its own limit, sends more than the network's queue holds.
    const flood = crowd(() => '203.0.116.1', NETWORK_QUEUE + 4);
    await vi.waitFor(() => expect(checked).toBe(1));
    await vi.waitFor(() =>
      expect(flood.refused.count).toBe(NETWORK_QUEUE + 4 - ADDRESS_IN_TURN),
    );
    // A neighbour in the same /24 takes a place in the queue, and is checked when its turn comes.
    const neighbour = signIn('203.0.116.2');
    await settle();
    open();
    expect(await neighbour).toMatchObject(IN);
    const done = await Promise.all(flood.answers);
    expect(done.filter((a) => a.to === FAILED)).toHaveLength(ADDRESS_IN_TURN);
  });

  it('puts one answer of each of many networks in the workers, and a legitimate one is still checked', async () => {
    hold = (n) => n <= 4;
    const nets = ['192.0.2', '192.0.3', '192.0.4', '192.0.5'];
    const crowds = nets.map((net) => crowd((i) => `${net}.${i + 1}`, 5));
    await vi.waitFor(() => expect(checked).toBe(4));
    await settle();
    // One of each network, not twenty.
    expect(checked).toBe(4);
    expect(active).toBe(4);
    // Another network's answer reaches the pool, not queued behind theirs.
    const legitimate = signIn('198.51.100.9');
    await vi.waitFor(() => expect(checked).toBe(5));
    open();
    expect(await legitimate).toMatchObject(IN);
    await Promise.all(crowds.flatMap((c) => c.answers));
  });

  it('logs a refusal for each network, once', async () => {
    hold = (n) => n <= 2;
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const one = crowd((i) => `192.0.6.${i + 1}`, NETWORK_QUEUE + 3);
    const two = crowd((i) => `198.51.101.${i + 1}`, NETWORK_QUEUE + 3);
    await vi.waitFor(() => expect(one.refused.count).toBe(3));
    await vi.waitFor(() => expect(two.refused.count).toBe(3));
    open();
    await Promise.all([...one.answers, ...two.answers]);
    const logged = warn.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('not checked'));
    expect(logged).toHaveLength(2);
    expect(logged.join()).toContain('192.0.6.0/24');
    expect(logged.join()).toContain('198.51.101.0/24');
  });

  // A regression guard (the failure counts are per address already), not proof of the bound.
  it('lets a network sign in whatever one of its addresses did', async () => {
    // One address fails past its own limit (20) ...
    for (let i = 0; i < 20; i++) await signIn('203.0.114.1', true);
    expect(await signIn('203.0.114.1')).toMatchObject({
      to: '/sign-in?error=too-many-failed-attempts',
    });
    // ... and its neighbour in the same /24 signs in.
    expect(await signIn('203.0.114.2')).toMatchObject(IN);
  });
});
