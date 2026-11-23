import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension, ApiForbiddenResponse } from '@nestjs/swagger';
import { ErrorDocument } from '../../base/api/json-api.js';
import type { Permission } from '../core/permissions.js';

/** The OpenAPI extension naming the permission an operation needs. */
export const PERMISSION_EXTENSION = 'x-required-permission';

/** The route metadata holding the permission `ApiPermission` names. */
export const REQUIRED_PERMISSION = 'openfolia:required-permission';

/**
 * Documents the permission a route's action declares (its `policy`): the
 * 403 an actor without it gets, and the permission itself as
 * `x-required-permission`. `access.e2e.spec.ts` checks it against what the
 * route really does. Also kept as route metadata (`REQUIRED_PERMISSION`),
 * so a content route checks it before answering a 304 without running its
 * action (`SnapshotInterceptor`).
 */
export const ApiPermission = (permission: Permission) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSION, permission),
    ApiExtension(PERMISSION_EXTENSION, permission),
    ApiForbiddenResponse({
      description: `\`forbidden\`: the actor lacks the \`${permission}\` permission.`,
      standardSchema: ErrorDocument,
    }),
  );
