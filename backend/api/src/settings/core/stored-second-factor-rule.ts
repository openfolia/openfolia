import { Injectable } from '@nestjs/common';
import {
  SecondFactorRule,
  type SecondFactorRuleValue,
} from '../../access/core/second-factors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { InstallationSettingsStore } from './installation-settings-store.js';

/** `SecondFactorRule` from the installation's settings, read in the sign-in's transaction. */
@Injectable()
export class StoredSecondFactorRule extends SecondFactorRule {
  constructor(private readonly store: InstallationSettingsStore) {
    super();
  }

  async read(tx?: Transaction): Promise<SecondFactorRuleValue> {
    return (await this.store.read(tx)).settings.secondFactor;
  }
}
