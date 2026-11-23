import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, type Schema } from '../api';

/**
 * The licence, where the source is and where the user guide is (`GET /about`). The guide's pages
 * are opened through `HelpService` (`help/help.service.ts`), by their article IDs.
 */
export type About = Schema<'AboutResource'>['attributes'];

/**
 * The software's licence and where this deployment's source code is, as `GET /about` names them
 * (#370: AGPL-3.0 section 13 asks a network service to offer its users the source). Read once,
 * the first time something shows it; a failed read is tried again the next time.
 */
@Injectable({ providedIn: 'root' })
export class AboutService {
  private readonly api = inject(ApiClient);
  private readonly value = signal<About | null>(null);
  private reading: Promise<void> | null = null;

  /** Null until `GET /about` answered. */
  readonly about = this.value.asReadonly();

  /** Reads `GET /about` unless it was read already or is being read. */
  load(): void {
    if (this.value() !== null || this.reading) return;
    this.reading = firstValueFrom(this.api.get('/about'))
      .then((document) => this.value.set(document.data.attributes))
      .catch(() => undefined)
      .finally(() => (this.reading = null));
  }
}
