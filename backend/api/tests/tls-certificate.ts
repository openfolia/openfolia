import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway self-signed certificate for `localhost` and 127.0.0.1, for a test's TLS server. */
export interface TestCertificate {
  readonly key: Buffer;
  readonly cert: Buffer;
  /** The certificate's file (PEM), for a setting that names one. */
  readonly certFile: string;
  readonly remove: () => void;
}

/**
 * Makes one with the `openssl` command (EC P-256, valid for a day), in a
 * folder of its own; `remove` deletes it. Never a key that lives longer
 * than the test or is committed.
 */
export function makeTestCertificate(): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), 'openfolia-test-tls-'));
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdio: 'ignore' },
  );
  return {
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    certFile,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
