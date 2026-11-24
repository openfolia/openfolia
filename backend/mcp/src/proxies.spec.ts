import { PROXY_LOOKUP_MS, ProxyAddresses } from './proxies.js';

describe('ProxyAddresses', () => {
  it('holds fixed addresses and subnets, IPv4 in its dual-stack form too', () => {
    const p = new ProxyAddresses(['10.0.0.2', '172.18.0.0/16', 'fd00::/16']);
    expect(p.has('10.0.0.2')).toBe(true);
    expect(p.has('::ffff:10.0.0.2')).toBe(true);
    expect(p.has('172.18.9.9')).toBe(true);
    expect(p.has('fd00::1')).toBe(true);
    expect(p.has('10.0.0.3')).toBe(false);
    expect(p.has('unknown')).toBe(false);
  });

  it('looks names up, again when due, and trusts nothing a failed lookup did not find', async () => {
    let now = 0;
    let answer: string[] | Error = new Error('ENOTFOUND');
    const resolve = (name: string) =>
      answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(name === 'editor' ? answer : []);
    const p = new ProxyAddresses(['editor'], resolve, () => now);
    await p.refresh();
    expect(p.has('172.18.0.4')).toBe(false);
    answer = ['172.18.0.4'];
    // Not due yet: the failed lookup stands.
    expect(p.has('172.18.0.4')).toBe(false);
    now = PROXY_LOOKUP_MS;
    p.has('172.18.0.4'); // starts the lookup
    await p.refresh();
    expect(p.has('172.18.0.4')).toBe(true);
    // The editor recreated with a new address: the old one is no proxy any more.
    answer = ['172.18.0.7'];
    now = 2 * PROXY_LOOKUP_MS;
    p.has('172.18.0.7');
    await p.refresh();
    expect(p.has('172.18.0.4')).toBe(false);
    expect(p.has('172.18.0.7')).toBe(true);
  });
});
