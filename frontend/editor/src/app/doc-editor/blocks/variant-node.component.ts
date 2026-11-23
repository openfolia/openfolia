import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
// The full entry, with zod: this file checks a condition with its schema at run time.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Condition } from '@openfolia/content-model';
import { VariantBlockComponent } from '@openfolia/ui/blocks';
import { injectTranslate } from '@openfolia/ui/i18n';

import { conditionChips, DOC_BLOCKS, NODE_VIEW } from './doc-blocks-context';

/**
 * The variant block's node view: a dashed frame around blocks shown only for some variants, its
 * condition as chips (any listed value of a variant attribute, and every attribute), and the
 * blocks edited in place. "Add variant" opens the page's variant picker (`pickVariant`); without
 * one the button stays in view, disabled, with the reason. Applying gives the focus back to the block, the caret where it
 * was; removing the condition there takes the frame away and leaves its blocks in its place. A new block has no condition yet: it
 * says so, and the module keeps it in this browser until it has one.
 */
@Component({
  selector: 'of-variant-node',
  imports: [VariantBlockComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-variant-block
      [conditions]="chips() ?? []"
      [editable]="editable()"
      [selected]="selected()"
      [emptyText]="emptyText()"
      [pickLabel]="pickLabel()"
      [pickDisabledReason]="pickDisabledReason()"
      (pick)="pick()"
    >
      <ng-content />
    </of-variant-block>
  `,
})
export class VariantNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);
  private readonly t = injectTranslate();

  protected readonly editable = this.blocks.editable;
  protected readonly selected = this.view.selected;

  /** The condition as chips; null when the block has none yet. */
  protected readonly chips = computed(() =>
    conditionChips(
      this.view.node().attrs['when'],
      this.blocks.settings().config,
      this.t('editor.docEditor.variant.rule'),
    ),
  );

  protected readonly emptyText = computed(() =>
    this.chips() ? '' : this.t('editor.docEditor.variant.noCondition'),
  );

  protected readonly pickLabel = computed(() =>
    this.chips()
      ? this.t('editor.docEditor.variant.change')
      : this.t('editor.docEditor.variant.choose'),
  );

  protected readonly pickDisabledReason = computed(() =>
    this.blocks.settings().pickVariant
      ? ''
      : this.t('editor.docEditor.variant.pickerUnavailable'),
  );

  protected async pick(): Promise<void> {
    const picker = this.blocks.settings().pickVariant;
    if (!picker) return;
    const parsed = Condition.safeParse(this.view.node().attrs['when']);
    const back = this.view.keepCaret();
    const next = await picker(parsed.success ? parsed.data : null);
    if (next === 'remove') this.view.unwrap();
    else if (next) {
      this.view.setAttrs({ when: next });
      // Writing goes on in the block, where it was (#793).
      back();
    }
  }
}
