import { AesSecretSealer } from './aes-secret-sealer.js';

describe('AesSecretSealer', () => {
  const key = Buffer.alloc(32, 7);

  it('seals so only the same key and context open it, never the same text twice', () => {
    const box = new AesSecretSealer(key);
    const a = box.seal('whsec_secret', 'webhook-secret:v1:w1');
    expect(a).not.toContain('whsec');
    expect(box.seal('whsec_secret', 'webhook-secret:v1:w1')).not.toBe(a);
    expect(box.open(a, 'webhook-secret:v1:w1')).toBe('whsec_secret');
    // Copied onto another row, or read for another purpose: it does not open.
    expect(() => box.open(a, 'webhook-secret:v1:w2')).toThrow();
    expect(() => box.open(a, 'header-secret:v1:w1')).toThrow();
    expect(() =>
      new AesSecretSealer(Buffer.alloc(32, 8)).open(a, 'webhook-secret:v1:w1'),
    ).toThrow();
    const [v, iv, data, tag] = a.split('.');
    const flipped = `${v}.${iv}.${data!.slice(0, -2)}AA.${tag}`;
    expect(() => box.open(flipped, 'webhook-secret:v1:w1')).toThrow();
    expect(() => box.open('not sealed', 'webhook-secret:v1:w1')).toThrow(
      'Not a sealed secret.',
    );
  });

  it('opens a webhook secret sealed before the instance key (#470)', () => {
    // Sealed under the old CCMS_WEBHOOKS_SECRET_KEY scheme: key 00…00, subscriber w1.
    const old = 'v1.BwcHBwcHBwcHBwcH.CqDbrgt5dEeUww.1L0dnlyda10zn5kpLmjZXA';
    expect(
      new AesSecretSealer(Buffer.alloc(32)).open(old, 'webhook-secret:v1:w1'),
    ).toBe('whsec_test');
  });

  it('never names the secret or the key when a value does not open', () => {
    const sealed = new AesSecretSealer(key).seal('whsec_secret', 'c');
    let message = '';
    try {
      new AesSecretSealer(Buffer.alloc(32, 9)).open(sealed, 'c');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('The sealed secret does not open with this key.');
  });

  it('refuses a key of the wrong size', () => {
    expect(() => new AesSecretSealer(Buffer.alloc(16))).toThrow();
  });
});
