import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { FaqEntryComponent } from '@openfolia/ui/blocks';

/**
 * The FAQ entry's node view: `@openfolia/ui`'s FAQ entry frame around the content edited in place,
 * the question as a heading-like first line and the answer's blocks below it
 * (`container-blocks.css`, `[data-content='faq']`). Moved, dragged and deleted like every
 * block; nothing to set besides its text.
 */
@Component({
  selector: 'of-faq-node',
  imports: [FaqEntryComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-faq-entry [label]="'editor.docEditor.faq.label' | transloco">
      <ng-content />
    </of-faq-entry>
  `,
})
export class FaqNodeComponent {}
