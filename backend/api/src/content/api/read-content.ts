import { createHash } from 'node:crypto';
import {
  applyDecorators,
  createParamDecorator,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiNotFoundResponse,
  ApiNotModifiedResponse,
  ApiQuery,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { REQUIRED_PERMISSION } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import type { Permission } from '../../access/core/permissions.js';
import { authorize } from '../../access/core/policy.js';
import { AcceptsQuery } from '../../base/api/json-api.decorators.js';
import {
  JsonApiException,
  NotModified,
} from '../../base/api/json-api.exception.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import type { Env } from '../../config/env.js';
import { OpenSnapshotAction } from '../core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../core/readable-content.js';
import { ReadableRefs } from '../core/readable-refs.js';

const BEYOND_THE_COMMIT = 'openfolia:beyond-the-commit';

/**
 * For a content route whose answer depends on more than the commit read
 * and the reader's scope (a module's status: release tags, `main`, open
 * change sets, whose they are): never `immutable`, and the ETag is a hash
 * of the answer itself, checked after it is made, so a 304 never stands
 * for an answer that has changed since.
 */
export const BeyondTheCommit = () => SetMetadata(BEYOND_THE_COMMIT, true);

const LIVE_READS = 'openfolia:live-reads';

/**
 * For a content route that can read drafts beyond the commit (a change
 * set's working copies, `?workingCopy=true`, #237): such a read is never
 * cached, has no ETag and is never answered 304, since the drafts change
 * between two reads of the same commit. `live` tells such a request apart.
 */
export const ReadsLive = (live: (req: Request) => boolean) =>
  SetMetadata(LIVE_READS, live);

/** Set (to `true`) on a read at the tag of a withdrawn release (#330). */
// Compatibility: keeps the working name from before the product was named OpenFolia (`X-Ccms-*`: the API's contract).
export const WITHDRAWN_HEADER = 'X-Ccms-Withdrawn';

/** Changes on every start, so clients revalidate after a deploy (the renderer may have changed). */
const SERVER_EPOCH = Date.now().toString(36);

type SnapshotRequest = Request & { snapshot?: ReadableContent };

/**
 * Opens the repository at `?ref=` (a branch, tag or commit ID) for the
 * request's actor (`OpenSnapshotAction`, which checks it may read) and reports
 * the commit in `X-Ccms-Commit`. Responses for a commit ID never change,
 * so they are marked immutable; others revalidate with `ETag`. The ETag
 * includes what the actor may see (`readingKey`), so a reader never gets a
 * 304 for a response made for another scope; responses vary by the headers
 * that pick the actor. Before a 304 it checks the permission the route
 * documents (`@ApiPermission`), which the route's action would check: the
 * ETag holds no route, so one from another route can match. A read at
 * the tag of a withdrawn release says so in `X-Ccms-Withdrawn: true` (#330;
 * it keeps working), and its ETag changes with the withdrawal, so a
 * client's cached answer from before is not confirmed by a 304.
 */
@Injectable()
export class SnapshotInterceptor implements NestInterceptor {
  private readonly defaultRef: string;

  constructor(
    private readonly openSnapshot: OpenSnapshotAction,
    config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
    private readonly refs: ReadableRefs,
  ) {
    this.defaultRef = config.get('CCMS_DEFAULT_REF', { infer: true });
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<SnapshotRequest>();
    const res = http.getResponse<Response>();
    const requested = req.query['ref'];
    if (requested !== undefined && typeof requested !== 'string') {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'invalid-parameter',
          detail: 'Give ref at most once.',
          source: { parameter: 'ref' },
        },
      ]);
    }
    const ref = requested ?? this.defaultRef;
    const snapshot = await this.openSnapshot.handle({
      // Set by `ActorGuard`, which runs before any interceptor. Without one
      // (a public route) the action refuses.
      actor: req.actor as Actor,
      ref,
    });
    res.setHeader('X-Ccms-Commit', snapshot.commit);
    // Only once the actor may read at `ref`: its answer tells nothing new.
    const withdrawn = (await this.refs.withdrawalAt(ref)) !== undefined;
    if (withdrawn) res.setHeader(WITHDRAWN_HEADER, 'true');
    res.vary('Authorization');
    res.vary('X-Ccms-User');
    req.snapshot = snapshot;
    const live = this.reflector.get<((req: Request) => boolean) | undefined>(
      LIVE_READS,
      context.getHandler(),
    );
    if (live?.(req)) {
      res.setHeader('Cache-Control', 'private, no-cache');
      return next.handle();
    }
    if (
      this.reflector.get<boolean | undefined>(
        BEYOND_THE_COMMIT,
        context.getHandler(),
      )
    ) {
      res.setHeader('Cache-Control', 'private, no-cache');
      return next.handle().pipe(
        map((body: unknown) => {
          const hash = createHash('sha256')
            .update(JSON.stringify(body))
            .update(withdrawn ? '.withdrawn' : '')
            .digest('base64url');
          const etag = `"${hash}.${SERVER_EPOCH}"`;
          res.setHeader('ETag', etag);
          if (req.headers['if-none-match'] === etag) {
            throw new NotModified(etag);
          }
          return body;
        }),
      );
    }
    const etag = `"${snapshot.commit}.${SERVER_EPOCH}.${snapshot.readingKey}${withdrawn ? '.withdrawn' : ''}"`;
    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      ref === snapshot.commit
        ? 'private, max-age=31536000, immutable'
        : 'private, no-cache',
    );
    if (req.headers['if-none-match'] === etag) {
      // A 304 here answers without running the route's action, so without
      // its policy: check the permission the route needs first, so an
      // actor without it gets 403 as without the ETag, not a 304 for an
      // ETag it got from another route.
      const permission = this.reflector.getAllAndOverride<
        Permission | undefined
      >(REQUIRED_PERMISSION, [context.getHandler(), context.getClass()]);
      if (permission) authorize(req.actor, permission);
      throw new NotModified(etag);
    }
    return next.handle();
  }
}

/** The content opened by `@ReadsContent()` for this request, as its actor may read it. */
export const CurrentSnapshot = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ReadableContent => {
    const snapshot = context
      .switchToHttp()
      .getRequest<SnapshotRequest>().snapshot;
    if (!snapshot) throw new Error('route is missing @ReadsContent()');
    return snapshot;
  },
);

/** Response headers every content route sends; for OpenAPI. */
export const CONTENT_HEADERS = {
  'X-Ccms-Commit': {
    description: 'The commit the response was read from.',
    schema: { type: 'string' },
  },
  [WITHDRAWN_HEADER]: {
    description:
      '`true` when `?ref=` names the tag of a withdrawn release (as `refs/tags/<tag>`, or `<tag>` when no branch has that name): the read still works, but the release was taken back. Who, when and why: `meta.withdrawal` of the tag in `GET /refs`, or `attributes.withdrawal` of the release in `GET /releases`. Absent otherwise.',
    schema: { type: 'string' },
  },
  ETag: {
    description:
      'Changes with the commit, with what the reader may see and when the release whose tag is read is withdrawn.',
    schema: { type: 'string' },
  },
  'Cache-Control': {
    description:
      '`immutable` when `?ref=` was a commit ID, except on routes whose answer also depends on refs (a module’s status): `no-cache` there.',
    schema: { type: 'string' },
  },
} as const;

/**
 * For routes that read content: resolves `?ref=` and documents it, along
 * with the 304, 404 and 422 answers every content route can give.
 */
export const ReadsContent = () =>
  applyDecorators(
    UseInterceptors(SnapshotInterceptor),
    AcceptsQuery('ref'),
    ApiQuery({
      name: 'ref',
      required: false,
      description:
        "Branch, tag or commit ID to read from. Default: the server's `CCMS_DEFAULT_REF`.",
      schema: { type: 'string' },
    }),
    ApiNotModifiedResponse({
      description: 'The `If-None-Match` ETag is still current.',
    }),
    ApiNotFoundResponse({
      description:
        '`not-found`: unknown ref, or no such item at that ref. `change-set-branch-missing`: `ref` is the branch of a change set the reader may see, and that branch is gone from the content repository (`meta.branch`; the change set says so in `meta.branchMissing`).',
      standardSchema: ErrorDocument,
    }),
    ApiUnprocessableEntityResponse({
      description: `\`invalid-content\`: a file needed for the answer is broken; the error's \`meta.path\` names it. ${TABLE_TOO_LARGE_FILE}`,
      standardSchema: ErrorDocument,
    }),
  );

/** How a route reading content documents 422 `table-too-large` for a file in Git (#686). */
export const TABLE_TOO_LARGE_FILE =
  '`table-too-large`: a module file holds a table of more than 1,000 columns or 50,000 cells (rows × columns), or tables of more than 1,000,000 cells together, so it is not read (`meta.path`; `meta.columns`, `meta.cells`, `meta.totalCells`: the caps).';
