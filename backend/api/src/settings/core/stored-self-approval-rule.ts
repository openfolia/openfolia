import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../base/core/unit-of-work.js';
import {
  type SelfApproval,
  SelfApprovalRule,
} from '../../change-sets/core/self-approval.js';
import { InstallationSettingsStore } from './installation-settings-store.js';

/** `SelfApprovalRule` from the installation's settings, read in the approval's transaction. */
@Injectable()
export class StoredSelfApprovalRule extends SelfApprovalRule {
  constructor(private readonly store: InstallationSettingsStore) {
    super();
  }

  async read(tx?: Transaction): Promise<SelfApproval> {
    return (await this.store.read(tx)).settings.selfApproval;
  }
}
