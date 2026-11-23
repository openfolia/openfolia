import {
  applyDecorators,
  createParamDecorator,
  HttpStatus,
  Injectable,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import type { Actor } from '../../access/core/actor.js';
import { AcceptsQuery } from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ReadsLive } from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { OpenWorkingCopiesAction } from '../core/actions/open-working-copies.action.js';
import { isChangeSetId } from '../core/change-set.js';

/** What a request reading working copies read them from. */
export interface WorkingCopyRead {
  readonly changeSetId: string;
  /** The images uploaded into the change set (SHA-256, hex). */
  readonly uploaded: ReadonlySet<string>;
}

type LiveRequest = Request & {
  snapshot?: ReadableContent;
  workingCopies?: WorkingCopyRead;
};

const PARAMETER = 'workingCopy';
const BRANCH = /^change-sets\/(.+)$/;

/**
 * `?workingCopy=` given as anything but `false`: never an ETag or a 304 for it (`true` reads the
 * working copies; any other value is answered 400 by `WorkingCopyInterceptor`).
 */
const asksLive = (req: Request): boolean =>
  req.query[PARAMETER] !== undefined && req.query[PARAMETER] !== 'false';

const invalid = (detail: string) =>
  new JsonApiException(HttpStatus.BAD_REQUEST, [
    { code: 'invalid-parameter', detail, source: { parameter: PARAMETER } },
  ]);

/**
 * `?workingCopy=true` (#237): reads the change set's working copies in
 * place of their files, for its author's live preview. Runs after
 * `@ReadsContent()` has opened `?ref=`, which must name the change set's
 * branch (`change-sets/<id>`); `OpenWorkingCopiesAction` decides who may
 * (its author: 403 for another reader of drafts, 404 for anyone else) and
 * replaces the request's content with the overlaid one.
 */
@Injectable()
export class WorkingCopyInterceptor implements NestInterceptor {
  constructor(private readonly open: OpenWorkingCopiesAction) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<LiveRequest>();
    const asked = req.query[PARAMETER];
    if (asked === undefined || asked === 'false') return next.handle();
    if (asked !== 'true') {
      throw invalid('Give workingCopy once, as true or false.');
    }
    const ref = req.query['ref'];
    const id = typeof ref === 'string' ? BRANCH.exec(ref)?.[1] : undefined;
    if (id === undefined || !isChangeSetId(id)) {
      throw invalid(
        'workingCopy=true reads a change set’s working copies: give its branch as ref (change-sets/<id>).',
      );
    }
    const snapshot = req.snapshot;
    if (!snapshot) throw new Error('route is missing @ReadsContent()');
    const opened = await this.open.handle({
      // Set by `ActorGuard`, which runs before any interceptor.
      actor: req.actor as Actor,
      snapshot,
      changeSetId: id,
    });
    req.snapshot = opened.content;
    req.workingCopies = { changeSetId: id, uploaded: opened.uploaded };
    return next.handle();
  }
}

/**
 * For a content route that can read a change set's working copies
 * (`?workingCopy=true`): place it after `@ReadsContent()`. Such a read is
 * `private, no-cache`, without the commit's ETag (`ReadsLive`).
 */
export const ReadsWorkingCopies = () =>
  applyDecorators(
    ReadsLive(asksLive),
    UseInterceptors(WorkingCopyInterceptor),
    AcceptsQuery(PARAMETER),
    ApiQuery({
      name: PARAMETER,
      required: false,
      description:
        'For authors (left out of the delivery document): true reads the change set’s working copies (what its editor autosaved, not committed yet) in place of their files, modules and manuals alike; module references resolve to their own working copies where there are any; an image uploaded into the change set links to `GET /change-sets/{changeSetId}/assets/{hash}` in an HTML page, and the PDF shows it. Needs `ref` to name the change set’s branch (`change-sets/<id>`; else 400 `invalid-parameter`) and only for its author: 403 for anyone else who may read drafts, 404 for anyone who may not. `private, no-cache`, without the commit’s ETag. Default: false.',
      schema: { type: 'string', enum: ['true', 'false'], default: 'false' },
    }),
  );

/** The working copies this request reads (`?workingCopy=true`), or undefined: the files only. */
export const CurrentWorkingCopies = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WorkingCopyRead | undefined =>
    context.switchToHttp().getRequest<LiveRequest>().workingCopies,
);
