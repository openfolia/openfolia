import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideInfo, lucidePlus } from '@ng-icons/lucide';
import { filter, firstValueFrom, map, startWith } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RouteFadeDirective } from '@openfolia/ui/smooth';
import { ErrorStateComponent, SaveStatusComponent } from '@openfolia/ui/states';

import { ApiClient, pageQuery, ReadRef } from '../../api';
import { MeService } from '../../permissions/me';
import { ChangeSetSession } from '../../session/change-set-session';
import { Generation } from '../../shared/generation';
import { InUseDialogComponent } from '../variants/in-use-dialog.component';
import { ConfigDraft, type ConfigChangeSet } from './config-draft';
import type { UsageCount } from './config-model';
import { SettingsContext } from './settings-context';
import {
  GROUP_TITLES,
  SETTINGS_GROUPS,
  SETTINGS_TOPICS,
  topicOf,
  type SettingsTopicPage,
} from './settings-topics';

/** The usage counts are read this many at a time (the API's largest page). */
const USAGE_PAGE = 200;
const USAGE_PAGES = 5;

/** The topic whose page (#91's variant editor) answers the API's refusals itself. */
const SELF_REFUSING = 'variant-attributes';

/**
 * Admin › Project settings (#259, #318): the project configuration (`openfolia.yaml`) edited in the
 * chosen change set, one topic per page (`/admin/settings/<topic>`), chosen from a grouped menu
 * (a select below tablet width): languages; the content model (module types, audiences, facets,
 * variant attributes, text attributes); the output (labels, headings, safety symbols, code
 * languages). Each topic is read first and edited on demand; its one Add button sits in its
 * header. Every change is saved at once into the change set's working copy (`ConfigDraft`,
 * provided here for every topic) and reviewed like content; one line says where changes go.
 * The usage counts are read here for the topics (`SettingsContext`), and removing a value in use
 * opens #91's in-use decision. The installation's own topics (#588: Review) change the installation
 * at once, not a change set; the status line says so.
 */
@Component({
  selector: 'of-project-settings-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    ErrorStateComponent,
    FadeInDirective,
    RouteFadeDirective,
    SaveStatusComponent,
    ZardButtonComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    InUseDialogComponent,
  ],
  providers: [ConfigDraft, SettingsContext],
  viewProviders: [provideIcons({ lucideInfo, lucidePlus })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-5' },
  template: `
    <p
      class="text-muted-foreground m-0 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
      data-slot="settings-status"
    >
      @if (topic()?.installation) {
        <ng-icon
          name="lucideInfo"
          class="shrink-0"
          size="16"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 break-words">{{
          'editor.admin.settings.installation.appliesAtOnce' | transloco
        }}</span>
      } @else if (mode().kind === 'edit') {
        <span class="min-w-0 break-words">{{
          'editor.admin.settings.savedIn'
            | transloco: { changeSet: changeSets.selected()?.title ?? '' }
        }}</span>
        <span aria-hidden="true">·</span>
        <a
          class="text-foreground focus-visible:ring-ring/50 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
          routerLink="/review"
          [queryParams]="{ cs: changeSets.selected()?.id }"
          >{{ 'editor.admin.settings.openReview' | transloco }}</a
        >
        @if (draft.saveState(); as s) {
          <of-save-status class="ms-auto" [status]="s" />
        }
      } @else {
        <ng-icon
          name="lucideInfo"
          class="shrink-0"
          size="16"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 break-words">{{
          ctx.readReason() | transloco
        }}</span>
      }
    </p>

    <div
      class="grid min-w-0 items-start gap-5 md:grid-cols-[12.5rem_minmax(0,1fr)] md:gap-8"
    >
      <nav
        class="hidden min-w-0 flex-col gap-4 md:sticky md:top-4 md:flex"
        data-slot="settings-menu"
        [attr.aria-label]="'editor.admin.settings.outline' | transloco"
      >
        @for (g of groups; track g) {
          <div class="flex min-w-0 flex-col gap-0.5">
            <p
              class="text-muted-foreground m-0 px-3 pb-1 text-xs font-medium break-words"
            >
              {{ groupTitle(g) | transloco }}
            </p>
            @for (t of topicsOf(g); track t.path) {
              <a
                class="hover:bg-muted focus-visible:ring-ring/50 data-active:bg-muted rounded-md px-3 py-1.5 text-sm break-words transition-colors duration-150 outline-none focus-visible:ring-2 data-active:font-medium motion-reduce:transition-none"
                [routerLink]="t.path"
                [queryParams]="ctx.linkQuery()"
                routerLinkActive
                #active="routerLinkActive"
                [attr.data-active]="active.isActive ? '' : null"
                ariaCurrentWhenActive="page"
                [attr.data-topic]="t.path"
                >{{ t.title | transloco }}</a
              >
            }
          </div>
        }
      </nav>

      <div class="flex min-w-0 flex-col gap-4 md:hidden">
        <z-select
          zPosition="popper"
          data-slot="settings-menu-select"
          [zAriaLabel]="'editor.admin.settings.outline' | transloco"
          [zValue]="topic()?.path ?? ''"
          (zSelectionChange)="go($any($event))"
        >
          @for (t of topics; track t.path) {
            <z-select-item [zValue]="t.path"
              >{{ groupTitle(t.group) | transloco }} ›
              {{ t.title | transloco }}</z-select-item
            >
          }
        </z-select>
      </div>

      <section
        class="flex min-w-0 flex-col gap-5"
        [attr.aria-labelledby]="topic() ? 'settings-topic-title' : null"
        [attr.data-topic]="topic()?.path"
      >
        @if (topic(); as t) {
          <header
            class="flex max-w-4xl min-w-0 flex-wrap items-start gap-x-6 gap-y-3"
          >
            <div class="flex min-w-0 flex-1 basis-64 flex-col gap-1">
              <h2
                id="settings-topic-title"
                class="m-0 text-lg font-medium break-words"
              >
                {{ t.title | transloco }}
              </h2>
              <p
                class="text-muted-foreground m-0 max-w-prose text-sm break-words"
              >
                {{ t.hint | transloco }}
              </p>
            </div>
            @if (t.add && ctx.editable()) {
              <button
                z-button
                zType="outline"
                type="button"
                data-slot="topic-add"
                (click)="add()"
              >
                <ng-icon
                  name="lucidePlus"
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {{ t.add | transloco }}
              </button>
            }
          </header>
        }

        @if (topic()?.installation) {
          <!-- The installation's own settings read nothing of the configuration. -->
          <div ofFadeIn class="min-w-0">
            <router-outlet
              ofRouteFade
              (activate)="activated($event)"
              (deactivate)="page = null"
            />
          </div>
        } @else if (draft.status() === 'error' && !config()) {
          <of-error-state
            [kind]="draft.error()?.kind ?? 'unknown'"
            [message]="draft.error()?.message ?? ''"
            (retry)="reload()"
          />
        } @else if (!config()) {
          <div
            ofFadeIn="delayed"
            class="flex flex-col gap-2"
            aria-hidden="true"
          >
            <z-skeleton class="h-10 w-full" />
            <z-skeleton class="h-10 w-full" />
            <z-skeleton class="h-10 w-full" />
          </div>
        } @else {
          <div ofFadeIn class="min-w-0">
            <router-outlet
              ofRouteFade
              (activate)="activated($event)"
              (deactivate)="page = null"
            />
          </div>
        }
      </section>
    </div>

    <of-in-use-dialog
      [request]="ctx.decision()?.request ?? null"
      (closed)="ctx.decision.set(null)"
    />
  `,
})
export class ProjectSettingsPage {
  protected readonly draft = inject(ConfigDraft);
  protected readonly ctx = inject(SettingsContext);
  protected readonly changeSets = inject(ChangeSetSession);
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly readRef = inject(ReadRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly groups = SETTINGS_GROUPS;
  protected readonly topics = SETTINGS_TOPICS;
  protected readonly config = this.draft.config;
  protected readonly mode = this.draft.mode;

  /** The open topic, from the child route's path. */
  protected readonly topic = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => topicOf(this.route.snapshot.firstChild?.routeConfig?.path)),
    ),
    { initialValue: undefined },
  );
  /** The open topic's page, for its Add button. */
  protected page: Partial<SettingsTopicPage> | null = null;

  private readonly changeSet = computed((): ConfigChangeSet | null => {
    const chosen = this.changeSets.selected();
    if (!chosen?.branch) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    return {
      id: chosen.id,
      branch: chosen.branch,
      state: option?.state ?? 'draft',
      authorId: option?.authorId ?? '',
    };
  });
  private readonly loadKey = computed(() => {
    const cs = this.changeSet();
    return `${cs?.id ?? ''}\n${cs?.state ?? ''}\n${cs?.authorId ?? ''}\n${this.me.me().id}`;
  });
  private readonly countReads = new Generation();

  constructor() {
    effect(() => {
      this.loadKey();
      // A switch unanswered: what was asked for the person before lands for nobody (#716).
      if (this.changeSets.switching()) {
        untracked(() => this.draft.forget());
        return;
      }
      if (this.changeSets.selected()?.branch === null) return;
      untracked(() => void this.draft.load(this.changeSet()));
    });
    effect(() => {
      this.readRef.ref();
      this.readRef.moves();
      this.me.me();
      this.draft.commits();
      if (this.changeSets.switching()) {
        this.countReads.end();
        return;
      }
      untracked(() => void this.readCounts());
    });
    // A refusal by the API: the decision names where the value is used. The variant
    // attributes' editor answers its own.
    effect(() => {
      const refusal = this.draft.refusal();
      if (!refusal || this.topic()?.path === SELF_REFUSING) return;
      untracked(() => {
        this.ctx.refused(refusal);
        this.draft.refusal.set(null);
      });
    });
  }

  /** Leaving the screen (the route guard): what is saved becomes a save point first. */
  async leave(): Promise<boolean> {
    if (this.mode().kind === 'edit') await this.draft.savePoint();
    return true;
  }

  protected reload(): void {
    void this.draft.load(this.changeSet());
  }

  protected groupTitle(g: (typeof SETTINGS_GROUPS)[number]): string {
    return GROUP_TITLES[g];
  }

  protected topicsOf(g: (typeof SETTINGS_GROUPS)[number]) {
    return SETTINGS_TOPICS.filter((t) => t.group === g);
  }

  protected go(path: string): void {
    if (!topicOf(path) || path === this.topic()?.path) return;
    void this.router.navigate([path], {
      relativeTo: this.route,
      queryParams: this.ctx.linkQuery(),
    });
  }

  protected activated(component: unknown): void {
    this.page = component as Partial<SettingsTopicPage>;
  }

  protected add(): void {
    this.page?.openAdd?.();
  }

  private async readCounts(): Promise<void> {
    const live = this.countReads.start();
    const found = new Map<string, UsageCount>();
    try {
      for (let page = 1; page <= USAGE_PAGES; page++) {
        const doc = await firstValueFrom(
          this.api.get('/config/usages', {
            query: pageQuery({ number: page, size: USAGE_PAGE }),
          }),
        );
        if (!live()) return;
        for (const r of doc.data) found.set(r.id, r.meta);
        if (page >= doc.meta.page.lastPage) break;
      }
      this.ctx.counts.set(found);
    } catch {
      // Counts are a help, not a condition: without them the API's check still refuses.
      if (live()) this.ctx.counts.set(new Map());
    }
  }
}
