import { createServer, get as httpGet } from 'node:http';
import { S3BackupTarget } from './backup-targets.js';
import type { LookupAddress } from 'node:dns';
import {
  guardedAgents,
  guardedLookup,
  type ResolveAll,
} from './guarded-lookup.js';

/** A resolver that answers `answers` for any name: a rebinding name server, say. */
const answering =
  (...answers: LookupAddress[]): ResolveAll =>
  async () =>
    answers;

function lookUp(
  resolve: ResolveAll,
  allowPrivate: boolean,
  all = false,
): Promise<unknown> {
  const lookup = guardedLookup({ allowPrivate, resolve });
  return new Promise((done, fail) => {
    lookup('s3.example.com', { all }, (error, address, family) =>
      error ? fail(error) : done(all ? address : { address, family }),
    );
  });
}

describe('the S3 connection guard', () => {
  it('connects to a public address the name resolves to', async () => {
    await expect(
      lookUp(answering({ address: '203.0.114.7', family: 4 }), false),
    ).resolves.toEqual({ address: '203.0.114.7', family: 4 });
  });

  it('refuses a name that resolves (or rebinds) to a metadata or link-local address, whatever the setting', async () => {
    for (const allowPrivate of [false, true]) {
      for (const address of [
        { address: '169.254.169.254', family: 4 },
        { address: '::ffff:a9fe:a9fe', family: 6 },
        { address: '64:ff9b::a9fe:a9fe', family: 6 },
        { address: 'fd00:ec2::254', family: 6 },
        { address: 'fe80::1', family: 6 },
      ]) {
        await expect(
          lookUp(
            answering({ address: '203.0.114.7', family: 4 }, address),
            allowPrivate,
            true,
          ),
        ).rejects.toThrow(/never reach/);
      }
    }
  });

  it('refuses a private or loopback address unless the private network is allowed', async () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '::1', 'fd12::1']) {
      const family = address.includes(':') ? 6 : 4;
      await expect(
        lookUp(answering({ address, family }), false),
      ).rejects.toThrow(/CCMS_BACKUP_S3_ALLOW_PRIVATE/);
      await expect(
        lookUp(answering({ address, family }), true),
      ).resolves.toEqual({ address, family });
    }
  });
});

describe('the S3 connections, to an IP literal (no lookup happens)', () => {
  it('refuses a literal endpoint backups may not reach when the target is made: "Test location" and a run both fail', () => {
    const at = (endpoint: string, allowPrivate = false) =>
      new S3BackupTarget(
        {
          kind: 's3',
          endpoint,
          region: 'us-east-1',
          bucket: 'backups',
          prefix: '',
          accessKeyId: 'writer',
        },
        'secret',
        { allowPrivate },
      );
    for (const endpoint of [
      'http://169.254.169.254',
      'http://[::ffff:a9fe:a9fe]',
      'http://[64:ff9b::a9fe:a9fe]',
      'http://10.0.0.5:9000',
      'http://127.0.0.1:9000',
      'http://[::1]:9000',
      'http://[::ffff:127.0.0.1]:9000',
    ]) {
      expect(() => at(endpoint), endpoint).toThrow();
    }
    // A private one with the setting; never a link-local one.
    expect(() => at('http://10.0.0.5:9000', true)).not.toThrow();
    expect(() => at('http://[::ffff:a9fe:a9fe]', true)).toThrow();
  });

  it('checks the address each socket connected to: a literal that skips the lookup is refused before a byte is sent (http)', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.end('ok');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const get = (allowPrivate: boolean) =>
      new Promise<string>((done, fail) => {
        const { httpAgent } = guardedAgents({ allowPrivate });
        httpGet(`http://127.0.0.1:${port}/`, { agent: httpAgent }, (res) => {
          res.resume();
          res.on('end', () => done(String(res.statusCode)));
        }).on('error', fail);
      });
    try {
      await expect(get(false)).rejects.toThrow(/CCMS_BACKUP_S3_ALLOW_PRIVATE/);
      expect(requests).toBe(0);
      await expect(get(true)).resolves.toBe('200');
      expect(requests).toBe(1);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe('the S3 connections over https, to an IP literal', () => {
  it('refuses the socket before the TLS handshake writes anything', async () => {
    const { createServer: createTcpServer } = await import('node:net');
    const { request } = await import('node:https');
    let received = 0;
    const server = createTcpServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length;
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    try {
      const { httpsAgent } = guardedAgents({ allowPrivate: false });
      await expect(
        new Promise((done, fail) => {
          request(`https://127.0.0.1:${port}/`, { agent: httpsAgent }, done)
            .on('error', fail)
            .end();
        }),
      ).rejects.toThrow(/CCMS_BACKUP_S3_ALLOW_PRIVATE/);
      await new Promise((done) => setTimeout(done, 100));
      expect(received).toBe(0);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
