import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PassthroughBlockComponent } from '@openfolia/ui/blocks';

import { NODE_VIEW } from './doc-blocks-context';

/**
 * The passthrough's node view: content an importer could not convert, kept verbatim. It is not
 * edited in the rich editor: a labelled, read-only box with its format, whose source can be shown.
 * The node is an atom, so it is selected, moved and deleted whole and comes back out of the
 * editor exactly as it went in.
 */
@Component({
  selector: 'of-passthrough-node',
  imports: [PassthroughBlockComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-passthrough-block
      [label]="'editor.docEditor.passthrough.label' | transloco"
      [note]="'editor.docEditor.passthrough.readOnly' | transloco"
      [format]="format()"
      [source]="raw()"
    />
  `,
})
export class PassthroughNodeComponent {
  private readonly view = inject(NODE_VIEW);

  protected readonly format = computed(() => {
    const value = this.view.node().attrs['format'];
    return typeof value === 'string' ? value : '';
  });
  protected readonly raw = computed(() => {
    const value = this.view.node().attrs['raw'];
    return typeof value === 'string' ? value : '';
  });
}
