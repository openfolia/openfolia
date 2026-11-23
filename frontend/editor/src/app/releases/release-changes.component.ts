import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideExternalLink } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { languageName } from '../content/browser-model';
import { apiErrorText, UiTexts } from '../i18n';
import { MeService } from '../permissions/me';
import type { ManualItem } from '../preview/preview-model';
import { frameOffset } from './frame-offset';
import {
  CHANGE_BADGE,
  CHANGE_PAGE_SIZE,
  CHANGE_TEXT,
  type ReleaseChange,
  type ReleaseChangesDoc,
  type ReleaseItem,
} from './releases-model';

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;

/**
 * A release's changelog (`GET /releases/:id/changes`): each manual and language that changed since
 * the product's previous release (named above the list), with how; a row opens (smoothly) to the
 * modules that changed in that language, each linking to the module as released (the preview at
 * the release's tag). The page and the opened rows are the parent's (`?changesPage=`,
 * `?change=`).
 */
@Component({
  selector: 'of-release-changes',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    ListFrameComponent,
    ListRowDirective,
    ZardBadgeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideChevronRight, lucideExternalLink })],
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <p class="text-muted-foreground m-0 text-sm break-words">
      @if (doc(); as d) {
        @if (d.meta.previous; as p) {
          {{
            'editor.releases.changes.since' | transloco: { version: p.revision }
          }}
        } @else {
          {{ 'editor.releases.changes.first' | transloco }}
        }
      } @else {
        &nbsp;
      }
    </p>
    <of-list-frame
      #frame
      class="min-h-48 min-w-0"
      [label]="'editor.releases.changes.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [skeletonRows]="4"
      [emptyTitle]="'editor.releases.changes.empty.title' | transloco"
      [emptyDescription]="
        'editor.releases.changes.empty.description' | transloco
      "
      (pageChange)="pageChange.emit($event)"
      (retry)="reload()"
    >
      <ng-template ofListRow let-item>
        @let c = asChange(item);
        @let isOpen = opened().includes(c.id);
        <div class="flex flex-col">
          <button
            type="button"
            class="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-start outline-none focus-visible:ring-[3px] disabled:cursor-default disabled:hover:bg-transparent"
            [attr.aria-expanded]="c.meta.modules.length > 0 ? isOpen : null"
            [attr.aria-controls]="'change-' + c.id"
            [disabled]="c.meta.modules.length === 0"
            (click)="toggled.emit(c.id)"
          >
            <ng-icon
              name="lucideChevronRight"
              aria-hidden="true"
              class="text-muted-foreground mt-0.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
              [class.rotate-90]="isOpen"
              [class.invisible]="c.meta.modules.length === 0"
            />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="font-medium break-words">{{
                manualTitle(c.attributes.manual)
              }}</span>
              <span class="text-muted-foreground text-xs break-words">
                {{ languageLabel(c.attributes.lang) }}
                @if (c.meta.modules.length > 0) {
                  ·
                  {{
                    'editor.releases.changes.modules'
                      | transloco: { count: c.meta.modules.length }
                  }}
                }
              </span>
            </span>
            <z-badge [zType]="badge[c.meta.change]">{{
              changeText[c.meta.change] | transloco
            }}</z-badge>
          </button>
          <of-collapse [open]="isOpen" [attr.id]="'change-' + c.id">
            <ul class="m-0 flex list-none flex-col gap-1 p-0 ps-9 pe-3 pb-2.5">
              @for (m of c.meta.modules; track m.moduleId) {
                <li class="flex flex-wrap items-center gap-2 text-sm">
                  @if (m.change === 'removed') {
                    <span class="font-mono text-xs [overflow-wrap:anywhere]">{{
                      m.moduleId
                    }}</span>
                  } @else {
                    <a
                      class="text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-sm font-mono text-xs [overflow-wrap:anywhere] underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
                      [routerLink]="['/preview']"
                      [queryParams]="{
                        module: m.moduleId,
                        lang: c.attributes.lang,
                        tag: release().attributes.tag,
                      }"
                      [attr.aria-label]="
                        'editor.releases.changes.openModule'
                          | transloco: { module: m.moduleId }
                      "
                      >{{ m.moduleId }}
                      <ng-icon
                        name="lucideExternalLink"
                        size="12"
                        aria-hidden="true"
                    /></a>
                  }
                  <z-badge [zType]="badge[m.change]" class="font-normal">{{
                    changeText[m.change] | transloco
                  }}</z-badge>
                </li>
              }
            </ul>
          </of-collapse>
        </div>
      </ng-template>
    </of-list-frame>
  `,
})
export class ReleaseChangesComponent {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly language = inject(LanguageService);
  private readonly texts = inject(UiTexts);
  private readonly t = injectTranslate();

  readonly release = input.required<ReleaseItem>();
  /** The manuals at the release's tag: their titles. */
  readonly manuals = input<readonly ManualItem[]>([]);
  readonly page = input(1);
  /** The rows opened (`<lang>/<manualId>`). */
  readonly opened = input<readonly string[]>([]);
  readonly pageChange = output<number>();
  readonly toggled = output<string>();

  protected readonly badge = CHANGE_BADGE;
  protected readonly changeText = CHANGE_TEXT;
  protected readonly doc = signal<ReleaseChangesDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.doc(),
  );
  private runs = 0;

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  private readonly titles = computed(
    () =>
      new Map(
        this.manuals().map((m) => [m.id, this.texts.text(m.attributes.title)]),
      ),
  );

  constructor() {
    effect(() => {
      const releaseId = this.release().id;
      const page = this.page();
      this.me.me();
      this.reloads();
      untracked(() => void this.load(releaseId, page));
    });
  }

  protected asChange(item: unknown): ReleaseChange {
    return item as ReleaseChange;
  }

  protected manualTitle(id: string): string {
    return this.titles().get(id) ?? id;
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  private async load(releaseId: string, page: number): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/releases/{releaseId}/changes', {
          path: { releaseId },
          query: pageQuery({ number: page, size: CHANGE_PAGE_SIZE }),
        }),
      );
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && page > last) {
        this.pageChange.emit(last);
        return;
      }
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
