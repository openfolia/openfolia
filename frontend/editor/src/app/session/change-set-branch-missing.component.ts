import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchiveX, lucideLogOut } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ErrorStateComponent } from '@openfolia/ui/states';

import { ChangeSetSession } from './change-set-session';

/**
 * In place of a screen's content while the chosen change set's branch is gone from the content
 * repository (#317, `ChangeSetSession.branchMissing`): one message saying so, instead of the
 * screen's own load error. It offers to leave the change set (back to the published content)
 * and, for its author or an admin, to abandon it (at once, with Undo). Nothing recreates the
 * branch. The shell, the sidebar and the change-set picker stay as they are.
 */
@Component({
  selector: 'of-change-set-branch-missing',
  imports: [
    ErrorStateComponent,
    FadeInDirective,
    NgIcon,
    TranslocoPipe,
    ZardButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideArchiveX, lucideLogOut })],
  host: {
    class: 'flex flex-col items-center pb-12',
    'data-testid': 'change-set-branch-missing',
  },
  template: `
    <div ofFadeIn class="flex max-w-md flex-col items-center">
      <of-error-state
        kind="invalid"
        [retryable]="false"
        [heading]="'editor.changeSet.branchMissing.title' | transloco"
        [message]="message()"
        class="pb-4"
      />
      <div class="flex flex-wrap justify-center gap-2">
        <button
          z-button
          zType="outline"
          type="button"
          data-testid="change-set-leave"
          (click)="leave()"
        >
          <ng-icon
            name="lucideLogOut"
            data-icon="inline-start"
            strokeWidth="1.5"
            aria-hidden="true"
          />
          {{ 'editor.changeSet.branchMissing.leave' | transloco }}
        </button>
        @if (session.abandonable()) {
          <button
            z-button
            zType="destructive"
            type="button"
            data-testid="change-set-abandon"
            (click)="abandon()"
          >
            <ng-icon
              name="lucideArchiveX"
              data-icon="inline-start"
              strokeWidth="1.5"
              aria-hidden="true"
            />
            {{ 'editor.changeSet.branchMissing.abandon' | transloco }}
          </button>
        }
      </div>
    </div>
  `,
})
export class ChangeSetBranchMissingComponent {
  protected readonly session = inject(ChangeSetSession);
  private readonly t = injectTranslate();

  protected readonly message = computed(() =>
    this.t('editor.changeSet.branchMissing.message', {
      title: this.session.selected()?.title ?? '',
    }),
  );

  protected leave(): void {
    this.session.choose(null);
  }

  protected abandon(): void {
    const id = this.session.selected()?.id;
    if (id) this.session.abandon(id);
  }
}
