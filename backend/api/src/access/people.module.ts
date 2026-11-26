import { Global, Module } from '@nestjs/common';
import { GetPeopleAction } from './core/actions/get-people.action.js';
import { DeactivatedUsers } from './core/deactivated-users.js';
import { DrizzleDeactivatedUsers } from './repos/drizzle-deactivated-users.js';

/**
 * Whether the people an answer names are deactivated (#928). Global: `JsonApiInterceptor`, on
 * every component's routes, asks it for the routes marked `@NamesPeople()`.
 */
@Global()
@Module({
  providers: [
    { provide: DeactivatedUsers, useClass: DrizzleDeactivatedUsers },
    GetPeopleAction,
  ],
  exports: [GetPeopleAction],
})
export class PeopleModule {}
