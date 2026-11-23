import type { ChangeSetStore } from '../../src/change-sets/core/change-set-store.js';
import { LockHolding } from '../../src/change-sets/core/lock-holding.js';
import { FakeChangeSetBranches } from './fake-change-set-branches.js';
import { FakeWorkingCopyStore } from './fake-working-copy-store.js';

/**
 * `LockHolding` over `changeSets`, with working copies and branches in
 * memory (none unless a test adds them): every change set reads as
 * unchanged unless its branch is missing, which counts as changed.
 */
export function holdingOf(
  changeSets: ChangeSetStore,
  workingCopies = new FakeWorkingCopyStore(),
  branches = new FakeChangeSetBranches(),
): LockHolding {
  return new LockHolding(changeSets, workingCopies, branches);
}
