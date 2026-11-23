import { computed, inject, Injectable } from '@angular/core';

import { MeService } from './me';
import {
  decide,
  suggestsOnly,
  type PermissionRule,
  type PermissionState,
} from './permissions';

@Injectable({ providedIn: 'root' })
export class PermissionService {
  private readonly meService = inject(MeService);
  protected readonly granted = computed(() => this.meService.me().permissions);

  /**
   * The person is a contributor (`suggestsOnly`): they edit only through "Suggest a change",
   * with no change-set picker.
   */
  readonly suggestsOnly = computed(() => suggestsOnly(this.granted()));

  /** Reactive: the state of a control for the current person. */
  state(rule: PermissionRule): PermissionState {
    return decide(this.granted(), rule);
  }
}

/**
 * The manual builder's permissions (its route provides them): a contributor (`suggestsOnly`,
 * #137) reads manuals but never builds them, whatever change set is chosen. Everyone else: as
 * `PermissionService`.
 */
@Injectable()
export class ManualPermissions extends PermissionService {
  private readonly reading = computed(() => {
    const granted = this.granted();
    if (!this.suggestsOnly()) return granted;
    const kept = new Set(granted);
    kept.delete('content.edit');
    return kept;
  });

  override state(rule: PermissionRule): PermissionState {
    return decide(this.reading(), rule);
  }
}
