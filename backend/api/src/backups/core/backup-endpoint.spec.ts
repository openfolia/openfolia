import { addressAllowed, endpointProblem } from './backup-endpoint.js';

describe('the S3 endpoint check', () => {
  it('takes an http or https server by name, a public address, or a private one (checked again on connecting)', () => {
    for (const ok of [
      'https://s3.example.com',
      'http://minio:9000',
      'http://127.0.0.1:8333',
      'http://10.0.0.5:9000',
      'https://[2001:4860:4860::8888]',
    ]) {
      expect([ok, endpointProblem(ok)]).toEqual([ok, undefined]);
    }
  });

  it('refuses credentials, a query, other schemes and link-local or metadata addresses', () => {
    for (const bad of [
      'https://key:secret@s3.example.com',
      'https://s3.example.com/?x=1',
      'ftp://s3.example.com',
      'http://169.254.169.254',
      'http://[fd00:ec2::254]',
      'http://[fe80::1]',
      'http://metadata.google.internal',
      'not a url',
    ]) {
      expect([bad, endpointProblem(bad)]).not.toEqual([bad, undefined]);
    }
  });

  it('refuses every spelling of a link-local or metadata address: mapped, NAT64, 6to4, long form, trailing dot, decimal', () => {
    for (const bad of [
      'http://[::ffff:a9fe:a9fe]',
      'http://[::ffff:169.254.169.254]',
      'http://[0:0:0:0:0:ffff:a9fe:a9fe]',
      'http://[64:ff9b::a9fe:a9fe]',
      'http://[64:ff9b::169.254.169.254]',
      'http://[2002:a9fe:a9fe::1]',
      'http://[FE80::1]',
      'http://[fe80:0:0:0:0:0:0:1]',
      'http://[fd00:ec2:0:0:0:0:0:254]',
      'http://169.254.169.254.',
      'http://2852039166',
      'http://0xa9fea9fe',
      'http://0251.0376.0251.0376',
      'http://metadata.google.internal.',
      'http://[::]',
      'http://0.0.0.0',
      'http://[::a9fe:a9fe]',
      'http://[::169.254.169.254]',
      'http://[64:ff9b:1:a9fe:a9fe::]',
    ]) {
      expect([bad, endpointProblem(bad)]).not.toEqual([bad, undefined]);
    }
  });

  it('answers an address with a zone (as a resolver may give one) without throwing', () => {
    expect(addressAllowed('fd00::1%en0', false)).toBe(false);
    expect(addressAllowed('fd00::1%en0', true)).toBe(true);
    expect(addressAllowed('fe80::1%en0', true)).toBe(false);
  });
});
