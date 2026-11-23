import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  AdmonitionComponent,
  admonitionKinds,
  type AdmonitionKind,
} from '@openfolia/ui/blocks';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';

import {
  admonitionKind,
  admonitionLabels,
  DOC_BLOCKS,
  NODE_VIEW,
} from './doc-blocks-context';

/**
 * The admonition's node view (a note, a tip, something important): the kind's frame, icon and
 * configured word (in the document's language), and its blocks edited in place. A menu in the
 * header switches the kind; the colours fade to the new one.
 */
@Component({
  selector: 'of-admonition-node',
  imports: [AdmonitionComponent, NgIcon, TranslocoPipe, ...ZardDropdownImports],
  viewProviders: [provideIcons({ lucideChevronDown })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-admonition [kind]="kind()" [label]="labels()[kind()]">
      @if (editable()) {
        <span header class="inline-flex">
          <button
            type="button"
            z-dropdown
            [zDropdownMenu]="menu"
            class="inline-flex size-5 items-center justify-center rounded-sm outline-none hover:bg-current/15 focus-visible:ring-2 focus-visible:ring-current"
            [attr.aria-label]="'editor.docEditor.admonition.kind' | transloco"
          >
            <ng-icon name="lucideChevronDown" aria-hidden="true" />
          </button>
          <z-dropdown-menu-content #menu class="w-48">
            <z-dropdown-menu-label>{{
              'editor.docEditor.admonition.kind' | transloco
            }}</z-dropdown-menu-label>
            <z-dropdown-menu-radio-group
              [zValue]="kind()"
              (zValueChange)="setKind($event)"
            >
              @for (option of kinds; track option) {
                <z-dropdown-menu-radio-item [zValue]="option">
                  {{ labels()[option] }}
                </z-dropdown-menu-radio-item>
              }
            </z-dropdown-menu-radio-group>
          </z-dropdown-menu-content>
        </span>
      }
      <ng-content />
    </of-admonition>
  `,
})
export class AdmonitionNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);

  protected readonly editable = this.blocks.editable;
  protected readonly kinds = admonitionKinds;
  protected readonly kind = computed<AdmonitionKind>(() =>
    admonitionKind(this.view.node().attrs['kind']),
  );
  protected readonly labels = computed(() =>
    admonitionLabels(this.blocks.settings()),
  );

  protected setKind(value: string | undefined): void {
    const kind = admonitionKind(value);
    if (kind !== this.kind()) this.view.setAttrs({ kind });
  }
}
