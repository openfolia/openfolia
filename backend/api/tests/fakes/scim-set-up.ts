import { FakeAccessAdmin } from './fake-access-admin.js';
import { FakeAuditLog } from './fake-audit-log.js';
import { FakeEmailCodes } from './fake-email-codes.js';
import { FakeLockStore } from './fake-lock-store.js';
import { FakeSignInLinks } from './fake-passwords.js';
import { FakeScimDirectory } from './fake-scim-directory.js';
import { FakePendingSignIns } from './fake-second-factors.js';
import { FakeServiceAccountStore } from './fake-service-accounts.js';
import {
  FakeGroupMappings,
  FakeSessionPolicy,
  FakeSessionStore,
  FakeUserIdentities,
} from './fake-sign-in.js';
import { FakeUnitOfWork } from './fake-unit-of-work.js';
import type { Actor } from '../../src/access/core/actor.js';
import { WaysIn } from '../../src/access/core/ways-in.js';
import { ScimWrites } from '../../src/scim/core/scim-writes.js';
import {
  CreateScimGroupAction,
  DeleteScimGroupAction,
  ListScimGroupsAction,
  PatchScimGroupAction,
  ReplaceScimGroupAction,
} from '../../src/scim/core/actions/scim-groups.action.js';
import {
  CreateScimUserAction,
  DeleteScimUserAction,
  GetScimUserAction,
  ListScimUsersAction,
  PatchScimUserAction,
  ReplaceScimUserAction,
} from '../../src/scim/core/actions/scim-users.action.js';

export const scimRole = {
  id: 'directory',
  name: 'Directory',
  description: null,
  permissions: ['scim.provision' as const],
  scope: {},
};
/** The directory: a service account holding `scim.provision`. */
export const directory: Actor = {
  kind: 'service',
  id: 'directory-sync',
  roles: [scimRole],
};

/** The SCIM actions over in-memory fakes, with an admin (`root`) and an `author` role. */
export function scimSetUp() {
  const admin = new FakeAccessAdmin();
  admin.putRole(scimRole);
  admin.putRole({
    id: 'admin',
    name: 'Admin',
    description: null,
    permissions: ['admin.roles'],
    scope: {},
  });
  admin.putRole({
    id: 'author',
    name: 'Author',
    description: null,
    permissions: ['content.read', 'content.edit'],
    scope: {},
  });
  admin.putUser({
    id: 'root',
    name: 'Root',
    email: 'root@example.org',
    roleIds: ['admin'],
  });
  const accounts = new FakeServiceAccountStore();
  accounts.putAccount({
    id: 'directory-sync',
    name: 'Directory',
    description: null,
    roleIds: ['directory'],
  });
  const scim = new FakeScimDirectory(admin);
  const identities = new FakeUserIdentities(admin);
  const mappings = new FakeGroupMappings(admin);
  const policy = new FakeSessionPolicy();
  const locks = new FakeLockStore();
  const sessions = new FakeSessionStore();
  const pending = new FakePendingSignIns();
  const waysIn = new WaysIn(
    sessions,
    new FakeSignInLinks(),
    new FakeEmailCodes(admin),
    pending,
  );
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const writes = new ScimWrites(
    admin,
    scim,
    identities,
    mappings,
    policy,
    locks,
    waysIn,
    audit,
  );
  const deps = [admin, accounts, scim, writes, unit] as const;
  return {
    directory,
    admin,
    accounts,
    scim,
    identities,
    mappings,
    policy,
    locks,
    sessions,
    pending,
    audit,
    unit,
    actions: () => audit.events.map((e) => e.action),
    listUsers: new ListScimUsersAction(scim),
    getUser: new GetScimUserAction(scim),
    createUser: new CreateScimUserAction(...deps),
    replaceUser: new ReplaceScimUserAction(...deps),
    patchUser: new PatchScimUserAction(...deps),
    deleteUser: new DeleteScimUserAction(...deps),
    listGroups: new ListScimGroupsAction(scim),
    createGroup: new CreateScimGroupAction(...deps),
    replaceGroup: new ReplaceScimGroupAction(...deps),
    patchGroup: new PatchScimGroupAction(...deps),
    deleteGroup: new DeleteScimGroupAction(admin, accounts, writes, unit),
  };
}
