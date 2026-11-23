import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus } from '@ng-icons/lucide';

import { ZardButtonComponent } from '../button/button.component';
import {
  ListFrameComponent,
  ListRowDirective,
  type ListFrameError,
  type ListFramePage,
} from '../list-frame/list-frame.component';
import { EmptyStateComponent } from '../states/empty-state.component';
import { ErrorStateComponent } from '../states/error-state.component';
import { NoAccessStateComponent } from '../states/no-access-state.component';
import {
  SaveStatusComponent,
  type SaveStatus,
} from '../states/save-status.component';
import { SkeletonRowsComponent } from '../states/skeleton-rows.component';
import { injectTranslate, translated } from '../i18n/text.pipe';
import { ToastComponent } from '../toast/toaster.component';
import { ToastService } from '../toast/toast.service';
import { TranslocoPipe } from '@jsverse/transloco';

type FrameState = 'rows' | 'many' | 'loading' | 'empty' | 'error' | 'no-access';

interface Row {
  title: string;
  detail: string;
}

const longValue =
  'a-very-long-address.with.no.natural.break.points@example.invalid/and/a/path/that/keeps/going/and/going/until/it/must/wrap';

function makeRows(
  count: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    title: t('ui.showcase.states.row', { n: i + 1 }),
    detail:
      i % 7 === 0 ? longValue : t('ui.showcase.states.rowDetail', { n: i + 1 }),
  }));
}

/**
 * Screen 20: the shared states (empty, loading, error, no access), save status and toasts as the
 * design lays them out, then the list frame with every state reachable.
 */
@Component({
  selector: 'of-states-showcase',
  imports: [
    NgIcon,
    TranslocoPipe,
    ToastComponent,
    ZardButtonComponent,
    ListFrameComponent,
    ListRowDirective,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    SaveStatusComponent,
    SkeletonRowsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucidePlus })],
  template: `
    <section class="flex flex-col gap-4" aria-labelledby="showcase-states">
      <h2 id="showcase-states" class="text-lg font-medium">
        {{ 'ui.showcase.states.heading' | transloco }}
      </h2>

      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <section [class]="card">
          <span [class]="cardLabel">{{
            'ui.showcase.states.emptyCard' | transloco
          }}</span>
          <of-empty-state
            class="flex-1 justify-center"
            [title]="'ui.showcase.states.emptyTitle' | transloco"
            [description]="'ui.showcase.states.emptyDescription' | transloco"
          >
            <button z-button type="button">
              <ng-icon
                name="lucidePlus"
                data-icon="inline-start"
                strokeWidth="1.5"
                aria-hidden="true"
              />
              {{ 'ui.showcase.states.newModule' | transloco }}
            </button>
          </of-empty-state>
        </section>
        <section [class]="card">
          <span [class]="cardLabel">{{
            'ui.showcase.states.loadingCard' | transloco
          }}</span>
          <of-skeleton-rows
            class="overflow-hidden rounded-lg"
            [count]="5"
            [header]="true"
          />
        </section>
        <section [class]="card">
          <span [class]="cardLabel">{{
            'ui.showcase.states.errorCard' | transloco
          }}</span>
          <of-error-state
            class="flex-1 justify-center"
            kind="unavailable"
            [heading]="'ui.showcase.states.errorHeading' | transloco"
            [message]="'ui.showcase.states.errorMessage' | transloco"
          />
        </section>
        <section [class]="card">
          <span [class]="cardLabel">{{
            'ui.showcase.states.noAccessCard' | transloco
          }}</span>
          <of-no-access
            class="flex-1 justify-center"
            [heading]="'ui.showcase.states.noAccessHeading' | transloco"
            [message]="'ui.showcase.states.noAccessMessage' | transloco"
          >
            <button z-button zType="outline" type="button">
              {{ 'ui.showcase.states.seeRoles' | transloco }}
            </button>
          </of-no-access>
        </section>
        <section [class]="card">
          <span [class]="cardLabel">{{
            'ui.showcase.states.saveCard' | transloco
          }}</span>
          <div class="flex flex-col items-start gap-2.5 pt-2">
            <of-save-status
              status="saved"
              [detail]="'ui.showcase.states.justNow' | transloco"
            />
            <of-save-status status="saving" />
            <of-save-status
              status="draft"
              [detail]="'ui.showcase.states.finishBlock' | transloco"
            />
            <of-save-status
              status="not-saved"
              [detail]="'ui.showcase.states.offline' | transloco"
            />
            <div class="mt-4 flex items-center gap-3">
              <of-save-status [status]="saveStatus()" />
              <button z-button zType="outline" zSize="sm" (click)="cycleSave()">
                {{ 'ui.showcase.states.cycle' | transloco }}
              </button>
            </div>
          </div>
        </section>
        <section [class]="card">
          <span [class]="cardLabel">{{
            'ui.showcase.states.toastCard' | transloco
          }}</span>
          <div class="flex flex-col gap-2.5 pt-2">
            <of-toast
              kind="success"
              [message]="
                'ui.showcase.states.reviewRequested' | transloco: { count: 2 }
              "
              [actionLabel]="'ui.toast.undo' | transloco"
            />
            <of-toast
              kind="info"
              [message]="
                'ui.showcase.states.exportReady' | transloco: { count: 1 }
              "
              [actionLabel]="'ui.showcase.states.download' | transloco"
            />
          </div>
          <div class="mt-auto flex flex-wrap gap-2">
            <button
              z-button
              zType="outline"
              zSize="sm"
              (click)="successToast()"
            >
              {{ 'ui.showcase.states.successUndo' | transloco }}
            </button>
            <button z-button zType="outline" zSize="sm" (click)="infoToast()">
              {{ 'ui.toast.kind.info' | transloco }}
            </button>
            <button
              z-button
              zType="outline"
              zSize="sm"
              (click)="warningToast()"
            >
              {{ 'ui.toast.kind.warning' | transloco }}
            </button>
            <button z-button zType="outline" zSize="sm" (click)="errorToast()">
              {{ 'ui.toast.kind.error' | transloco }}
            </button>
          </div>
        </section>
      </div>

      <h3 class="mt-4 text-base font-medium">
        {{ 'ui.showcase.states.listFrame' | transloco }}
      </h3>
      <div
        class="flex flex-wrap gap-2"
        role="group"
        [attr.aria-label]="'ui.showcase.states.listFrameState' | transloco"
      >
        @for (s of frameStates; track s.id) {
          <button
            z-button
            [zType]="state() === s.id ? 'default' : 'outline'"
            zSize="sm"
            [attr.aria-pressed]="state() === s.id"
            (click)="state.set(s.id)"
          >
            {{ s.label | transloco: { count: 1000 } }}
          </button>
        }
      </div>

      <of-list-frame
        [label]="'ui.showcase.states.exampleList' | transloco"
        offset="22rem"
        [emptyTitle]="'ui.showcase.states.noEntries' | transloco"
        [emptyDescription]="'ui.showcase.states.noEntriesHint' | transloco"
        [items]="items()"
        [page]="page()"
        [loading]="state() === 'loading'"
        [error]="error()"
        (retry)="state.set('rows')"
        [pageSizes]="pageSizes"
        (pageChange)="onPage($event)"
        (pageSizeChange)="pageSize.set($event)"
      >
        <ng-template ofListRow let-row>
          <div class="font-medium">{{ row.title }}</div>
          <div class="text-muted-foreground text-sm">{{ row.detail }}</div>
        </ng-template>
        <button
          ofListEmpty
          z-button
          zType="outline"
          (click)="state.set('rows')"
        >
          {{ 'ui.showcase.states.addEntry' | transloco }}
        </button>
      </of-list-frame>
    </section>
  `,
})
export class StatesShowcaseComponent {
  protected readonly card =
    'border-border flex min-h-[390px] min-w-0 flex-col gap-3 rounded-xl border p-6';
  protected readonly cardLabel = 'text-muted-foreground text-xs/5';
  protected readonly toasts = inject(ToastService);
  private readonly t = injectTranslate();

  protected readonly frameStates: { id: FrameState; label: string }[] = [
    { id: 'rows', label: 'ui.showcase.states.frame.rows' },
    { id: 'many', label: 'ui.showcase.states.frame.many' },
    { id: 'loading', label: 'ui.showcase.states.frame.loading' },
    { id: 'empty', label: 'ui.showcase.states.frame.empty' },
    { id: 'error', label: 'ui.showcase.states.frame.error' },
    { id: 'no-access', label: 'ui.showcase.states.frame.noAccess' },
  ];
  protected readonly state = signal<FrameState>('rows');
  private readonly pageNumber = signal(1);
  protected readonly pageSizes = [25, 50, 100, 1000];
  protected readonly pageSize = signal(25);
  protected readonly saveStatus = signal<SaveStatus>('saved');

  protected readonly items = computed(() => {
    switch (this.state()) {
      case 'rows':
        return makeRows(5, this.t);
      case 'many':
        return makeRows(1000, this.t);
      default:
        return [];
    }
  });

  protected readonly page = computed<ListFramePage>(() =>
    this.state() === 'many'
      ? {
          currentPage: this.pageNumber(),
          lastPage: 5,
          perPage: 1000,
          total: 5000,
        }
      : {
          currentPage: 1,
          lastPage: 1,
          perPage: this.pageSize(),
          total: this.items().length,
        },
  );

  protected readonly error = computed<ListFrameError | null>(() => {
    if (this.state() === 'error') {
      return {
        kind: 'unavailable',
        message: this.t('ui.showcase.states.busy'),
      };
    }
    if (this.state() === 'no-access') {
      return { kind: 'unauthorized', message: '' };
    }
    return null;
  });

  protected readonly undone = () =>
    this.toasts.show(translated('ui.showcase.states.restored'));

  protected successToast(): void {
    this.toasts.success(translated('ui.showcase.states.deleted'), {
      actionLabel: translated('ui.toast.undo'),
      onAction: this.undone,
    });
  }

  protected infoToast(): void {
    this.toasts.show(translated('ui.showcase.states.renamed'));
  }

  protected warningToast(): void {
    this.toasts.show(translated('ui.showcase.states.cannotUndo'), {
      kind: 'warning',
    });
  }

  protected errorToast(): void {
    this.toasts.error(translated('ui.showcase.states.couldNotSave'));
  }

  protected onPage(n: number): void {
    this.pageNumber.set(n);
  }

  protected cycleSave(): void {
    const order: SaveStatus[] = ['saved', 'saving', 'draft', 'not-saved'];
    this.saveStatus.set(
      order[(order.indexOf(this.saveStatus()) + 1) % order.length] ?? 'saved',
    );
  }
}
