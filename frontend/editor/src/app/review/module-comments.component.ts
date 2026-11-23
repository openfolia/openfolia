import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMessageSquareOff, lucideRotateCcw } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { injectTranslate } from '@openfolia/ui/i18n';

import { shownNode, type BlockDiff } from './block-diff';
import { DiffCommentsComponent } from './diff-comments.component';
import { KIND_KEYS } from './diff-nodes.component';
import { ReviewComments, type ModuleKey } from './review-comments';

/**
 * What a module's review threads need besides their blocks, below its diff: a notice with Retry
 * when they could not be read (the diff stays usable), and the threads whose block a later save
 * point removed, listed apart and flagged as orphaned, each saying what its block was where the
 * diff still knows it. Both stay closed (no height) while there is neither, so no empty panel
 * shows.
 */
@Component({
  selector: 'of-module-comments',
  imports: [
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    DiffCommentsComponent,
    ZardButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideMessageSquareOff, lucideRotateCcw })],
  host: { class: 'flex min-w-0 flex-col' },
  template: `
    <!-- Said when it happens: the notice below is in the page all along, only hidden. -->
    <p class="sr-only" role="status">
      {{ failed() ? ('editor.review.comments.loadFailed' | transloco) : '' }}
    </p>
    <of-collapse [open]="failed()">
      <div
        class="border-border text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed px-3 py-2 text-sm"
        data-slot="comments-failed"
      >
        <span class="min-w-0 flex-1 break-words">{{
          'editor.review.comments.loadFailed' | transloco
        }}</span>
        <button
          z-button
          zSize="xs"
          zType="outline"
          type="button"
          (click)="retry()"
        >
          <ng-icon name="lucideRotateCcw" aria-hidden="true" />
          {{ 'editor.review.comments.retry' | transloco }}
        </button>
      </div>
    </of-collapse>
    <of-collapse [open]="orphans().length > 0">
      <section
        class="flex min-w-0 flex-col gap-2 pt-2"
        [attr.aria-label]="
          'editor.review.comments.orphansTitle'
            | transloco: { count: orphans().length }
        "
        data-slot="orphans"
      >
        <h4
          class="text-muted-foreground m-0 flex items-center gap-1.5 text-xs font-medium"
        >
          <ng-icon name="lucideMessageSquareOff" aria-hidden="true" />
          {{
            'editor.review.comments.orphansTitle'
              | transloco: { count: orphans().length }
          }}
        </h4>
        <p class="text-muted-foreground m-0 text-xs break-words">
          {{
            'editor.review.comments.orphansHint'
              | transloco: { count: orphans().length }
          }}
        </p>
        <of-diff-comments
          [module]="module()"
          [list]="orphans()"
          [anchorOf]="anchorOf"
        />
      </section>
    </of-collapse>
  `,
})
export class ModuleCommentsComponent {
  private readonly comments = inject(ReviewComments);
  private readonly t = injectTranslate();

  readonly module = input.required<ModuleKey>();
  /** The module's blocks as compared: what a removed block was is read there. */
  readonly nodes = input.required<readonly BlockDiff[]>();

  protected readonly failed = computed(() =>
    this.comments.failed(this.module()),
  );
  protected readonly orphans = computed(() =>
    this.comments.orphansOf(this.module()),
  );

  /** Every block either side has, by ID. */
  private readonly byId = computed(() => {
    const out = new Map<string, BlockDiff>();
    const walk = (list: readonly BlockDiff[]): void => {
      for (const n of list) {
        if (!n.ghost && !out.has(n.id)) out.set(n.id, n);
        walk(n.children);
      }
    };
    walk(this.nodes());
    return out;
  });

  protected readonly anchorOf = (blockId: string): string | null => {
    const node = this.byId().get(blockId);
    if (!node) return null;
    const n = shownNode(node);
    const kind = n.kind === 'item' ? (n.step ? 'step' : 'item') : n.block.type;
    const key = KIND_KEYS[kind];
    return this.t('editor.review.comments.on', {
      kind: key ? this.t(key) : kind,
    });
  };

  protected retry(): void {
    void this.comments.load(this.module(), true);
  }
}
