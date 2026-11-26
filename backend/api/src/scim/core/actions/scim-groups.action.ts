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
import { applyPatch, type PatchOperation } from '../scim-patch.js';
import {
  groupInputOf,
  groupResource,
  type ScimGroup,
} from '../scim-resources.js';
import { noGroup, ScimWrites } from '../scim-writes.js';

export interface ListScimGroupsInput {
  readonly actor: Actor;
  /** A SCIM filter (`displayName eq "Writers"`); left out: every provisioned group. */
  readonly filter?: string;
  readonly page: ScimPage;
}

/**
 * The provisioned groups (#377), filtered and paged as users are, by name. Needs
 * `scim.provision`, held by a service account.
 */
@Injectable()
export class ListScimGroupsAction extends ActorAction<
  ListScimGroupsInput,
  ScimListed<ScimGroup>
> {
  readonly policy = 'scim.provision';

  constructor(private readonly directory: ScimDirectory) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: ListScimGroupsInput): Promise<ScimListed<ScimGroup>> {
    directoryOnly(actor);
    return listPage(
      await this.directory.listGroups(),
      groupResource,
      filter,
      page,
    );
  }
}

export interface ScimGroupInput {
  readonly actor: Actor;
  readonly groupId: string;
}

/** One provisioned group; 404 `not-found` for none. Needs `scim.provision`. */
@Injectable()
export class GetScimGroupAction extends ActorAction<ScimGroupInput, ScimGroup> {
  readonly policy = 'scim.provision';

  constructor(private readonly directory: ScimDirectory) {
    super();
  }

  protected async run({ actor, groupId }: ScimGroupInput): Promise<ScimGroup> {
    directoryOnly(actor);
    const group = await this.directory.findGroup(groupId);
    if (!group) throw noGroup(groupId);
    return group;
  }
}

/** Shared by the writes below: the ports a provisioning transaction begins with. */
@Injectable()
abstract class ScimGroupWrite<
  In extends { readonly actor: Actor },
> extends ActorAction<In, ScimGroup> {
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

  /** Runs `write` in one transaction after `beginScimChange`, then reads the group it names. */
  protected change(
    actor: Actor,
    write: (tx: Transaction) => Promise<string>,
  ): Promise<ScimGroup> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginScimChange(this.admin, this.accounts, tx, actor);
        const id = await write(tx);
        const group = await this.directory.findGroup(id, tx);
        if (!group) throw noGroup(id);
        return group;
      },
      BOUNDED,
    );
  }
}

/**
 * Provisions a group (POST) with its members, who gain at once what the group mappings give the
 * group's name. 400 for a resource that is not valid or a member that is no provisioned user; 409
 * `scim-group-name-taken`. Needs `scim.provision`.
 */
@Injectable()
export class CreateScimGroupAction extends ScimGroupWrite<{
  readonly actor: Actor;
  readonly body: unknown;
}> {
  protected run({
    actor,
    body,
  }: {
    actor: Actor;
    body: unknown;
  }): Promise<ScimGroup> {
    directoryOnly(actor);
    const input = groupInputOf(body);
    return this.change(actor, (tx) =>
      this.writes.createGroup(tx, actor, input),
    );
  }
}

/** Replaces a group (PUT): its name and members (`ScimWrites.writeGroup`). 404. Needs `scim.provision`. */
@Injectable()
export class ReplaceScimGroupAction extends ScimGroupWrite<{
  readonly actor: Actor;
  readonly groupId: string;
  readonly body: unknown;
}> {
  protected run({
    actor,
    groupId,
    body,
  }: {
    actor: Actor;
    groupId: string;
    body: unknown;
  }): Promise<ScimGroup> {
    directoryOnly(actor);
    const input = groupInputOf(body);
    return this.change(actor, async (tx) => {
      await this.writes.writeGroup(tx, actor, groupId, input);
      return groupId;
    });
  }
}

/**
 * Changes a group by SCIM PATCH operations (members added and removed, a new name), then saves
 * the result as a PUT would. 404; 400 as the standard gives it. Needs `scim.provision`.
 */
@Injectable()
export class PatchScimGroupAction extends ScimGroupWrite<{
  readonly actor: Actor;
  readonly groupId: string;
  readonly operations: readonly PatchOperation[];
}> {
  protected run({
    actor,
    groupId,
    operations,
  }: {
    actor: Actor;
    groupId: string;
    operations: readonly PatchOperation[];
  }): Promise<ScimGroup> {
    return this.change(actor, async (tx) => {
      const before = await this.directory.findGroup(groupId, tx);
      if (!before) throw noGroup(groupId);
      const input = groupInputOf(applyPatch(groupResource(before), operations));
      await this.writes.writeGroup(tx, actor, groupId, input);
      return groupId;
    });
  }
}

/** Removes a group (DELETE): its members lose what its mappings gave. 404. Needs `scim.provision`. */
@Injectable()
export class DeleteScimGroupAction extends ActorAction<ScimGroupInput, void> {
  readonly policy = 'scim.provision';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly accounts: ServiceAccountStore,
    private readonly writes: ScimWrites,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({ actor, groupId }: ScimGroupInput): Promise<void> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginScimChange(this.admin, this.accounts, tx, actor);
        await this.writes.deleteGroup(tx, actor, groupId);
      },
      BOUNDED,
    );
  }
}
