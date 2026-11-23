import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideInfo, lucideSend } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { translated } from '@openfolia/ui/i18n';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ErrorStateComponent, SaveStatusComponent } from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { UiTexts } from '../../i18n';
import { ApiClient, toApiError } from '../../api';
import { MeService } from '../../permissions/me';
import { ChangeSetSession } from '../../session/change-set-session';
import { injectFailureText } from '../../session/failure-text';
import { injectAdminActions } from '../admin-actions';
import { ConfigDraft, type ConfigChangeSet } from '../settings/config-draft';
import { SubmitReviewDialogComponent } from './submit-review-dialog.component';
import { VariantEditorComponent } from './variant-editor.component';

/**
 * Admin › Variants (#91, screen 21): the frame around the standalone variant editor
 * (`of-variant-editor`). It loads the chosen change set's working copy of the configuration
 * (`ConfigDraft`, as the project settings), says where changes go, and offers "Submit for
 * review", which sends the change set on, saying which sign-offs it needs. The header's
 * "New value" opens the editor's Add dialog.
 */
@Component({
  selector: 'of-variants-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    RouterLink,
    ErrorStateComponent,
    FadeInDirective,
    SaveStatusComponent,
    ZardButtonComponent,
    ZardSkeletonComponent,
    SubmitReviewDialogComponent,
    VariantEditorComponent,
  ],
  providers: [ConfigDraft],
  viewProviders: [provideIcons({ lucideInfo, lucideSend })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div
      class="border-border bg-background flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3"
      data-slot="variants-status"
    >
      @if (mode().kind === 'edit') {
        <p class="m-0 min-w-0 flex-1 basis-60 text-sm break-words">
          {{
            'editor.admin.settings.editingIn'
              | transloco: { changeSet: changeSets.selected()?.title ?? '' }
          }}
        </p>
        @if (draft.saveState(); as s) {
          <of-save-status [status]="s" />
        }
        <a
          z-button
          zType="ghost"
          zSize="sm"
          routerLink="/review"
          [queryParams]="{ cs: changeSets.selected()?.id }"
          >{{ 'editor.admin.settings.openReview' | transloco }}</a
        >
        <button
          z-button
          zSize="sm"
          type="button"
          data-slot="submit-review"
          (click)="submitOpen.set(true)"
        >
          <ng-icon
            name="lucideSend"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.review.actions.submit' | transloco }}
        </button>
      } @else {
        <p
          class="text-muted-foreground m-0 flex min-w-0 flex-1 items-start gap-2 text-sm break-words"
        >
          <ng-icon
            name="lucideInfo"
            class="mt-0.5 shrink-0"
            size="16"
            aria-hidden="true"
          />
          {{ readReason() | transloco }}
        </p>
      }
    </div>

    @if (draft.status() === 'error' && !config()) {
      <of-error-state
        [kind]="draft.error()?.kind ?? 'unknown'"
        [message]="draft.error()?.message ?? ''"
        (retry)="reload()"
      />
    } @else if (!config()) {
      <div
        ofFadeIn="delayed"
        class="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
        aria-hidden="true"
      >
        <z-skeleton class="h-80 w-full" />
        <z-skeleton class="h-80 w-full" />
      </div>
    } @else {
      <of-variant-editor ofFadeIn />
    }

    <of-submit-review-dialog
      [open]="submitOpen()"
      [changeSet]="changeSets.selected()?.title ?? ''"
      [signOffs]="signOffs()"
      [busy]="submitting()"
      (confirm)="submitForReview()"
      (closed)="submitOpen.set(false)"
    />
  `,
})
export class VariantsPage {
  protected readonly draft = inject(ConfigDraft);
  protected readonly changeSets = inject(ChangeSetSession);
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly toast = inject(ToastService);
  private readonly texts = inject(UiTexts);
  private readonly failureText = injectFailureText();
  private readonly editor = viewChild(VariantEditorComponent);

  protected readonly config = this.draft.config;
  protected readonly mode = this.draft.mode;
  protected readonly readReason = computed(() => {
    const m = this.mode();
    return m.kind === 'read' && m.reason
      ? m.reason
      : 'editor.admin.settings.blocked.readOnly';
  });

  /** The restricted module types' labels: a configuration change needs each one's sign-off. */
  protected readonly signOffs = computed(() =>
    (this.config()?.moduleTypes ?? [])
      .filter((t) => t.restricted)
      .map((t) => this.texts.text(t.label, this.config()?.languages)),
  );

  protected readonly submitOpen = signal(false);
  protected readonly submitting = signal(false);

  private readonly changeSet = computed((): ConfigChangeSet | null => {
    const chosen = this.changeSets.selected();
    if (!chosen?.branch) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    return {
      id: chosen.id,
      branch: chosen.branch,
      state: option?.state ?? 'draft',
      authorId: option?.authorId ?? '',
    };
  });
  private readonly loadKey = computed(() => {
    const cs = this.changeSet();
    return `${cs?.id ?? ''}\n${cs?.state ?? ''}\n${cs?.authorId ?? ''}\n${this.me.me().id}`;
  });
  private countsRead = 0;
  private removals = 0;

  constructor() {
    effect(() => {
      this.loadKey();
      // A switch unanswered: what was asked for the person before lands for nobody (#716).
      if (this.changeSets.switching()) {
        untracked(() => this.draft.forget());
        return;
      }
      if (this.changeSets.selected()?.branch === null) return;
      untracked(() => void this.draft.load(this.changeSet()));
    });
    injectAdminActions()?.on('variants', () => {
      const editor = this.editor();
      if (editor) editor.openNew('value');
      else this.toast.show(translated(this.readReason()), { kind: 'info' });
    });
  }

  /** Leaving the screen (the route guard): what is saved becomes a save point first. */
  async leave(): Promise<boolean> {
    if (this.mode().kind === 'edit') await this.draft.savePoint();
    return true;
  }

  protected reload(): void {
    void this.draft.load(this.changeSet());
  }

  // --- Review. ---

  /** Makes what is saved a save point, then submits the change set for review. */
  protected async submitForReview(): Promise<void> {
    const cs = this.changeSet();
    const title = this.changeSets.selected()?.title ?? '';
    if (!cs || this.submitting()) return;
    this.submitting.set(true);
    try {
      if (!(await this.draft.savePoint())) return;
      await firstValueFrom(
        this.api.act('/change-sets/{changeSetId}/submit', {
          path: { changeSetId: cs.id },
        }),
      );
      this.submitOpen.set(false);
      this.toast.success(translated('editor.review.done.submit', { title }));
      void this.changeSets.refresh();
    } catch (error) {
      this.toast.error(
        this.failureText(
          translated('editor.review.failed.submit', { title }),
          toApiError(error),
        ),
      );
    } finally {
      this.submitting.set(false);
    }
  }
}
