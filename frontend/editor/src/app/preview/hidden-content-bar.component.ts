import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEye, lucideSplit } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import { RefreshingDirective } from '@openfolia/ui/smooth';

import { conditionChips } from '../doc-editor/blocks/doc-blocks-context';
import type { HiddenDoc, HiddenItem } from './preview-model';
import type { ShownConfig } from '../i18n';

/** The configuration with its labels in the interface language (#731). */
type Config = ShownConfig;

let lists = 0;

/**
 * What a preview's variant hides (`…/hidden-content`), above the page: the first two by name and
 * condition, "and N more", and on request the paged list (each item's label, where it is and its
 * condition as chips). The preview screen's and the module editor's live preview.
 */
@Component({
  selector: 'of-hidden-content-bar',
  imports: [
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    ListFrameComponent,
    ListRowDirective,
    RefreshingDirective,
    ZardButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideEye, lucideSplit })],
  host: { class: 'block' },
  template: `
    <section
      class="border-warning bg-warning-muted flex flex-col rounded-lg border"
      [attr.aria-label]="'editor.preview.hidden.region' | transloco"
    >
      <div
        class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm"
        [ofRefreshing]="loading() && !!hidden()"
      >
        <ng-icon
          name="lucideEye"
          class="text-muted-foreground shrink-0"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 break-words">
          {{ source() | transloco }}
          @if (hidden(); as h) {
            @if (h.meta.page.total === 0) {
              {{ 'editor.preview.hidden.none' | transloco }}
            } @else {
              {{ 'editor.preview.hidden.intro' | transloco }}
              @for (
                item of h.data.slice(0, 2);
                track item.id;
                let last = $last
              ) {
                <strong class="font-medium">{{ itemLabel(item) }}</strong>
                ({{ conditionText(item) }}){{
                  last && h.meta.page.total <= 2 ? '.' : ','
                }}
              }
              @if (h.meta.page.total > 2) {
                {{
                  'editor.preview.hidden.more'
                    | transloco: { count: h.meta.page.total - 2 }
                }}
              }
            }
          } @else if (failed()) {
            {{ 'editor.preview.hidden.failed' | transloco }}
          }
        </span>
        @if (hidden() && hidden()!.meta.page.total > 0) {
          <button
            z-button
            zType="link"
            type="button"
            class="h-7 px-2"
            [attr.aria-expanded]="open()"
            [attr.aria-controls]="listId"
            (click)="toggled.emit()"
          >
            {{
              (open()
                ? 'editor.preview.hidden.hide'
                : 'editor.preview.hidden.show'
              ) | transloco
            }}
          </button>
        } @else if (failed()) {
          <button
            z-button
            zType="link"
            type="button"
            class="h-7 px-2"
            (click)="retry.emit()"
          >
            {{ 'editor.session.retry' | transloco }}
          </button>
        }
      </div>
      <of-collapse [id]="listId" [open]="open()">
        <div class="border-warning border-t p-2">
          <of-list-frame
            class="bg-background rounded-md"
            [offset]="listOffset()"
            [label]="'editor.preview.hidden.list' | transloco"
            [items]="hidden()?.data ?? []"
            [page]="hidden()?.meta?.page ?? null"
            [loading]="loading()"
            [error]="null"
            [skeletonRows]="3"
            [emptyTitle]="'editor.preview.hidden.none' | transloco"
            (pageChange)="pageChange.emit($event)"
          >
            <ng-template ofListRow let-row>
              @let item = asHidden(row);
              <div class="flex flex-col gap-1 px-3 py-2">
                <span class="flex flex-wrap items-baseline gap-x-2">
                  <span class="font-medium break-words">{{
                    itemLabel(item)
                  }}</span>
                  <span
                    class="text-muted-foreground text-xs [overflow-wrap:anywhere]"
                    >{{ itemWhere(item) }}</span
                  >
                </span>
                <span class="flex flex-wrap items-center gap-1.5">
                  <ng-icon
                    name="lucideSplit"
                    class="text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span class="text-muted-foreground text-xs">{{
                    'editor.preview.hidden.shownFor' | transloco
                  }}</span>
                  @for (chip of chipsOf(item); track chip.attribute) {
                    <span
                      class="border-border bg-background text-foreground inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs break-all"
                    >
                      <span class="text-muted-foreground"
                        >{{ chip.attribute }}:</span
                      >
                      {{ chip.values.join(', ') }}
                    </span>
                  }
                </span>
              </div>
            </ng-template>
          </of-list-frame>
        </div>
      </of-collapse>
    </section>
  `,
})
export class HiddenContentBarComponent {
  private readonly t = injectTranslate();

  readonly hidden = input<HiddenDoc | null>(null);
  readonly loading = input(false);
  readonly failed = input(false);
  /** The paged list is open. */
  readonly open = input(false);
  readonly config = input<Config | null>(null);
  /** What is shown, as a translation key: a draft, the released content, unsaved changes. */
  readonly source = input.required<string>();
  /** The list frame's offset from the viewport's height (`of-list-frame`). */
  readonly listOffset = input('55dvh');

  readonly toggled = output<void>();
  readonly retry = output<void>();
  readonly pageChange = output<number>();

  protected readonly listId = `of-hidden-list-${++lists}`;

  protected asHidden(row: unknown): HiddenItem {
    return row as HiddenItem;
  }

  /** The hidden content's name: its label, else what it is. */
  protected itemLabel(item: HiddenItem): string {
    if (item.meta.label) return item.meta.label;
    return this.t('editor.preview.hidden.untitledBlock', {
      id: item.attributes.blockId ?? '',
    });
  }

  /** Where it is: a block in a module, a module, or a chapter. */
  protected itemWhere(item: HiddenItem): string {
    const { kind, module } = item.attributes;
    if (kind === 'block') {
      return this.t('editor.preview.hidden.inModule', { module: module ?? '' });
    }
    return kind === 'module'
      ? this.t('editor.preview.hidden.module', { module: module ?? '' })
      : this.t('editor.preview.hidden.chapter');
  }

  /** The condition in words, as the chips read ("Model: Large; Software: ≥ 2.3"). */
  protected conditionText(item: HiddenItem): string {
    return this.chipsOf(item)
      .map((chip) => `${chip.attribute}: ${chip.values.join(', ')}`)
      .join('; ');
  }

  protected chipsOf(item: HiddenItem) {
    return (
      conditionChips(
        item.attributes.condition,
        this.config() ?? null,
        this.t('editor.preview.hidden.rule'),
      ) ?? []
    );
  }
}
