import type { Request } from 'express';
import { addressKey, clientAddress } from './client-address.js';

describe('addressKey (#574)', () => {
  it('keys an IPv4 address as it is, a mapped one unwrapped', () => {
    for (const prefix of [56, 64] as const) {
      expect(addressKey('203.0.113.7', prefix)).toBe('203.0.113.7');
      expect(addressKey('::ffff:203.0.113.7', prefix)).toBe('203.0.113.7');
      expect(addressKey('::FFFF:127.0.0.1', prefix)).toBe('127.0.0.1');
      expect(addressKey('::ffff:7f00:1', prefix)).toBe('127.0.0.1');
      expect(addressKey('0:0:0:0:0:ffff:cb00:7107', prefix)).toBe(
        '203.0.113.7',
      );
    }
  });

  it('keys an IPv6 address that embeds an IPv4 one by that IPv4 address', () => {
    for (const prefix of [56, 64] as const) {
      // NAT64
      expect(addressKey('64:ff9b::192.0.2.1', prefix)).toBe('192.0.2.1');
      expect(addressKey('64:ff9b::c000:201', prefix)).toBe('192.0.2.1');
      // 6to4: the host's address in bits 16 to 48, whatever follows.
      expect(addressKey('2002:c000:201::1', prefix)).toBe('192.0.2.1');
      expect(addressKey('2002:c000:201:ff:1:2:3:4', prefix)).toBe('192.0.2.1');
      // Teredo: the client's address inverted in the last 32 bits.
      expect(addressKey('2001:0:4136:e378:8000:63bf:3fff:fdd2', prefix)).toBe(
        '192.0.2.45',
      );
    }
  });

  it('keys an IPv6 address by its /56 for the anonymous reads, however it is written', () => {
    const key = '2001:db8:1:0::/56';
    expect(addressKey('2001:db8:1:2::1', 56)).toBe(key);
    expect(addressKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff', 56)).toBe(key);
    expect(addressKey('2001:DB8:1:2:0:0:0:9', 56)).toBe(key);
    expect(addressKey('2001:db8:1:2::1%eth0', 56)).toBe(key);
    expect(addressKey('2001:db8:1:ff::1', 56)).toBe(key);
    expect(addressKey('2001:db8:1:100::1', 56)).toBe('2001:db8:1:100::/56');
    expect(addressKey('::1', 56)).toBe('0:0:0:0::/56');
    expect(addressKey('1:2:3:4:5:6:192.0.2.1', 56)).toBe('1:2:3:0::/56');
  });

  it('keys an IPv6 address by its /64 for failed authentications: never a neighbour’s', () => {
    expect(addressKey('2001:db8:1:2::1', 64)).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2:ffff::9', 64)).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:3::1', 64)).toBe('2001:db8:1:3::/64');
    expect(addressKey('1:2:3:4:5:6:192.0.2.1', 64)).toBe('1:2:3:4::/64');
  });

  it('keeps anything else as it is', () => {
    expect(addressKey('unknown', 64)).toBe('unknown');
    expect(addressKey('', 56)).toBe('');
  });
});

describe('clientAddress (#574)', () => {
  it('is the address Express names, else the socket’s, by its key', () => {
    const request = (fields: Record<string, unknown>) =>
      ({
        socket: { remoteAddress: '2001:db8::1' },
        ...fields,
      }) as unknown as Request;
    expect(clientAddress(request({ ip: '::ffff:203.0.113.7' }), 64)).toBe(
      '203.0.113.7',
    );
    expect(clientAddress(request({}), 56)).toBe('2001:db8:0:0::/56');
    expect(clientAddress(request({}), 64)).toBe('2001:db8:0:0::/64');
  });
});
