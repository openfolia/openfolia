import { hostname as osHostname } from 'node:os';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import type { AuditEvent } from '../core/audit-event.js';
import { auditEventJson, oneLineJson } from '../core/audit-export.js';
import {
  AuditSink,
  SINK_APP_NAME,
  type SinkResult,
} from '../core/audit-sink.js';

/** The syslog port for TLS (RFC 5425). */
export const SYSLOG_TLS_PORT = 6514;

/** facility 13 (log audit) × 8 + severity 6 (informational), RFC 5424. */
const PRIORITY = 13 * 8 + 6;

/** How long a delivered batch's connection waits for the collector to close it. */
const CLOSE_WAIT_MS = 5_000;

/** UTF-8's byte order mark: RFC 5424 starts a UTF-8 MSG with it. */
const BOM = '\uFEFF';

/** What the syslog sink needs (`CCMS_AUDIT_SINK_*`). */
export interface SyslogSinkOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  /** Certificates to trust instead of the system's (PEM), for a private CA. */
  readonly ca?: Buffer;
  /** This machine's name as the messages give it (default: the OS's). */
  readonly hostname?: string;
}

/**
 * An RFC 5424 header field: printable US-ASCII without spaces, at most
 * `max` characters, or the nil value `-` when nothing is left.
 */
export function headerField(value: string, max: number): string {
  const kept = value.replace(/[^\x21-\x7e]/g, '').slice(0, max);
  return kept === '' ? '-' : kept;
}

/**
 * One event as an RFC 5424 message: `<110>1 <at> <host> openfolia <pid>
 * <action> - <BOM><event as JSON>` (facility log audit, severity
 * informational; MSGID the action, cut to 32 characters; MSG the event as
 * the JSON export writes it, on one line), then framed for TLS as
 * RFC 5425 says: its length in octets, a space, the message.
 */
export function syslogFrame(
  event: AuditEvent,
  host: string,
  pid: number,
): Buffer {
  const message = Buffer.from(
    [
      `<${PRIORITY}>1`,
      event.at.toISOString(),
      headerField(host, 255),
      headerField(SINK_APP_NAME, 48),
      headerField(String(pid), 128),
      headerField(event.action, 32),
      '-',
      `${BOM}${oneLineJson(auditEventJson(event))}`,
    ].join(' '),
    'utf8',
  );
  return Buffer.concat([Buffer.from(`${message.length} `, 'ascii'), message]);
}

/**
 * The sink over syslog on TLS (RFC 5425): each batch opens one TLS
 * connection (the server's certificate checked against the host, and
 * against `ca` when given), writes one frame per event in order
 * (`syslogFrame`) and ends it. A batch counts as delivered once every
 * frame is written and flushed to the connection: syslog has no
 * acknowledgement, so an event the collector drops after
 * that is not sent again. Any error, or `timeoutMs` passing, fails the
 * batch, which then goes again.
 */
export class SyslogAuditSink extends AuditSink {
  private readonly host: string;

  constructor(private readonly options: SyslogSinkOptions) {
    super();
    this.host = options.hostname ?? osHostname();
  }

  send(events: readonly AuditEvent[]): Promise<SinkResult> {
    const { host, port, timeoutMs, ca } = this.options;
    const frames = Buffer.concat(
      events.map((e) => syslogFrame(e, this.host, process.pid)),
    );
    return new Promise<SinkResult>((resolve) => {
      let settled = false;
      const done = (result: SinkResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok) socket.destroy();
        resolve(result);
      };
      const socket = connect({
        host,
        port,
        servername: isIP(host) === 0 ? host : undefined,
        rejectUnauthorized: true,
        ...(ca && { ca }),
      });
      const timer = setTimeout(
        () => done({ ok: false, error: 'timeout' }),
        timeoutMs,
      );
      socket.on('error', () => done({ ok: false, error: 'connection' }));
      // Anything the collector sends back is not read.
      socket.on('data', () => undefined);
      socket.once('secureConnect', () => {
        socket.end(frames, (error?: Error | null) => {
          // Called with the error when the connection broke before every frame was flushed.
          if (error) {
            done({ ok: false, error: 'connection' });
            return;
          }
          done({ ok: true });
          // The collector closes its side; one that does not is cut off.
          // Not at once: closing with its bytes unread could reset the
          // connection before it read ours.
          const linger = setTimeout(() => socket.destroy(), CLOSE_WAIT_MS);
          linger.unref();
          socket.once('close', () => clearTimeout(linger));
        });
      });
    });
  }
}
