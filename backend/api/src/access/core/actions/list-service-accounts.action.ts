import { Injectable } from '@nestjs/common';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import { noServiceAccount } from '../service-account-changes.js';
import {
  type ServiceAccount,
  type ServiceAccountFilter,
  ServiceAccountStore,
} from '../service-accounts.js';

/** One page of the service accounts matching `filter`, with their roles; needs `admin.roles`. */
@Injectable()
export class ListServiceAccountsAction extends ActorAction<
  { actor: Actor; page: PageRequest; filter?: ServiceAccountFilter },
  Paginated<ServiceAccount>
> {
  readonly policy = 'admin.roles';

  constructor(private readonly store: ServiceAccountStore) {
    super();
  }

  protected run({
    page,
    filter,
  }: {
    page: PageRequest;
    filter?: ServiceAccountFilter;
  }): Promise<Paginated<ServiceAccount>> {
    return this.store.list(page, filter);
  }
}

/** One service account, deactivated or not; 404 `not-found` when there is none. Needs `admin.roles`. */
@Injectable()
export class GetServiceAccountAction extends ActorAction<
  { actor: Actor; serviceAccountId: string },
  ServiceAccount
> {
  readonly policy = 'admin.roles';

  constructor(private readonly store: ServiceAccountStore) {
    super();
  }

  protected async run({
    serviceAccountId,
  }: {
    serviceAccountId: string;
  }): Promise<ServiceAccount> {
    const account = await this.store.find(serviceAccountId);
    if (!account) throw noServiceAccount(serviceAccountId);
    return account;
  }
}
