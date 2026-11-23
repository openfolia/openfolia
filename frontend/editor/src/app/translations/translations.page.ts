import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideDownload, lucideInfo, lucideUpload } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { RouteFadeDirective } from '@openfolia/ui/smooth';
import { ZardTabLinkComponent, ZardTabNavComponent } from '@openfolia/ui/tabs';

import { ReadRef } from '../api';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { injectQueryState } from '../view-state';
import { TranslationExportDialogComponent } from './export-dialog.component';
import { TranslationsSource } from './translations-source';
import {
  EXPORT_CONTEXT_PARAMS,
  TranslationsChanges,
} from './translations-view';

/** The page's tabs: each a route, so the address and Back keep it. */
export const TRANSLATION_TABS = [
  { path: '', label: 'editor.translations.tabs.status' },
  { path: 'jobs', label: 'editor.translations.tabs.jobs' },
] as const;

/**
 * Translations (#87, screen 5), for whoever holds `translation.manage`: the Status tab, a matrix
 * of modules × target languages with each translation's state, and the Jobs tab, the delta
 * exports sent to a provider. "Create delta export" (also `?export=open`) starts from the Status
 * tab's filters and chosen rows. "Import translation" opens the import screen (#244,
 * `/translations/import`).
 */
@Component({
  selector: 'of-translations-page',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TranslocoPipe,
    NgIcon,
    PageHeaderComponent,
    RouteFadeDirective,
    ZardButtonComponent,
    ZardTabNavComponent,
    ZardTabLinkComponent,
    GuardDirective,
    TranslationExportDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TranslationsSource],
  viewProviders: [provideIcons({ lucideDownload, lucideInfo, lucideUpload })],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.translations.title' | transloco">
      <a
        z-button
        zType="outline"
        data-slot="import"
        routerLink="import"
        [ofGuard]="{ permission: 'translation.manage' }"
      >
        <ng-icon
          name="lucideDownload"
          data-icon="inline-start"
          aria-hidden="true"
        />
        {{ 'editor.translations.import.action' | transloco }}
      </a>
      <button
        z-button
        type="button"
        data-slot="export"
        (click)="view.set({ export: 'open' })"
      >
        <ng-icon
          name="lucideUpload"
          data-icon="inline-start"
          aria-hidden="true"
        />
        {{ 'editor.translations.export.action' | transloco }}
      </button>
    </of-page-header>

    <p
      class="border-info/40 bg-info-muted text-foreground m-0 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm"
      role="note"
    >
      <ng-icon
        name="lucideInfo"
        class="text-info mt-0.5 shrink-0"
        aria-hidden="true"
      />
      <span class="min-w-0 break-words">{{
        'editor.translations.intro' | transloco
      }}</span>
    </p>

    <nav
      z-tab-nav
      [attr.aria-label]="'editor.translations.tabs.label' | transloco"
      class="h-auto self-start rounded-lg"
    >
      @for (tab of tabs; track tab.path) {
        <a
          z-tab-link
          [routerLink]="tab.path === '' ? '.' : tab.path"
          routerLinkActive
          [routerLinkActiveOptions]="activeOptions"
          ariaCurrentWhenActive="page"
          class="text-foreground data-active:text-foreground h-8 px-4 font-normal data-active:font-medium"
          >{{ tab.label | transloco }}</a
        >
      }
    </nav>

    <router-outlet ofRouteFade />

    <of-translation-export-dialog
      [open]="view.get('export')() === 'open'"
      (openChange)="setOpen($event)"
      [filterManual]="view.get('manual')()"
      [filterFolder]="view.get('folder')()"
      [filterLang]="view.get('lang')()"
      [selection]="view.get('rows')()"
      [targets]="source.managedTargets()"
      [manuals]="source.manuals()"
      [folders]="source.folders()"
      (exported)="exported()"
    />
  `,
})
export class TranslationsPage {
  private readonly readRef = inject(ReadRef);
  /** Who acts: a change reads the configuration and manuals again. */
  private readonly me = inject(MeService).me;
  private readonly personId = computed(() => this.me().id);
  private readonly changes = inject(TranslationsChanges);
  protected readonly source = inject(TranslationsSource);
  protected readonly view = injectQueryState(EXPORT_CONTEXT_PARAMS);
  protected readonly tabs = TRANSLATION_TABS;
  /** A tab is current by its path alone: the Status tab's filters and cell stay in the query. */
  protected readonly activeOptions = {
    paths: 'exact',
    queryParams: 'ignored',
    matrixParams: 'ignored',
    fragment: 'ignored',
  } as const;

  constructor() {
    // The chosen revision's configuration and manuals (again on its new head, #466), for whoever
    // acts (#706).
    effect(() => {
      this.readRef.ref();
      this.readRef.moves();
      this.personId();
      untracked(() => void this.source.load());
    });
  }

  protected setOpen(open: boolean): void {
    if (!open && this.view.get('export')())
      this.view.set({ export: undefined });
  }

  /** The job is made: the matrix (its cells now at the agency) and the jobs read again. */
  protected exported(): void {
    this.changes.notify();
  }
}
