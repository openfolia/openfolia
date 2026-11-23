import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { EmptyStateComponent } from '@openfolia/ui/states';

/**
 * A section's page until its screen is built: the page header with the title from route data,
 * and an empty state. Under a page that has its own header (an Admin tab), only the empty state.
 */
@Component({
  selector: 'of-placeholder',
  imports: [PageHeaderComponent, EmptyStateComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-4' },
  template: `
    @if (!nested) {
      <of-page-header [title]="title | transloco" />
    }
    <div class="border-border rounded-xl border">
      <of-empty-state
        [title]="'editor.notBuilt.title' | transloco"
        [description]="'editor.notBuilt.description' | transloco"
      />
    </div>
  `,
})
export class PlaceholderPage {
  private readonly data = inject(ActivatedRoute).snapshot.data;
  protected readonly title = this.data['breadcrumb'] as string;
  /** Under a page that has its own header (the admin tabs). */
  protected readonly nested = this.data['nested'] === true;
}
