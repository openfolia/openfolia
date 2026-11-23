import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type {
  SelfApproval,
  SelfApprovalRule,
} from '../../src/change-sets/core/self-approval.js';
import {
  DEFAULT_INSTALLATION_SETTINGS,
  type InstallationSettings,
  type StoredInstallationSettings,
} from '../../src/settings/core/installation-settings.js';
import { InstallationSettingsStore } from '../../src/settings/core/installation-settings-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/** `InstallationSettingsStore` in memory, with `FakeUnitOfWork`: writes apply when the transaction commits. */
export class FakeInstallationSettingsStore extends InstallationSettingsStore {
  stored: StoredInstallationSettings = {
    settings: DEFAULT_INSTALLATION_SETTINGS,
    version: 0,
    updatedAt: null,
  };
  /** How many times `lock` was taken. */
  locks = 0;

  async read(): Promise<StoredInstallationSettings> {
    return this.stored;
  }

  async lock(tx: Transaction): Promise<StoredInstallationSettings> {
    fakeOf(tx);
    this.locks++;
    return this.stored;
  }

  async write(
    tx: Transaction,
    settings: InstallationSettings,
  ): Promise<StoredInstallationSettings> {
    const next: StoredInstallationSettings = {
      settings,
      version: this.stored.version + 1,
      updatedAt: fakeOf(tx).startedAt,
    };
    fakeOf(tx).onCommit(() => (this.stored = next));
    return next;
  }
}

/** A self-approval rule a test sets: `never` (four eyes) unless changed. */
export class FakeSelfApprovalRule implements SelfApprovalRule {
  rule: SelfApproval = 'never';

  async read(): Promise<SelfApproval> {
    return this.rule;
  }
}
