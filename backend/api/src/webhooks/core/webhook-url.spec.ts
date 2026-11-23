import { blockedAddress, checkWebhookUrl } from './webhook-url.js';
import {
  mintWebhookSecret,
  signatureHeader,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_SECRET_PATTERN,
} from './webhook-signature.js';

const STRICT = { allowHttp: false, allowPrivate: false };

describe('blockedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2001:db8::1',
    '2001::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    '100::1',
    '::127.0.0.1',
    '64:ff9b:1:7f00:0:100::',
    '64:ff9b:1::808:808',
    '::ffff:0:808:808',
    '3fff::1',
    '4000::1',
    'not an address',
    '',
  ])('blocks %s', (address) => {
    expect(blockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('lets %s through', (address) => {
    expect(blockedAddress(address)).toBe(false);
  });
});

describe('checkWebhookUrl', () => {
  it('takes an https URL, as parsed', () => {
    expect(
      checkWebhookUrl('https://Receiver.Example:8443/hooks?x=1', STRICT),
    ).toEqual({ url: 'https://receiver.example:8443/hooks?x=1' });
  });

  it.each([
    ['http://receiver.example/', 'scheme'],
    ['ftp://receiver.example/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['receiver.example/hook', 'not-a-url'],
    ['https://user:pass@receiver.example/', 'credentials'],
    ['https://user@receiver.example/', 'credentials'],
    ['https://receiver.example/#frag', 'fragment'],
    ['https://receiver.example/#', 'fragment'],
    [`https://receiver.example/${'a'.repeat(2_000)}`, 'too-long'],
    ['https://localhost/', 'blocked-address'],
    ['https://api.localhost/', 'blocked-address'],
    ['https://printer.local/', 'blocked-address'],
    ['https://metadata.google.internal/', 'blocked-address'],
    ['https://127.0.0.1/', 'blocked-address'],
    ['https://2130706433/', 'blocked-address'],
    ['https://0x7f.1/', 'blocked-address'],
    ['https://[::1]/', 'blocked-address'],
    ['https://[::ffff:169.254.169.254]/', 'blocked-address'],
    ['https://169.254.169.254/latest/meta-data/', 'blocked-address'],
    ['https://10.0.0.1/', 'blocked-address'],
  ])('refuses %s (%s)', (url, problem) => {
    expect(checkWebhookUrl(url, STRICT)).toEqual({ problem });
  });

  it('takes http and private addresses only where the rules allow them', () => {
    expect(
      checkWebhookUrl('http://127.0.0.1:9/hook', {
        allowHttp: true,
        allowPrivate: true,
      }),
    ).toEqual({ url: 'http://127.0.0.1:9/hook' });
    expect(
      checkWebhookUrl('http://127.0.0.1:9/hook', {
        allowHttp: true,
        allowPrivate: false,
      }),
    ).toEqual({ problem: 'blocked-address' });
    expect(
      checkWebhookUrl('http://receiver.example/', {
        allowHttp: false,
        allowPrivate: true,
      }),
    ).toEqual({ problem: 'scheme' });
  });
});

describe('signatures', () => {
  const secret = 'whsec_' + 'ab'.repeat(32);
  const body = '{"type":"module.released"}';

  it('mints 256-bit secrets in the recognisable format', () => {
    const a = mintWebhookSecret();
    expect(a).toMatch(WEBHOOK_SECRET_PATTERN);
    expect(mintWebhookSecret()).not.toBe(a);
  });

  it('signs `<timestamp>.<body>` with HMAC-SHA256, one v1 per secret', () => {
    const header = signatureHeader(
      [secret, 'whsec_other'],
      1_700_000_000,
      body,
    );
    expect(header).toBe(
      `t=1700000000,v1=${signWebhook(secret, 1_700_000_000, body)},v1=${signWebhook('whsec_other', 1_700_000_000, body)}`,
    );
    expect(signWebhook(secret, 1_700_000_000, body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies by the documented recipe, refusing a changed body, another secret or an old timestamp', () => {
    const now = 1_700_000_000_000;
    const header = signatureHeader([secret], now / 1000, body);
    expect(verifyWebhookSignature(header, body, secret, { now })).toBe(true);
    expect(verifyWebhookSignature(header, `${body} `, secret, { now })).toBe(
      false,
    );
    expect(
      verifyWebhookSignature(header, body, 'whsec_' + 'cd'.repeat(32), { now }),
    ).toBe(false);
    expect(
      verifyWebhookSignature(header, body, secret, { now: now + 301_000 }),
    ).toBe(false);
    expect(verifyWebhookSignature('v1=00', body, secret, { now })).toBe(false);
    // During a rotation either secret verifies.
    const both = signatureHeader([secret, 'whsec_new'], now / 1000, body);
    expect(verifyWebhookSignature(both, body, 'whsec_new', { now })).toBe(true);
  });
});
