import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { AuditLog } from '../audit-log.js';

/** What a read event names a request by (`audit-log`'s subject for reads). */
export const READ_SUBJECT_TYPE = 'route';

/**
 * A client's own name for itself (`X-OpenFolia-Client`, e.g. `mcp/search`):
 * letters, digits, `.`, `_`, `-` and `/`, at most 100. Anything else is
 * left out of the event, never stored as sent.
 */
export const READ_CLIENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** One request of a service account's token that changes nothing. */
export interface ReadRequest {
  readonly actor: Actor;
  /** The token's public ID (never the token). */
  readonly tokenId: string;
  /** The path asked for, without the query. */
  readonly path: string;
  /** The route it matched (`/modules/:lang/:id`), when one did. */
  readonly route?: string;
  /** The HTTP status answered. */
  readonly status: number;
  /** `?ref=`, as given. */
  readonly ref?: string;
  /** The commit read (`X-Ccms-Commit`), when the answer named one. */
  readonly commit?: string;
  /** `X-OpenFolia-Client`, as given. */
  readonly client?: string;
  /** Whether the client went away before the answer was complete. */
  readonly aborted?: boolean;
}

/**
 * `value` without control characters (Postgres stores no U+0000), cut to
 * `max` and well formed: a cut through a surrogate pair, or a lone one
 * sent, would fail the JSON insert (and with it the transaction).
 */
export function clip(value: string, max: number): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, max)
      .toWellFormed()
  );
}

/**
 * Reads of one account that could not be recorded one by one (too many
 * waiting, or their recording failed): how many, first and last.
 */
export interface ReadGap {
  readonly actor: Actor;
  readonly count: number;
  readonly from: Date;
  readonly to: Date;
}

/**
 * Records service accounts' reads (#877), in one transaction: one
 * `api.read` event (kind `read`) per request, naming the account (the
 * actor), the token's ID, the path (the subject, cut to 500 characters)
 * and the route it matched, the status, the ref and commit when there are
 * any, and the client's name for itself when it gives a well-formed one
 * (the MCP server sends `mcp/<tool>`: a claim of the client's, not
 * checked). Never the query beyond `ref`, a header's value otherwise, or
 * the body. And one `api.read-gap` event per gap: the account (actor and
 * subject), how many reads were not recorded, first and last. Runs for
 * nobody: the middleware calls it once answers are sent.
 */
@Injectable()
export class RecordReadAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly auditLog: AuditLog,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async handle(
    reads: readonly ReadRequest[],
    gaps: readonly ReadGap[] = [],
  ): Promise<void> {
    if (reads.length === 0 && gaps.length === 0) return;
    await this.unitOfWork.run(async (tx) => {
      for (const gap of gaps) {
        await this.auditLog.record(tx, gap.actor, {
          kind: 'read',
          action: 'api.read-gap',
          subject: { type: 'service-account', id: gap.actor.id },
          data: {
            count: gap.count,
            from: gap.from.toISOString(),
            to: gap.to.toISOString(),
          },
        });
      }
      for (const read of reads) {
        await this.auditLog.record(tx, read.actor, {
          kind: 'read',
          action: 'api.read',
          subject: { type: READ_SUBJECT_TYPE, id: clip(read.path, 500) || '/' },
          data: readData(read),
        });
      }
    });
  }
}

/** A read event's `data`: what the request names besides the path. */
function readData(
  read: ReadRequest,
): Record<string, string | number | boolean> {
  const ref = read.ref === undefined ? '' : clip(read.ref, 200);
  const client =
    read.client !== undefined && READ_CLIENT_PATTERN.test(read.client)
      ? read.client
      : undefined;
  const data: Record<string, string | number | boolean> = {
    tokenId: read.tokenId,
    status: read.status,
  };
  if (read.route) data['route'] = clip(read.route, 500);
  if (ref) data['ref'] = ref;
  if (read.commit) data['commit'] = clip(read.commit, 64);
  if (client) data['client'] = client;
  if (read.aborted) data['aborted'] = true;
  return data;
}
