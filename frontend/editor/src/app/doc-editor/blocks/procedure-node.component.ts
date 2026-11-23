import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus } from '@ng-icons/lucide';
import { TranslocoPipe } from '@jsverse/transloco';
import { ProcedureBlockComponent } from '@openfolia/ui/blocks';
import { injectTranslate } from '@openfolia/ui/i18n';

import { DOC_BLOCKS, NODE_VIEW } from './doc-blocks-context';

/**
 * The procedure's node view: numbered task steps under a small label, edited in place like a list
 * (Enter adds a step, Tab makes it a sub-step, Shift+Tab lifts it back), each step's own blocks
 * (its result, a note) below its text. Steps move by their grip and Alt+Up/Down, among the steps
 * of their procedure. The title is optional: "Add title" puts an empty one first.
 */
@Component({
  selector: 'of-procedure-node',
  imports: [ProcedureBlockComponent, NgIcon, TranslocoPipe],
  viewProviders: [provideIcons({ lucidePlus })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    '[style.--procedure-result-label]': 'resultLabel()',
  },
  template: `
    <of-procedure-block
      [label]="'editor.docEditor.procedure.label' | transloco"
    >
      @if (editable() && !hasTitle()) {
        <button
          header
          type="button"
          class="text-foreground inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          (click)="addTitle()"
        >
          <ng-icon name="lucidePlus" aria-hidden="true" />
          {{ 'editor.docEditor.procedure.addTitle' | transloco }}
        </button>
      }
      <ng-content />
    </of-procedure-block>
  `,
})
export class ProcedureNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);

  private readonly t = injectTranslate();

  protected readonly editable = this.blocks.editable;
  /** The word before a step's result, as a CSS string. */
  protected readonly resultLabel = computed(() =>
    JSON.stringify(this.t('editor.docEditor.procedure.result')),
  );
  protected readonly hasTitle = computed(
    () => this.view.node().firstChild?.type.name === 'title',
  );

  protected addTitle(): void {
    this.view.insertTitle();
  }
}
