import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin, type NewUser } from '../access-admin.js';
import { beginAccessChange, changeRoles } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import type { User } from '../user-directory.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

export interface CreateUserInput {
  readonly actor: Actor;
  readonly user: NewUser;
  /** The roles it starts with, each once. */
  readonly roleIds: readonly string[];
}

/** 409 `email-taken`: another user has this email address, ignoring case. */
export const emailTaken = () =>
  new ConflictError(
    'email-taken',
    'Another user has this email address already.',
  );

/**
 * Adds a person by hand (until sign-in creates them): an ID, a name, an
 * email address and roles; active at once. 409 `user-exists` when the ID
 * is taken, `email-taken` when the email is; 422 `unknown-role` for a role
 * that does not exist. Recorded as `user.create` (the IDs only, never the
 * name or email) and a `role.assign` per role. Needs `admin.roles`.
 */
@Injectable()
export class CreateUserAction extends ActorAction<CreateUserInput, User> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected run({ actor, user, roleIds }: CreateUserInput): Promise<User> {
    this.sandbox.refuse('users');
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        // The ID first: a user sent again is `user-exists`, not `email-taken`.
        if (await this.admin.findUser(tx, user.id)) throw userExists(user.id);
        if (
          user.email !== null &&
          (await this.admin.emailTaken(tx, user.email))
        ) {
          throw emailTaken();
        }
        if (!(await this.admin.insertUser(tx, user))) {
          throw userExists(user.id);
        }
        await this.auditLog.record(tx, actor, {
          action: 'user.create',
          subject: { type: 'user', id: user.id },
          data: { roleIds: [...roleIds] },
        });
        await changeRoles(this.admin, this.auditLog, tx, actor, user.id, {
          add: roleIds,
        });
        // Read back in the transaction: with its roles' permissions.
        const created = await this.admin.findUser(tx, user.id);
        if (!created) throw new Error(`User "${user.id}" was not created.`);
        return created;
      },
      BOUNDED,
    );
  }
}

const userExists = (id: string) =>
  new ConflictError('user-exists', `There is a user "${id}" already.`);
