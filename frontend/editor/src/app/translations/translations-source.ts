import { computed, inject, Injectable, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LocalizedText } from '@openfolia/content-model/core';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import type { StoredConfig } from '../content/browser-model';
import { labelsInUi, UiTexts } from '../i18n';
import { MeService } from '../permissions/me';
import type { FilterOption } from '../content/filter-chip.component';
import { folderOptions } from './translations-model';

/**
 * What every part of the Translations screen names things by, read once for the page (it
 * provides this): the configuration (source and target languages, the folders) and the manuals.
 * Without the manuals, a filter or a job names a manual by its ID.
 */
@Injectable()
export class TranslationsSource {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService).me;
  private readonly texts = inject(UiTexts);

  /** The configuration as read: what the project labels' row compares (#731). */
  readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  readonly config = labelsInUi(this.storedConfig);
  /** Why the configuration could not be read; the matrix needs it. */
  readonly failure = signal<ApiError | null>(null);
  private readonly storedManuals = signal<
    readonly { readonly id: string; readonly title: LocalizedText }[]
  >([]);
  /** The manuals, each by its title in the interface language (#731). */
  readonly manuals = computed((): readonly FilterOption[] => {
    const languages = this.storedConfig()?.languages;
    return this.storedManuals().map((m) => ({
      value: m.id,
      label: this.texts.text(m.title, languages),
    }));
  });
  private reads = 0;
  /** Who `config` and `manuals` were read for. */
  private readFor: string | null = null;

  readonly sourceLang = computed(() => this.config()?.languages.source ?? '');
  readonly targets = computed(() => this.config()?.languages.targets ?? []);
  /** The target languages the person manages translations into: what an export may name. */
  readonly managedTargets = computed(() => {
    const managed = this.me().managedLanguages ?? 'all';
    return managed === 'all'
      ? this.targets()
      : this.targets().filter((l) => managed.has(l));
  });
  readonly folders = computed((): readonly FilterOption[] => {
    const config = this.config();
    return config ? folderOptions(config) : [];
  });
  readonly manualTitles = computed(
    () => new Map(this.manuals().map((m) => [m.value, m.label])),
  );
  readonly folderLabels = computed(
    () => new Map(this.folders().map((f) => [f.value, f.label])),
  );

  /**
   * Reads them (again after a failure, for another revision, or for another person): the latest
   * read wins, so one still answering for the revision before is dropped, and so is one read for
   * the person before the one acting now (#706). For another person, what was read for the one
   * before goes at once; a failed read leaves nothing of what was there.
   */
  async load(): Promise<void> {
    const run = ++this.reads;
    const who = untracked(() => this.me().id);
    if (who !== this.readFor) {
      this.readFor = who;
      this.storedConfig.set(null);
      this.storedManuals.set([]);
    }
    this.failure.set(null);
    const [config, manuals] = await Promise.allSettled([
      firstValueFrom(this.api.get('/config')),
      firstValueFrom(
        this.api.get('/manuals', { query: pageQuery({ size: 200 }) }),
      ),
    ]);
    if (run !== this.reads || who !== untracked(() => this.me().id)) return;
    if (config.status === 'fulfilled') {
      this.storedConfig.set(config.value.data.attributes);
    } else {
      this.storedConfig.set(null);
      this.failure.set(toApiError(config.reason));
    }
    this.storedManuals.set(
      manuals.status === 'fulfilled'
        ? manuals.value.data.flatMap((m) =>
            'attributes' in m ? [{ id: m.id, title: m.attributes.title }] : [],
          )
        : [],
    );
  }
}
