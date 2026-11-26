import { Module } from '@nestjs/common';
import { AccessAdminModule } from '../access/access-admin.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ScimController } from './api/scim.controller.js';
import {
  CreateScimGroupAction,
  DeleteScimGroupAction,
  GetScimGroupAction,
  ListScimGroupsAction,
  PatchScimGroupAction,
  ReplaceScimGroupAction,
} from './core/actions/scim-groups.action.js';
import {
  CreateScimUserAction,
  DeleteScimUserAction,
  GetScimUserAction,
  ListScimUsersAction,
  PatchScimUserAction,
  ReplaceScimUserAction,
} from './core/actions/scim-users.action.js';
import { ScimDirectory } from './core/scim-directory.js';
import { ScimWrites } from './core/scim-writes.js';
import { DrizzleScimDirectory } from './repos/drizzle-scim-directory.js';

/**
 * Provisioning over SCIM 2.0 (#377): a directory creates, changes and lets go of users, and
 * their groups, which feed the group mappings (`/scim/v2`).
 */
@Module({
  imports: [AccessModule, AccessAdminModule, AuditModule, ChangeSetsModule],
  controllers: [ScimController],
  providers: [
    { provide: ScimDirectory, useClass: DrizzleScimDirectory },
    ScimWrites,
    ListScimUsersAction,
    GetScimUserAction,
    CreateScimUserAction,
    ReplaceScimUserAction,
    PatchScimUserAction,
    DeleteScimUserAction,
    ListScimGroupsAction,
    GetScimGroupAction,
    CreateScimGroupAction,
    ReplaceScimGroupAction,
    PatchScimGroupAction,
    DeleteScimGroupAction,
  ],
})
export class ScimModule {}
