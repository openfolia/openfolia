import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardTabLinkComponent, ZardTabNavComponent } from '@openfolia/ui/tabs';

import { PermissionService } from '../permissions/permission.service';

/** The Releases section's tabs. */
export type ReleaseTab = 'releases' | 'downloads' | 'maintenance';

interface TabLink {
  readonly id: ReleaseTab;
  readonly label: string;
  readonly path: string;
  readonly query: Record<string, string> | null;
}

/**
 * The Releases section's tabs, each in the address: the releases (`/releases`), the download
 * centre (`/releases/downloads`, #139) and the maintenance lines (`/releases?tab=maintenance`,
 * #250). A tab added here (and its route or parameter) is all it takes.
 */
export const RELEASE_TABS: readonly TabLink[] = [
  {
    id: 'releases',
    label: 'editor.releases.tabs.releases',
    path: '/releases',
    query: null,
  },
  {
    id: 'downloads',
    label: 'editor.releases.tabs.downloads',
    path: '/releases/downloads',
    query: null,
  },
  {
    id: 'maintenance',
    label: 'editor.releases.tabs.maintenance',
    path: '/releases',
    query: { tab: 'maintenance' },
  },
];

/**
 * The one tab bar under the Releases section's header. The page says which tab is current
 * (`current`): the maintenance lines are a parameter of `/releases`, which `routerLinkActive`
 * cannot tell from the releases. Maintenance is shown only to whoever may read the lines
 * (`content.read.draft`: a line's branch holds unreleased fixes).
 */
@Component({
  selector: 'of-release-tabs',
  imports: [
    RouterLink,
    TranslocoPipe,
    ZardTabNavComponent,
    ZardTabLinkComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0' },
  template: `
    <nav
      z-tab-nav
      data-slot="release-tabs"
      [attr.aria-label]="'editor.releases.tabs.label' | transloco"
      class="h-auto self-start rounded-lg"
    >
      @for (tab of tabs(); track tab.id) {
        <a
          z-tab-link
          [routerLink]="tab.path"
          [queryParams]="tab.query"
          [zActive]="tab.id === current()"
          [attr.data-tab]="tab.id"
          class="text-foreground data-active:text-foreground h-8 px-4 font-normal data-active:font-medium"
          >{{ tab.label | transloco }}</a
        >
      }
    </nav>
  `,
})
export class ReleaseTabsComponent {
  private readonly permissions = inject(PermissionService);

  /** The tab the page shows. */
  readonly current = input.required<ReleaseTab>();

  protected readonly tabs = computed(() => {
    const lines =
      this.permissions.state({ permission: 'content.read.draft' }).kind ===
      'enabled';
    return RELEASE_TABS.filter((t) => t.id !== 'maintenance' || lines);
  });
}
