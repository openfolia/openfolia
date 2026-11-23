import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFileArchive } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';

import { GuardDirective } from '../permissions/guard.directive';
import { ReleaseActions } from './release-actions';
import { archiveBlocked, type OutputProgress } from './releases-model';

/**
 * "Download all (ZIP)" for a release's files (#469, `GET /releases/:id/outputs/archive`), next to
 * the files' header. Blocked, with the reason as its tooltip, while no file is ready (or there are
 * none); while some are not ready it says how many will be left out. While the archive comes it
 * shows its spinner and the share received, in the same place as that note, so nothing moves.
 */
@Component({
  selector: 'of-release-archive-button',
  imports: [TranslocoPipe, NgIcon, ZardButtonComponent, GuardDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideFileArchive })],
  host: {
    class: 'flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1',
  },
  template: `
    <span
      class="text-muted-foreground min-w-0 text-end text-xs break-words tabular-nums"
      data-slot="archive-note"
      aria-live="polite"
      >{{ note() }}</span
    >
    <button
      z-button
      zType="outline"
      zSize="sm"
      type="button"
      data-slot="archive-download"
      [zLoading]="busy()"
      [ofGuard]="{ permission: 'content.read', blockedReason: blocked() }"
      (click)="download()"
    >
      @if (!busy()) {
        <ng-icon
          name="lucideFileArchive"
          data-icon="inline-start"
          aria-hidden="true"
        />
      }
      {{ 'editor.releases.files.archive.download' | transloco }}
    </button>
  `,
})
export class ReleaseArchiveButtonComponent {
  private readonly actions = inject(ReleaseActions);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  readonly releaseId = input.required<string>();
  /** The release's name, for the toasts. */
  readonly name = input.required<string>();
  /** Where the files stand (the release's `meta.outputs`); undefined until read. */
  readonly progress = input<OutputProgress | null | undefined>(undefined);

  /** The share of the archive received while it downloads (0 to 1); null when not downloading. */
  protected readonly share = computed(() => {
    const archiving = this.actions.archiving();
    return archiving?.releaseId === this.releaseId() ? archiving.share : null;
  });

  /**
   * A ZIP is downloading (this release's or, after leaving its page, another's): one at a time.
   * Its spinner disables the button; the guard's reason stays for what the files say, so it never
   * holds on to the button's own busy state.
   */
  protected readonly busy = computed(() => this.actions.archiving() !== null);

  protected readonly blocked = computed(() => archiveBlocked(this.progress()));

  /** The share received, as the person's locale writes a percent. */
  private readonly percent = computed(
    () => new Intl.NumberFormat(this.language.locale(), { style: 'percent' }),
  );

  protected readonly note = computed(() => {
    const share = this.share();
    if (share !== null) {
      return this.t('editor.releases.files.archive.downloading', {
        percent: this.percent().format(share),
      });
    }
    const p = this.progress();
    if (!p || p.done === 0 || p.done === p.total) return '';
    return this.t('editor.releases.files.archive.leftOut', {
      leftOut: p.total - p.done,
      total: p.total,
    });
  });

  protected download(): void {
    void this.actions.downloadAll(this.releaseId(), this.name());
  }
}
