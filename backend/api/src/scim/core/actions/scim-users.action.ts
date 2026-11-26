import { Injectable } from '@nestjs/common';
import { AccessAdmin } from '../../../access/core/access-admin.js';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { ServiceAccountStore } from '../../../access/core/service-accounts.js';
import {
  BOUNDED,
  runContended,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { beginScimChange, directoryOnly } from '../scim-access.js';
import { ScimDirectory } from '../scim-directory.js';
import { listPage, type ScimListed, type ScimPage } from '../scim-list.js';
import { ScimRequestError } from '../scim-errors.js';
import { saysInactive } from '../scim-names.js';
import {
  applyPatch,
  leavesInactive,
  type PatchOperation,
} from '../scim-patch.js';
import {
  patchedUserInput,
  type ScimUser,
  type ScimUserInput as WrittenUser,
  userInputOf,
  userResource,
} from '../scim-resources.js';
import { noUser, ScimWrites } from '../scim-writes.js';

export interface ListScimUsersInput {
  readonly actor: Actor;
  /** A SCIM filter (`userName eq "jane"`); left out: every provisioned user. */
  readonly filter?: string;
  readonly page: ScimPage;
}

/**
 * The provisioned users (#377), filtered (RFC 7644 filters) and paged by `startIndex` and
 * `count`, by ID. Users the directory did not provision are not listed. Needs `scim.provision`,
 * held by a service account.
 */
@Injectable()
export class ListScimUsersAction extends ActorAction<
  ListScimUsersInput,
  ScimListed<ScimUser>
> {
  readonly policy = 'scim.provision';

  constructor(private readonly directory: ScimDirectory) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: ListScimUsersInput): Promise<ScimListed<ScimUser>> {
    directoryOnly(actor);
    return listPage(
      await this.directory.listUsers(),
      userResource,
      filter,
      page,
    );
  }
}

export interface ScimUserInput {
  readonly actor: Actor;
  readonly userId: string;
}

/** One provisioned user; 404 `not-found` for none. Needs `scim.provision`. */
@Injectable()
export class GetScimUserAction extends ActorAction<ScimUserInput, ScimUser> {
  readonly policy = 'scim.provision';

  constructor(private readonly directory: ScimDirectory) {
    super();
  }

  protected async run({ actor, userId }: ScimUserInput): Promise<ScimUser> {
    directoryOnly(actor);
    const user = await this.directory.findUser(userId);
    if (!user) throw noUser(userId);
    return user;
  }
}

/**
 * What `read` reads; undefined when it refuses the request and the request leaves the user
 * inactive. Someone who leaves loses access whatever else of it is wrong: they are then
 * deactivated and nothing else of it is kept.
 */
function unlessInactive(
  read: () => WrittenUser,
  inactive: () => boolean,
): WrittenUser | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof ScimRequestError && inactive()) return undefined;
    throw error;
  }
}

/** Shared by the writes below: the ports a provisioning transaction begins with. */
@Injectable()
abstract class ScimUserWrite<
  In extends { readonly actor: Actor },
> extends ActorAction<In, ScimUser> {
  readonly policy = 'scim.provision';

  constructor(
    protected readonly admin: AccessAdmin,
    protected readonly accounts: ServiceAccountStore,
    protected readonly directory: ScimDirectory,
    protected readonly writes: ScimWrites,
    protected readonly unit: UnitOfWork,
  ) {
    super();
  }

  /** Runs `write` in one transaction after `beginScimChange`, then reads the user it names. */
  protected change(
    actor: Actor,
    write: (tx: Transaction) => Promise<string>,
  ): Promise<ScimUser> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginScimChange(this.admin, this.accounts, tx, actor);
        const userId = await write(tx);
        const user = await this.directory.findUser(userId, tx);
        if (!user) throw noUser(userId);
        return user;
      },
      BOUNDED,
    );
  }
}

/**
 * Provisions a user (POST): a new user, or an existing one linked by its email address where the
 * link-by-email setting allows it (`ScimWrites.createUser`). 400 for a resource that is not
 * valid; 409 `scim-user-name-taken`, `email-taken`. Needs `scim.provision`.
 */
@Injectable()
export class CreateScimUserAction extends ScimUserWrite<{
  readonly actor: Actor;
  readonly body: unknown;
}> {
  protected run({
    actor,
    body,
  }: {
    actor: Actor;
    body: unknown;
  }): Promise<ScimUser> {
    directoryOnly(actor);
    const input = userInputOf(body);
    return this.change(actor, (tx) => this.writes.createUser(tx, actor, input));
  }
}

/**
 * Replaces a provisioned user (PUT) with the resource sent: its name, address, attributes and
 * whether it is active (`ScimWrites.writeUser`). One that is not valid but says they are inactive
 * deactivates them all the same (`unlessInactive`). 404 `not-found`. Needs `scim.provision`.
 */
@Injectable()
export class ReplaceScimUserAction extends ScimUserWrite<{
  readonly actor: Actor;
  readonly userId: string;
  readonly body: unknown;
}> {
  protected run({
    actor,
    userId,
    body,
  }: {
    actor: Actor;
    userId: string;
    body: unknown;
  }): Promise<ScimUser> {
    directoryOnly(actor);
    // Read before the transaction: one that is not valid never waits for the access lock.
    const input = unlessInactive(
      () => userInputOf(body),
      () => saysInactive(body) === true,
    );
    return this.change(actor, async (tx) => {
      const before = await this.directory.findUser(userId, tx);
      if (!before) throw noUser(userId);
      if (input) await this.writes.writeUser(tx, actor, input, before);
      else await this.writes.deactivateUser(tx, actor, userId);
      return userId;
    });
  }
}

/**
 * Changes a provisioned user by SCIM PATCH operations (`applyPatch`), then saves the result as
 * a PUT would. Deactivating (`active` false) ends the user's sessions and releases its locks at
 * once, whatever else the operations have wrong (`unlessInactive`). 404 `not-found`; 400 as the
 * standard gives it. Needs `scim.provision`.
 */
@Injectable()
export class PatchScimUserAction extends ScimUserWrite<{
  readonly actor: Actor;
  readonly userId: string;
  readonly operations: readonly PatchOperation[];
}> {
  protected run({
    actor,
    userId,
    operations,
  }: {
    actor: Actor;
    userId: string;
    operations: readonly PatchOperation[];
  }): Promise<ScimUser> {
    return this.change(actor, async (tx) => {
      const before = await this.directory.findUser(userId, tx);
      if (!before) throw noUser(userId);
      const resource = userResource(before);
      const input = unlessInactive(
        () => patchedUserInput(applyPatch(resource, operations), resource),
        () => leavesInactive(operations),
      );
      if (input) await this.writes.writeUser(tx, actor, input, before);
      else await this.writes.deactivateUser(tx, actor, userId);
      return userId;
    });
  }
}

/**
 * Lets a provisioned user go (DELETE): deactivated at once (sessions ended, locks released),
 * unlinked and out of its groups; the user stays, with its change sets and comments
 * (`ScimWrites.deleteUser`). 404 `not-found`. Needs `scim.provision`.
 */
@Injectable()
export class DeleteScimUserAction extends ActorAction<ScimUserInput, void> {
  readonly policy = 'scim.provision';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly accounts: ServiceAccountStore,
    private readonly directory: ScimDirectory,
    private readonly writes: ScimWrites,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({ actor, userId }: ScimUserInput): Promise<void> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginScimChange(this.admin, this.accounts, tx, actor);
        if (!(await this.directory.findUser(userId, tx))) throw noUser(userId);
        await this.writes.deleteUser(tx, actor, userId);
      },
      BOUNDED,
    );
  }
}
