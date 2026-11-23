import { Global, Module } from '@nestjs/common';
import { AuthoredBranches } from '../content/core/authored-branches.js';
import { ChangeSetStore } from './core/change-set-store.js';
import { ChangeSetAuthoredBranches } from './core/change-set-authored-branches.js';
import { DrizzleChangeSetStore } from './repos/drizzle-change-set-store.js';

/**
 * Which draft branches an actor authors, for `OpenSnapshotAction` (the
 * content component): global, since content cannot import the change
 * sets (they import it). The one `ChangeSetStore`, which the change sets'
 * own module takes from here.
 */
@Global()
@Module({
  providers: [
    { provide: ChangeSetStore, useClass: DrizzleChangeSetStore },
    { provide: AuthoredBranches, useClass: ChangeSetAuthoredBranches },
  ],
  exports: [AuthoredBranches, ChangeSetStore],
})
export class AuthoredBranchesModule {}
