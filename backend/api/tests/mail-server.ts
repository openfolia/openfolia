import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';

/** One message the test server took: its envelope, the raw MIME text, and whether it came over TLS. */
export interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
  readonly secure: boolean;
  readonly user: string | null;
}

/** A mail server in the test process (`smtp-server`), with a certificate for localhost made for it. */
export interface TestMailServer {
  readonly port: number;
  /** The PEM of its certificate, to trust (`CCMS_MAIL_CA_FILE`). */
  readonly caFile: string;
  readonly received: ReceivedMail[];
  /** Connections that issued a command after EHLO without TLS (what a plain session revealed). */
  readonly plainCommands: string[];
  close(): Promise<void>;
}

/**
 * Starts the server on 127.0.0.1. `starttls: false` offers and accepts no STARTTLS (a server
 * that would take everything in plain text). Signs in `user`/`pass` when given.
 */
export async function startMailServer(
  options: {
    starttls?: boolean;
    auth?: { user: string; pass: string };
  } = {},
): Promise<TestMailServer> {
  const dir = mkdtempSync(join(tmpdir(), 'openfolia-test-smtp-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
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
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const received: ReceivedMail[] = [];
  const plainCommands: string[] = [];
  const starttls = options.starttls ?? true;
  const serverOptions: SMTPServerOptions = {
    key: readFileSync(key),
    cert: readFileSync(cert),
    secure: false,
    logger: false,
    disabledCommands: [
      ...(starttls ? [] : ['STARTTLS']),
      ...(options.auth ? [] : ['AUTH']),
    ],
    authOptional: !options.auth,
    // Signing in over TLS only, as a real server does; the test checks it never happens in plain.
    allowInsecureAuth: false,
    onAuth(auth, _session, callback) {
      if (
        options.auth &&
        auth.username === options.auth.user &&
        auth.password === options.auth.pass
      ) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error('Invalid username or password'));
      }
    },
    onMailFrom(address, session, callback) {
      if (!session.secure) plainCommands.push(`MAIL FROM:${address.address}`);
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom
            ? session.envelope.mailFrom.address
            : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          secure: session.secure,
          user: typeof session.user === 'string' ? session.user : null,
        });
        callback();
      });
    },
  };
  const server = new SMTPServer(serverOptions);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    caFile: cert,
    received,
    plainCommands,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The MIME parts of a message: their headers and decoded bodies. */
export function parts(raw: string): { headers: string; body: string }[] {
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/g)].map(
    (m) => m[1]!,
  );
  let pieces = [raw];
  for (const boundary of boundaries) {
    pieces = pieces.flatMap((p) => p.split(`--${boundary}`));
  }
  return pieces
    .map((piece) => {
      const at = piece.search(/\r?\n\r?\n/);
      if (at < 0) return undefined;
      const headers = piece.slice(0, at);
      let body = piece.slice(at).trim();
      if (/Content-Transfer-Encoding: quoted-printable/i.test(headers)) {
        body = body
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
        body = Buffer.from(body, 'latin1').toString('utf8');
      } else if (/Content-Transfer-Encoding: base64/i.test(headers)) {
        body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString(
          /Content-Type: text/i.test(headers) ? 'utf8' : 'latin1',
        );
      }
      return { headers, body: body.replace(/\r\n/g, '\n') };
    })
    .filter((p): p is { headers: string; body: string } => p !== undefined);
}

/** A message's top-level headers, unfolded, by lowercase name (the first of each). */
export function headersOf(raw: string): Map<string, string> {
  const head = raw
    .slice(0, raw.search(/\r?\n\r?\n/))
    .replace(/\r?\n[ \t]+/g, ' ');
  const out = new Map<string, string>();
  for (const line of head.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!out.has(name)) out.set(name, decodeWords(line.slice(at + 1).trim()));
  }
  return out;
}

/** RFC 2047 encoded words (`=?UTF-8?Q?…?=`, `=?UTF-8?B?…?=`) as text. */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(
      /=\?UTF-8\?([QB])\?([^?]*)\?=/gi,
      (_, kind: string, data: string) =>
        kind.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64').toString('utf8')
          : Buffer.from(
              data
                .replace(/_/g, ' ')
                .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                ),
              'latin1',
            ).toString('utf8'),
    );
}
