import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PageBreakBlockComponent } from '@openfolia/ui/blocks';

/**
 * The page break's node view: a labelled dashed rule, "Page break (PDF)". The block holds nothing
 * to edit: it is an atom, selected, moved, dragged and deleted whole, like the other blocks. The
 * PDF starts a new page after it; the HTML shows it only in the preview.
 */
@Component({
  selector: 'of-page-break-node',
  imports: [PageBreakBlockComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-page-break-block
      [label]="'editor.docEditor.pageBreak.label' | transloco"
    />
  `,
})
export class PageBreakNodeComponent {}
