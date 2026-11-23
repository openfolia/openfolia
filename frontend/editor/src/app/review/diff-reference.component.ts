import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { ModuleReferenceCardComponent } from '@openfolia/ui/blocks';
import { injectTranslate } from '@openfolia/ui/i18n';

import { MeService } from '../permissions/me';
import { DIFF_ITEM } from './review-context';
import { ReviewContext } from './review-context';

/**
 * A module reference in the diff: the card the editor shows, with the referenced module's
 * title read at the side's commit (its ID when it cannot be read), and Open to its editor.
 */
@Component({
  selector: 'of-diff-reference',
  imports: [ModuleReferenceCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-module-reference-card
      [title]="title()"
      [loading]="read.isLoading()"
      [problem]="missing()"
      [description]="description()"
      [shared]="true"
      [href]="href()"
    />
  `,
})
export class DiffReferenceComponent {
  private readonly item = inject(DIFF_ITEM);
  private readonly review = inject(ReviewContext);
  private readonly me = inject(MeService).me;
  private readonly t = injectTranslate();

  readonly moduleId = input.required<string>();
  /** Read at the base commit (the old side) rather than the head. */
  readonly old = input(false);

  protected readonly read = resource({
    params: () => ({
      lang: this.item.lang(),
      id: this.moduleId(),
      ref: this.old() ? this.item.base() : this.item.head(),
      // Read again for another person: what was shown was the one before's (#716).
      who: this.me().id,
    }),
    loader: ({ params }) =>
      this.review.moduleTitle(params.lang, params.id, params.ref),
  });

  protected readonly missing = computed(
    () =>
      this.read.status() === 'error' ||
      (this.read.hasValue() && this.read.value() === null),
  );
  protected readonly title = computed(
    () => (this.read.hasValue() && this.read.value()) || this.moduleId(),
  );
  protected readonly description = computed(() =>
    this.missing() ? this.t('editor.review.reference.missing') : '',
  );
  protected readonly href = computed(
    () =>
      `/content/${encodeURIComponent(this.item.lang())}/${encodeURIComponent(this.moduleId())}`,
  );
}
