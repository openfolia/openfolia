import { ConfigKey } from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import { TransitionComment } from '../../change-sets/core/change-set.js';
import type { MaintenanceLineView } from '../core/actions/maintenance-lines.action.js';
import { MAINTENANCE_LINE_STATES, stateOf } from '../core/maintenance-line.js';

const Who = z.object({ kind: z.enum(['user', 'service']), id: z.string() });

export const MaintenanceLineAttributes = z
  .object({
    product: z
      .string()
      .describe('The product it maintains (the base release’s).'),
    revision: z
      .string()
      .describe('The product revision it maintains (the base release’s).'),
    branch: z
      .string()
      .describe(
        'Its branch (named by `CCMS_MAINTENANCE_BRANCH`, default `maintenance/{product}/{revision}`): change sets started on the line merge into it, and releases from the line are cut from its head.',
      ),
    baseCommit: z
      .string()
      .describe('Where the branch started: the base release’s commit.'),
    state: z
      .enum(MAINTENANCE_LINE_STATES)
      .describe('`open`, or `closed`: no new change sets start on it.'),
    createdBy: Who.describe('Who started it.'),
    createdAt: z.iso.datetime({ offset: true }),
    closedBy: Who.nullable().describe('Who closed it; null while open.'),
    closedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When it was closed; null while open.'),
  })
  .meta({ id: 'MaintenanceLineAttributes' });

export const MaintenanceLineResource = resourceObject('MaintenanceLine', {
  attributes: MaintenanceLineAttributes,
  relationships: z.object({ baseRelease: toOne('Release') }),
  meta: z.object({
    head: z
      .string()
      .nullable()
      .describe(
        'Where its branch points now (derived from Git); null when the branch is gone.',
      ),
  }),
}).meta({ id: 'MaintenanceLineResource' });

export const MaintenanceLineDocument = singleDocument(
  MaintenanceLineResource,
).meta({ id: 'MaintenanceLineDocument' });

export const MaintenanceLinePageDocument = pagedDocument(
  MaintenanceLineResource,
).meta({ id: 'MaintenanceLinePageDocument' });

export function toMaintenanceLineResource({
  line,
  head,
}: MaintenanceLineView): z.infer<typeof MaintenanceLineResource> {
  return {
    type: 'MaintenanceLine',
    id: line.id,
    attributes: {
      product: line.product,
      revision: line.revision,
      branch: line.branch,
      baseCommit: line.baseCommit,
      state: stateOf(line),
      createdBy: line.createdBy,
      createdAt: line.createdAt.toISOString(),
      closedBy: line.closedBy,
      closedAt: line.closedAt?.toISOString() ?? null,
    },
    relationships: {
      baseRelease: { data: { type: 'Release', id: line.baseRelease } },
    },
    meta: { head: head ?? null },
  };
}

/** `POST /maintenance-lines`: the release to start from, nothing else. */
export const StartMaintenanceLineDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('MaintenanceLine'),
      relationships: z.strictObject({
        baseRelease: z.strictObject({
          data: z.strictObject({
            type: z.literal('Release'),
            id: z
              .string()
              .min(1)
              .max(64)
              .describe('The release’s ID (a UUID).'),
          }),
        }),
      }),
    }),
  })
  .meta({ id: 'StartMaintenanceLineDocument' });
export type StartMaintenanceLineDocument = z.output<
  typeof StartMaintenanceLineDocument
>;

/** `POST /maintenance-lines/{id}/close`: no body, or a comment for the audit log. */
export const CloseMaintenanceLineDocument = z
  .strictObject({
    meta: z
      .strictObject({
        comment: TransitionComment.optional().describe(
          'Why, recorded in the audit log.',
        ),
      })
      .optional(),
  })
  .optional()
  .meta({ id: 'CloseMaintenanceLineDocument' });
export type CloseMaintenanceLineDocument = z.output<
  typeof CloseMaintenanceLineDocument
>;

/** Filter parameters of `GET /maintenance-lines`, validated before any query. */
export const maintenanceLineFilters = {
  product: ConfigKey,
  state: z.enum(MAINTENANCE_LINE_STATES),
};
