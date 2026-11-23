import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { PageHelpComponent } from './page-help.component';

/**
 * A page's heading row: the title (`h1`) on the left, the page's actions (projected) on the
 * right, both on the title's baseline. Elements marked `ofTitleAside` sit next to the
 * title (a save status, a link); an element marked `ofTitle` stands in for the title's text
 * inside the `h1` (a title edited in place). The screen's help link (`of-page-help`, #221) ends
 * the title's row when the app provides one (`PAGE_HELP`). The breadcrumb above it comes from the
 * shell. Long titles wrap; on a narrow screen the actions move under the title.
 *
 * ```html
 * <of-page-header title="Content">
 *   <button z-button>New module</button>
 * </of-page-header>
 * ```
 */
@Component({
  selector: 'of-page-header',
  imports: [PageHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-wrap items-end justify-between gap-3' },
  template: `
    <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <h1 class="min-w-0 text-[1.75rem]/9 font-medium break-words">
        <ng-content select="[ofTitle]">{{ title() }}</ng-content>
      </h1>
      <ng-content select="[ofTitleAside]" />
      <of-page-help />
    </div>
    <div class="flex flex-wrap items-center gap-2 empty:hidden">
      <ng-content />
    </div>
  `,
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
}
