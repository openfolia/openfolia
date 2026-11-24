// The small parts: the client's address, the proof of work, the rate limit, the settings, the texts.
import { readFileSync } from 'node:fs';
import { BlockList } from 'node:net';
import { addressKey, clientAddress } from '../src/address.js';
import { leadingZeroBits, ProofOfWork, sha256, solve } from '../src/pow.js';
import { RateLimiter } from '../src/rate.js';
import { agentSettings, launcherSettings } from '../src/settings.js';
import { TEXTS } from '../src/texts.js';
import { clock } from './fakes.js';

const TOKEN = 'a'.repeat(64);

describe('the client address', () => {
  it('is the peer without a trusted proxy, whatever X-Forwarded-For says', () => {
    expect(clientAddress('10.0.0.9', '1.2.3.4', 0)).toBe('10.0.0.9');
    expect(clientAddress('::ffff:10.0.0.9', undefined, 0)).toBe('10.0.0.9');
  });

  it('is what the outermost trusted proxy saw, never what the client put left of it', () => {
    const proxy = new BlockList();
    proxy.addAddress('172.18.0.2');
    expect(clientAddress('172.18.0.2', 'spoofed, 203.0.113.7', 1, proxy)).toBe(
      '203.0.113.7',
    );
    expect(
      clientAddress('172.18.0.2', '9.9.9.9, 203.0.113.7, 172.18.0.5', 2, proxy),
    ).toBe('203.0.113.7');
    expect(clientAddress('172.18.0.2', undefined, 1, proxy)).toBeUndefined();
    expect(
      clientAddress('172.18.0.2', 'not-an-address', 1, proxy),
    ).toBeUndefined();
  });

  it('reads X-Forwarded-For only from a configured proxy', () => {
    const proxy = new BlockList();
    proxy.addSubnet('10.9.9.0', 24);
    // A sandbox shares a network with the launcher: what it forwards is nobody's word.
    expect(
      clientAddress('172.18.0.5', '203.0.113.7', 1, proxy),
    ).toBeUndefined();
    expect(clientAddress('172.18.0.5', '203.0.113.7', 1)).toBeUndefined();
    expect(clientAddress('::ffff:10.9.9.4', '203.0.113.7', 1, proxy)).toBe(
      '203.0.113.7',
    );
  });

  it('counts an IPv6 address by its /56', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:0db8:0001:0000::/56');
    expect(addressKey('2001:db8:1:ff:1::1')).toBe(
      addressKey('2001:db8:1:2::9'),
    );
    expect(addressKey('2001:db8:1:100::1')).not.toBe(
      addressKey('2001:db8:1:2::9'),
    );
    expect(addressKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(
      addressKey('2001:db8:1:2::9'),
    );
    expect(addressKey('2001:db8:2:3::1')).not.toBe(
      addressKey('2001:db8:1:2::1'),
    );
    expect(addressKey('::1')).toBe('0000:0000:0000:0000::/56');
  });
});

describe('the proof of work', () => {
  const key = Buffer.alloc(32, 7);

  it('counts leading zero bits', () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0x10, 0xff]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });

  it('takes a solved challenge once, from the address it was issued to', () => {
    const time = clock();
    const pow = new ProofOfWork(key, 8, time.now);
    const { challenge, bits } = pow.issue('10.0.0.1');
    const nonce = solve(challenge, bits);
    expect(
      leadingZeroBits(sha256(`${challenge}:${nonce}`)),
    ).toBeGreaterThanOrEqual(8);
    expect(pow.redeem(challenge, nonce, '10.0.0.2')).toBe('other-address');
    expect(pow.redeem(challenge, nonce, '10.0.0.1')).toBeUndefined();
    expect(pow.redeem(challenge, nonce, '10.0.0.1')).toBe('used');
  });

  it('refuses one unsolved, forged, expired or malformed', () => {
    const time = clock();
    const pow = new ProofOfWork(key, 12, time.now);
    const { challenge } = pow.issue('10.0.0.1');
    let wrong = 0;
    while (leadingZeroBits(sha256(`${challenge}:${wrong}`)) >= 12) wrong++;
    expect(pow.redeem(challenge, String(wrong), '10.0.0.1')).toBe('unsolved');
    // Fewer bits written into the challenge do not lower the work.
    const easier = challenge.replace(/^v1\.(\d+)\.12\./, 'v1.$1.0.');
    expect(pow.redeem(easier, '0', '10.0.0.1')).toBe('forged');
    expect(
      new ProofOfWork(Buffer.alloc(32, 8), 12, time.now).redeem(
        challenge,
        solve(challenge, 12),
        '10.0.0.1',
      ),
    ).toBe('forged');
    expect(pow.redeem(challenge, 'abc', '10.0.0.1')).toBe('malformed');
    expect(pow.redeem(42, '1', '10.0.0.1')).toBe('malformed');
    const nonce = solve(challenge, 12);
    time.advance(2 * 60_000 + 1);
    expect(pow.redeem(challenge, nonce, '10.0.0.1')).toBe('expired');
  });

  it('is the same SHA-256 as the browser worker computes', async () => {
    // page/pow-worker.js in a fake worker scope: it must find a nonce the server accepts.
    const source = readFileSync(
      new URL('../page/pow-worker.js', import.meta.url),
      'utf8',
    );
    const posted: { nonce?: string }[] = [];
    const scope: {
      onmessage?: (event: { data: unknown }) => void;
      postMessage: (m: { nonce?: string }) => void;
    } = {
      postMessage: (message) => posted.push(message),
    };
    new Function('self', source)(scope);
    const pow = new ProofOfWork(key, 10);
    for (const address of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      const { challenge, bits } = pow.issue(address);
      posted.length = 0;
      scope.onmessage!({ data: { challenge, bits } });
      const nonce = posted.find((m) => m.nonce !== undefined)?.nonce;
      expect(nonce).toBe(solve(challenge, bits));
      expect(pow.redeem(challenge, nonce, address)).toBeUndefined();
    }
  });
});

describe('the rate limit', () => {
  it('allows a burst, then the rate, per key', () => {
    const time = clock();
    const rate = new RateLimiter(2, 4, time.now);
    for (let i = 0; i < 4; i++) expect(rate.take('a')).toBe(0);
    expect(rate.take('a')).toBe(1);
    expect(rate.take('b')).toBe(0);
    time.advance(500);
    expect(rate.take('a')).toBe(0);
    expect(rate.take('a')).toBe(1);
    time.advance(10_000);
    rate.prune();
    expect(rate.size).toBe(0);
  });

  it('refuses unknown keys once it tracks the most it may', () => {
    const rate = new RateLimiter(1, 5, clock().now, 2);
    expect(rate.take('a')).toBe(0);
    expect(rate.take('b')).toBe(0);
    expect(rate.take('c')).toBe(1);
  });
});

describe('the settings', () => {
  const base = {
    CCMS_LAUNCHER_PUBLIC_URL: 'https://demo.example.org',
    CCMS_LAUNCHER_AGENT_URL: 'http://agent:8081',
    CCMS_LAUNCHER_AGENT_TOKEN: TOKEN,
  };

  it('has the open questions’ defaults', () => {
    const s = launcherSettings(base);
    expect(s).toMatchObject({
      maxSandboxes: 5,
      perAddress: 1,
      perAddressDaily: 3,
      idleMinutes: 30,
      maxMinutes: 90,
      abuseContact: undefined,
      portalUrl: undefined,
      bookingUrl: undefined,
    });
  });

  it('takes an https booking address, its #section kept, and refuses any other (#846)', () => {
    expect(
      launcherSettings({
        ...base,
        CCMS_LAUNCHER_BOOKING_URL: ' https://www.example.org/#demo ',
      }).bookingUrl?.href,
    ).toBe('https://www.example.org/#demo');
    for (const value of [
      'http://www.example.org/#demo',
      'javascript:alert(1)',
      'www.example.org',
      'https://user:pass@www.example.org/',
    ])
      expect(
        () => launcherSettings({ ...base, CCMS_LAUNCHER_BOOKING_URL: value }),
        value,
      ).toThrow(/CCMS_LAUNCHER_BOOKING_URL/);
  });

  it('refuses what would not hold, naming the setting', () => {
    expect(() =>
      launcherSettings({
        ...base,
        CCMS_LAUNCHER_PUBLIC_URL: 'http://demo.example.org',
      }),
    ).toThrow(/CCMS_LAUNCHER_PUBLIC_URL/);
    expect(() =>
      launcherSettings({
        ...base,
        CCMS_LAUNCHER_PUBLIC_URL: 'https://example.org/demo',
      }),
    ).toThrow(/path/);
    expect(() =>
      launcherSettings({ ...base, CCMS_LAUNCHER_AGENT_TOKEN: 'short' }),
    ).toThrow(/AGENT_TOKEN/);
    expect(() =>
      launcherSettings({ ...base, CCMS_LAUNCHER_MAX_SANDBOXES: '0' }),
    ).toThrow(/MAX_SANDBOXES/);
    expect(() =>
      launcherSettings({ ...base, CCMS_LAUNCHER_IDLE_MINUTES: '100' }),
    ).toThrow(/MAX_MINUTES/);
    expect(() =>
      launcherSettings({
        ...base,
        CCMS_LAUNCHER_ABUSE_CONTACT: 'javascript:alert(1)',
      }),
    ).toThrow(/ABUSE_CONTACT/);
    expect(
      launcherSettings({
        ...base,
        CCMS_LAUNCHER_PUBLIC_URL: 'http://localhost:8080',
      }).publicUrl.port,
    ).toBe('8080');
    expect(() =>
      launcherSettings({ ...base, CCMS_LAUNCHER_TRUST_PROXY: '1' }),
    ).toThrow(/PROXY_ADDRESSES/);
    expect(() =>
      launcherSettings({
        ...base,
        CCMS_LAUNCHER_TRUST_PROXY: '1',
        CCMS_LAUNCHER_PROXY_ADDRESSES: 'proxy.local',
      }),
    ).toThrow(/PROXY_ADDRESSES/);
    const trusted = launcherSettings({
      ...base,
      CCMS_LAUNCHER_TRUST_PROXY: '1',
      CCMS_LAUNCHER_PROXY_ADDRESSES: '10.9.9.0/24, 2001:db8::1',
    }).proxyAddresses!;
    expect(trusted.check('10.9.9.7', 'ipv4')).toBe(true);
    expect(trusted.check('10.9.10.7', 'ipv4')).toBe(false);
    expect(trusted.check('2001:db8::1', 'ipv6')).toBe(true);
  });

  it('gives the agent the sandbox limits and refuses an image it cannot name', () => {
    const agent = agentSettings({
      ...base,
      CCMS_LAUNCHER_SANDBOX_IMAGE: 'ghcr.io/example/openfolia/sandbox:v1.0.0',
      CCMS_LAUNCHER_CONTAINER: 'demo-launcher-1',
      CCMS_SANDBOX_RELEASES_PER_HOUR: '2',
    });
    expect(agent).toMatchObject({
      memory: '1g',
      cpus: 1,
      tmpfs: '256m',
      pids: 256,
      instance: 'demo',
    });
    expect(agent.sandboxEnv).toEqual({ CCMS_SANDBOX_RELEASES_PER_HOUR: '2' });
    expect(() =>
      agentSettings({
        ...base,
        CCMS_LAUNCHER_CONTAINER: 'x',
        CCMS_LAUNCHER_SANDBOX_IMAGE: 'a b',
      }),
    ).toThrow(/SANDBOX_IMAGE/);
  });
});

describe('the texts', () => {
  it('has every key in both languages, and uses every one', () => {
    expect(Object.keys(TEXTS.de).sort()).toEqual(Object.keys(TEXTS.en).sort());
    const sources = ['../src/page.ts', '../page/page.js']
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
      .join('\n');
    for (const key of Object.keys(TEXTS.en)) {
      const used =
        sources.includes(`'${key}'`) ||
        (key.startsWith('films.') && sources.includes('`films.${'));
      expect(used, key).toBe(true);
    }
    for (const lang of ['en', 'de'] as const)
      for (const [key, value] of Object.entries(TEXTS[lang]))
        expect(value.trim(), `${lang} ${key}`).not.toBe('');
  });
});
