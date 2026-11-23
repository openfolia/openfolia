import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { FadeInDirective } from '@openfolia/ui/smooth';

import { DiffItemHeaderComponent } from './diff-item-header.component';
import { subjectKey } from './module-diff.component';
import { ReviewContext } from './review-context';
import type { DiffView } from './module-diff-body.component';
import type { ChangeSetChange } from './review-model';
import { NO_CHANGES } from './tree-diff';

/**
 * A change to a project file (the configuration, a term), compared by what the API lists:
 * whether it was added, changed or removed, and which of its members changed. A side-by-side
 * view of these files comes with their editors, so it is drawn alike in every view, and says so in
 * side by side and rendered, where the modules around it change and it would seem stuck. It tells the page's overview at once what it
 * found (each changed member a change), since there is nothing more to read.
 */
@Component({
  selector: 'of-project-file-diff',
  imports: [TranslocoPipe, DiffItemHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [FadeInDirective],
  host: {
    class: 'flex min-w-0 flex-col gap-4 px-4 py-6 sm:px-8',
    '[attr.id]': "'item-' + key()",
  },
  template: `
    <of-diff-item-header
      [title]="title()"
      [id]="id()"
      [kind]="kind() | transloco"
      [state]="change().meta.change"
    >
      <ng-content select="[ofItemActions]" />
    </of-diff-item-header>
    @if (view() !== 'inline') {
      <p
        class="text-muted-foreground m-0 text-xs break-words"
        data-slot="same-every-view"
      >
        {{ 'editor.review.diff.sameInEveryView' | transloco }}
      </p>
    }
    @if (change().meta.unreadable) {
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'editor.review.diff.unreadable' | transloco }}
      </p>
    } @else if (fields().length > 0) {
      <div class="flex min-w-0 flex-col gap-1.5">
        <p class="text-muted-foreground m-0 text-sm">
          {{ 'editor.review.diff.changedMembers' | transloco }}
        </p>
        <ul class="m-0 flex min-w-0 flex-wrap gap-1.5 p-0">
          @for (f of fields(); track f) {
            <li
              class="border-border rounded-md border px-2 py-0.5 font-mono text-xs break-all"
            >
              {{ f }}
            </li>
          }
        </ul>
      </div>
    }
  `,
})
export class ProjectFileDiffComponent {
  private readonly review = inject(ReviewContext);

  readonly change = input.required<ChangeSetChange>();
  /** The page's view: this file is drawn alike in each, and says so outside inline (#452). */
  readonly view = input<DiffView>('inline');

  constructor() {
    effect(() => {
      const key = this.key();
      const summary = {
        counts: NO_CHANGES,
        // A file added or removed whole is one change, as is each changed member.
        fields: Math.max(1, this.fields().length),
        title: this.title(),
        renamed: false,
      };
      untracked(() => this.review.report(key, summary));
    });
  }

  protected readonly key = computed(() => subjectKey(this.change()));
  protected readonly id = computed(() => {
    const s = this.change().attributes.subject;
    return s.type === 'term'
      ? s.termId
      : s.type === 'design'
        ? s.designId
        : s.type === 'template'
          ? `templates/${s.templateId}/${s.path}`
          : 'openfolia.yaml';
  });
  protected readonly kind = computed(() => {
    const type = this.change().attributes.subject.type;
    return type === 'term'
      ? 'editor.review.diff.term'
      : type === 'design'
        ? 'editor.review.diff.design'
        : type === 'template'
          ? 'editor.review.diff.template'
          : 'editor.review.diff.config';
  });
  protected readonly title = computed(() => this.id());
  protected readonly fields = computed(
    (): readonly string[] => this.change().meta.fields,
  );
}
