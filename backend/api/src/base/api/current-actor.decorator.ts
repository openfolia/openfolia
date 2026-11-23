import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Actor } from '../../access/core/actor.js';

declare global {
  // Express's own extension point for its `Request`.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Who is calling, set by the authentication guard once it has checked
       * the request's credentials; read it with `@CurrentActor()`.
       */
      actor?: Actor;
    }
  }
}

/**
 * The request's actor (`request.actor`). Fails closed: a request no guard
 * gave an actor is answered 401, never handled as nobody in particular.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const http = context.switchToHttp();
    const actor = http.getRequest<Request>().actor;
    if (!actor) {
      http.getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException(
        'The request has no authenticated actor.',
      );
    }
    return actor;
  },
);
