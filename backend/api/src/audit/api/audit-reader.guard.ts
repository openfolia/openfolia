import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { authorize } from '../../access/core/policy.js';
import { READ_AUDIT_LOG } from '../core/actions/list-audit-events.action.js';

/**
 * Checks the permission that reads the audit log before the export's
 * parameters are validated (guards run before pipes), so an actor without
 * it is 403 whatever it asks, as on every guarded route. The action checks
 * it again (`ActorAction`). A request without an actor is left to
 * `@CurrentActor()`, which answers 401.
 */
@Injectable()
export class AuditReaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { actor } = context.switchToHttp().getRequest<Request>();
    if (actor) authorize(actor, READ_AUDIT_LOG);
    return true;
  }
}
