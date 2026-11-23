import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGitCompareArrows } from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { RelativeTimePipe } from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListRowDirective,
  type ListFrameError,
} from '@openfolia/ui/list-frame';

import {
  revisionOf,
  type ModuleVersion,
  type ModuleVersionPage,
} from './history-model';

/** Where a row of the list leads: the query parameters of the address it opens. */
export type RowLink = (
  version: ModuleVersion,
  index: number,
) => {
  readonly path: readonly string[];
  readonly query: Record<string, unknown>;
  /** Keep the address's other query parameters (a choice on the same page). */
  readonly merge: boolean;
};

/**
 * A module's versions, newest first, paged in the list frame (rows scroll inside it, the
 * pagination below stays in view): each with its revision, when and by whom, what it did (added,
 * deleted), the release tags holding it, its change set (linking to its review) and its
 * approvers. A row's revision links to the version (`rowLink`); on the history page a second
 * button on every other row picks the version it is compared against (`compareLink`), so two
 * versions are chosen by keyboard as by pointer. The page keeps both choices in the address.
 */
@Component({
  selector: 'of-history-list',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    ListFrameComponent,
    ListRowDirective,
    RelativeTimePipe,
    ZardBadgeComponent,
  ],
  viewProviders: [provideIcons({ lucideGitCompareArrows })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The design's muted panel the versions sit in; the shown one is a card on it.
  host: { class: 'bg-muted/60 flex min-w-0 flex-col rounded-2xl p-2' },
  template: `
    <of-list-frame
      cards
      [label]="'editor.history.list.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="error()"
      [offset]="offset()"
      [skeletonRows]="compact() ? 3 : 5"
      [emptyTitle]="'editor.history.list.empty' | transloco"
      [emptyDescription]="'editor.history.list.emptyHint' | transloco"
      (pageChange)="pageLink()($event)"
      (retry)="retry()()"
    >
      <ng-template ofListRow let-item>
        @let v = asVersion(item);
        @let index = indexOf(v);
        @let selected = v.attributes.commit === selectedCommit();
        @let compared = v.attributes.commit === baseCommit();
        @let link = rowLink()(v, index);
        <div
          class="relative flex flex-col gap-1 rounded-xl p-3 text-sm transition-colors duration-200 motion-reduce:transition-none"
          [class]="
            selected
              ? 'bg-background border-foreground border'
              : 'hover:bg-background/60 dark:hover:bg-background/40 border border-transparent'
          "
          data-slot="history-row"
          [attr.data-commit]="v.attributes.commit"
        >
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              class="focus-visible:ring-ring rounded-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:ring-2"
              [routerLink]="link.path"
              [queryParams]="link.query"
              [queryParamsHandling]="link.merge ? 'merge' : ''"
              [attr.aria-current]="selected ? 'true' : null"
              [attr.aria-label]="
                revision(v, true).key | transloco: revision(v, true).params
              "
              data-slot="history-version"
              >{{ revision(v).key | transloco: revision(v).params }}</a
            >
            @if (v.meta.change !== 'changed') {
              <z-badge zType="outline">{{ changeKey(v) | transloco }}</z-badge>
            }
            @for (r of v.meta.releases; track r.tag) {
              <z-badge
                [attr.title]="
                  'editor.history.releasedIn' | transloco: { tag: r.tag }
                "
                >{{ 'editor.history.released' | transloco }} ·
                {{ r.tag }}</z-badge
              >
            }
            @if (compared) {
              <z-badge zType="secondary">{{
                'editor.history.compared' | transloco
              }}</z-badge>
            }
          </div>
          <span class="text-muted-foreground text-xs leading-5 break-words">
            {{ who(v) }} ·
            <time [attr.datetime]="v.attributes.committedAt">{{
              v.attributes.committedAt | ofRelativeTime
            }}</time>
          </span>
          @if (firstLine(v); as message) {
            <span
              class="text-muted-foreground line-clamp-2 text-xs leading-5 break-words"
              >{{ message }}</span
            >
          }
          @if (v.relationships.changeSet.data || approvers(v).length > 0) {
            <span
              class="text-muted-foreground flex flex-wrap gap-x-2 text-xs leading-5"
            >
              @if (v.relationships.changeSet.data; as cs) {
                <a
                  class="text-foreground focus-visible:ring-ring relative z-10 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2"
                  [routerLink]="['/review']"
                  [queryParams]="{ cs: cs.id }"
                  data-slot="history-change-set"
                  >{{ 'editor.history.changeSet' | transloco }}</a
                >
              }
              @if (approvers(v).length > 0) {
                <span class="break-words">{{
                  'editor.history.approvedBy'
                    | transloco: { names: approvers(v).join(', ') }
                }}</span>
              }
            </span>
          }
          @if (compareLink(); as compareTo) {
            @if (!selected && !compared) {
              @let to = compareTo(v, index);
              <a
                class="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative z-10 mt-1 inline-flex w-fit items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-2"
                [routerLink]="to.path"
                [queryParams]="to.query"
                [queryParamsHandling]="to.merge ? 'merge' : ''"
                data-slot="history-compare"
              >
                <ng-icon name="lucideGitCompareArrows" aria-hidden="true" />
                {{
                  'editor.history.compareWith'
                    | transloco
                      : {
                          revision:
                            (revision(v, true).key
                            | transloco: revision(v, true).params),
                        }
                }}
              </a>
            }
          }
        </div>
      </ng-template>
    </of-list-frame>
  `,
})
export class HistoryListComponent {
  readonly doc = input<ModuleVersionPage | null>(null);
  readonly loading = input(false);
  readonly error = input<ListFrameError | null>(null);
  /** The space above the frame (the frame caps its height to the rest). */
  readonly offset = input('14rem');
  /** The side panel's list: fewer placeholder rows. */
  readonly compact = input(false, { transform: booleanAttribute });
  /** The version shown, and the one it is compared against. */
  readonly selectedCommit = input<string | null>(null);
  readonly baseCommit = input<string | null>(null);
  readonly rowLink = input.required<RowLink>();
  /** Where "Compare with" leads; none: no such button (the side panel). */
  readonly compareLink = input<RowLink | null>(null);
  readonly pageLink = input.required<(page: number) => void>();
  readonly retry = input.required<() => void>();
  readonly nameOf = input.required<(kind: string, id: string) => string>();

  protected readonly revision = revisionOf;

  protected changeKey(v: ModuleVersion): string {
    return v.meta.change === 'added'
      ? 'editor.history.change.added'
      : 'editor.history.change.removed';
  }

  protected asVersion(item: unknown): ModuleVersion {
    return item as ModuleVersion;
  }

  /** The version's place in the whole history (from 0, newest first). */
  protected indexOf(v: ModuleVersion): number {
    const doc = this.doc();
    if (!doc) return 0;
    const page = doc.meta.page;
    return (page.currentPage - 1) * page.perPage + doc.data.indexOf(v);
  }

  protected who(v: ModuleVersion): string {
    const actor = v.attributes.actor;
    return actor ? this.nameOf()(actor.kind, actor.id) : '—';
  }

  protected approvers(v: ModuleVersion): string[] {
    return v.attributes.approvedBy.map((a) => this.nameOf()(a.kind, a.id));
  }

  protected firstLine(v: ModuleVersion): string {
    return v.attributes.message.split('\n')[0]?.trim() ?? '';
  }
}
