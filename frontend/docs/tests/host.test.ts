import { describe, expect, it } from 'vitest';
import { hostOf, isHost } from '../lib/host';

describe('isHost', () => {
  it.each([
    'your-team.openfolia.com',
    'openfolia.example.com:8443',
    'localhost',
    '127.0.0.1:3000',
    '[::1]:8443',
  ])('takes %s', (host) => expect(isHost(host)).toBe(true));

  it.each([
    '',
    'https://acme.example.com',
    'acme.example.com/api',
    'user@acme.example.com',
    'acme.example.com?x=1',
    'acme .example.com',
    '-acme.example.com',
    '<team>.openfolia.com',
    'acme.example.com:99999',
  ])('refuses %j', (host) => expect(isHost(host)).toBe(false));
});

describe('hostOf', () => {
  it.each([
    ['acme.example.org', 'acme.example.org'],
    [' https://acme.example.org/api/ ', 'acme.example.org'],
    ['http://localhost:4200/', 'localhost:4200'],
    ['https://acme.example.org/api/docs', 'acme.example.org'],
  ])('takes %j as %s', (typed, host) => expect(hostOf(typed)).toBe(host));

  it.each(['', 'acme example', 'https://acme.example.org/admin', 'ftp://acme'])(
    'finds no host in %j',
    (typed) => expect(hostOf(typed)).toBeNull(),
  );
});
