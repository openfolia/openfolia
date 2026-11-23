import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  model,
  output,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircle,
  lucideCircleCheck,
  lucideCircleDot,
  lucideArrowUpRight,
  lucideEllipsis,
  lucideHistory,
  lucidePencil,
  lucideUserCheck,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { injectTranslate, RelativeTimePipe } from '@openfolia/ui/i18n';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import { auditLogLink, READ_AUDIT_LOG } from '../admin/audit/audit-model';

import { ChecksSummaryComponent } from '../checks/checks-summary.component';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import {
  ChangeSetRenameComponent,
  type ChangeSetRename,
} from '../session/change-set-rename.component';
import { ChangeSetUpdateComponent } from '../session/change-set-update.component';
import { MaintenanceLines } from '../session/maintenance-lines';
import {
  selfApprovalOpen,
  signOffType,
  transitionStates,
  type ChangeSet,
  type ReviewMeta,
  type TransitionName,
} from './review-model';

/** One line of the approvals card. */
interface Step {
  readonly key: string;
  readonly label: string;
  /** `done`: met; `current`: what the change set waits for now; `later`: after that. */
  readonly status: 'done' | 'current' | 'later';
  readonly detail: string;
  readonly at?: string;
}

/** The permission each transition's route needs, for the guard. */
const PERMISSIONS: Readonly<Record<TransitionName, string>> = {
  submit: 'content.edit',
  return: 'content.review',
  approve: 'content.review',
  'sign-off': 'content.approve',
  merge: 'release.publish',
};

/** The longest comment the API takes. */
export const COMMENT_MAX = 10_000;

/**
 * The review's side panel (screen 4): the change set's description, renamed in place by its
 * author while it is open (Escape leaves it as it was), the approvals the change set needs and who gave them, what
 * happens once it is approved, the review comment and the transitions the person may make now.
 * A transition the role can never make is not shown; one blocked now is disabled with the reason.
 */
@Component({
  selector: 'of-review-panel',
  imports: [
    FadeInDirective,
    TranslocoPipe,
    NgIcon,
    RelativeTimePipe,
    ZardSkeletonComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardDropdownImports,
    ZardTextareaComponent,
    GuardDirective,
    ChecksSummaryComponent,
    ChangeSetRenameComponent,
    ChangeSetUpdateComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircle,
      lucideCircleCheck,
      lucideCircleDot,
      lucideArrowUpRight,
      lucideEllipsis,
      lucideHistory,
      lucidePencil,
      lucideUserCheck,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <section
      class="border-border flex flex-col gap-2.5 rounded-xl border p-3.5"
      aria-labelledby="review-details"
    >
      <div class="flex items-center gap-1">
        <h2
          id="review-details"
          class="m-0 me-auto text-sm leading-5 font-medium"
        >
          {{ 'editor.review.panel.details' | transloco }}
        </h2>
        @if (canRename() && !renaming()) {
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            [ofGuard]="{ permission: 'content.edit' }"
            (click)="renaming.set(true)"
          >
            <ng-icon
              name="lucidePencil"
              data-icon="inline-start"
              strokeWidth="1.5"
              aria-hidden="true"
            />
            {{ 'editor.changeSet.rename' | transloco }}
          </button>
        }
        @if (canReadAudit()) {
          <button
            z-button
            zType="ghost"
            zSize="icon-sm"
            type="button"
            data-slot="review-actions"
            z-dropdown
            [zDropdownMenu]="reviewMenu"
            [attr.aria-label]="'editor.review.panel.actions' | transloco"
            [attr.title]="'editor.review.panel.actions' | transloco"
          >
            <ng-icon name="lucideEllipsis" aria-hidden="true" />
          </button>
          <z-dropdown-menu-content #reviewMenu class="w-56">
            <z-dropdown-menu-item
              data-slot="review-audit"
              (click)="showInAuditLog()"
            >
              <ng-icon name="lucideHistory" aria-hidden="true" />
              {{ 'editor.admin.audit.showIn' | transloco }}
            </z-dropdown-menu-item>
          </z-dropdown-menu-content>
        }
      </div>
      @if (renaming()) {
        <of-change-set-rename
          ofFadeIn
          [title]="changeSet().attributes.title"
          [description]="changeSet().attributes.description"
          (save)="saveRename($event)"
          (dismissed)="renaming.set(false)"
        />
      } @else {
        <p
          class="m-0 text-[0.8125rem] leading-5 break-words whitespace-pre-line"
          [class.text-muted-foreground]="!changeSet().attributes.description"
        >
          {{
            changeSet().attributes.description ||
              ('editor.review.panel.noDescription' | transloco)
          }}
        </p>
      }
      <div class="hidden min-w-0 has-[button]:flex">
        <of-change-set-update
          [changeSetId]="changeSet().id"
          [title]="changeSet().attributes.title"
          [state]="changeSet().attributes.state"
          [authorId]="changeSet().attributes.author.id"
          [known]="{
            behind: changeSet().meta?.behind,
            baseRef: changeSet().attributes.baseRef,
            rewritten: changeSet().meta?.base?.state === 'rewritten',
          }"
        />
      </div>
    </section>

    <section
      class="border-border flex flex-col gap-3 rounded-xl border p-3.5"
      aria-labelledby="review-approvals"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2
          id="review-approvals"
          class="m-0 me-auto text-sm leading-5 font-medium"
        >
          {{ 'editor.review.panel.approvals' | transloco }}
        </h2>
        @if (review()?.selfApproved) {
          <z-badge
            ofFadeIn
            zType="secondary"
            class="gap-1"
            data-slot="self-approved"
          >
            <ng-icon name="lucideUserCheck" aria-hidden="true" />
            {{ 'editor.review.panel.selfApproved' | transloco }}
          </z-badge>
        }
      </div>
      @if (reviewLoading() && !review()) {
        <div class="flex flex-col gap-3" aria-hidden="true">
          @for (n of [1, 2]; track n) {
            <div class="flex gap-2.5">
              <z-skeleton class="mt-1 size-2.5 shrink-0 rounded-full" />
              <div class="flex flex-1 flex-col gap-1.5">
                <z-skeleton class="h-4 w-2/3" />
                <z-skeleton class="h-3 w-full" />
              </div>
            </div>
          }
        </div>
      } @else {
        <ol ofFadeIn class="m-0 flex list-none flex-col gap-2.5 p-0">
          @for (step of steps(); track step.key) {
            <li class="flex gap-2.5">
              <ng-icon
                [name]="icon(step.status)"
                class="mt-0.5 size-4 shrink-0"
                [class.text-info]="step.status === 'current'"
                [class.text-success]="step.status === 'done'"
                [class.text-muted-foreground]="step.status === 'later'"
                aria-hidden="true"
              />
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="text-sm leading-5 break-words">{{
                  step.label
                }}</span>
                <span
                  class="text-muted-foreground text-xs leading-[1.125rem] break-words"
                >
                  {{ step.detail }}
                  @if (step.at) {
                    · {{ step.at | ofRelativeTime }}
                  }
                </span>
              </div>
            </li>
          }
        </ol>
      }
    </section>

    <of-checks-summary [changeSetId]="changeSet().id" />

    <section
      class="border-border flex flex-col gap-2.5 rounded-xl border p-3.5"
      aria-labelledby="review-after"
    >
      <h2 id="review-after" class="m-0 text-sm leading-5 font-medium">
        {{ afterTitle() | transloco }}
      </h2>
      <p
        class="text-muted-foreground m-0 text-[0.8125rem] leading-5 break-words"
      >
        {{ afterText() }}
      </p>
      @if (carryable()) {
        <!-- A fix merged into an older product version: offered to main too, never automatic. -->
        <button
          z-button
          zType="outline"
          type="button"
          class="h-auto min-h-9 max-w-full self-start py-1.5 text-start whitespace-normal"
          data-slot="carry-forward"
          ofFadeIn
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason: carrying()
              ? 'editor.carryForward.carryingReason'
              : null,
          }"
          [attr.aria-busy]="carrying() ? 'true' : null"
          (click)="carryForward.emit()"
        >
          <ng-icon
            name="lucideArrowUpRight"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.carryForward.action' | transloco }}
        </button>
      }
    </section>

    @if (anyTransition()) {
      @if (selfOpen()) {
        <p
          ofFadeIn
          class="text-muted-foreground bg-muted m-0 rounded-lg px-3 py-2 text-[0.8125rem] leading-5 break-words"
          data-slot="self-approval-note"
          role="note"
        >
          {{ selfNote() | transloco }}
        </p>
      }
      <label class="flex flex-col gap-1">
        <span class="text-muted-foreground text-xs leading-5">{{
          'editor.review.panel.comment' | transloco
        }}</span>
        <textarea
          z-textarea
          rows="3"
          class="min-h-20 resize-y"
          [maxLength]="commentMax"
          [placeholder]="'editor.review.panel.commentHint' | transloco"
          [value]="comment()"
          (input)="comment.set($any($event.target).value)"
        ></textarea>
      </label>
      <div class="flex flex-wrap gap-2">
        @for (name of order; track name) {
          @let s = states()[name];
          @if (s.kind !== 'hidden') {
            <button
              z-button
              type="button"
              [zType]="buttonType(name)"
              [class]="buttonClass(name)"
              [ofGuard]="{
                permission: permissionOf(name),
                blockedReason: s.kind === 'disabled' ? s.reason : null,
              }"
              (click)="transition.emit(name)"
            >
              {{ labelOf(name) | transloco }}
            </button>
          }
        }
      </div>
    }
  `,
})
export class ReviewPanelComponent {
  private readonly me = inject(MeService);
  private readonly router = inject(Router);
  private readonly t = injectTranslate();
  private readonly lines = inject(MaintenanceLines);

  readonly changeSet = input.required<ChangeSet>();
  readonly review = input<ReviewMeta | null>(null);
  readonly reviewLoading = input(false);
  /** A transition is on its way: the buttons wait for it. */
  readonly busy = input(false);
  /** Names a person or service by its ID (`kind/id`). */
  readonly nameOf = input<(kind: string, id: string) => string>((_, id) => id);
  /** Names a module type by its ID (the configuration's label). */
  readonly typeLabel = input<(id: string) => string>((id) => id);

  /** The person may rename it: its author, while it is open. */
  readonly canRename = input(false);

  /** Carrying it forward to main is on its way (#250). */
  readonly carrying = input(false);

  readonly comment = model('');
  readonly transition = output<TransitionName>();
  /** "Carry forward to current": a fix merged into a maintenance line, to main too. */
  readonly carryForward = output<void>();
  /** A new title and description, to be saved. */
  readonly renamed = output<ChangeSetRename>();

  /** The details are being edited in place; another change set shown is not. */
  protected readonly renaming = linkedSignal({
    source: () => this.changeSet().id,
    computation: () => false,
  });

  protected readonly commentMax = COMMENT_MAX;
  /** Left to right: the one that sends back first, the one that moves forward last. */
  protected readonly order: readonly TransitionName[] = [
    'return',
    'submit',
    'sign-off',
    'approve',
    'merge',
  ];

  protected readonly states = computed(() =>
    transitionStates(
      this.me.me(),
      this.changeSet(),
      this.review(),
      this.comment(),
      this.busy(),
    ),
  );

  /** Its author may approve it themselves: four eyes is off for this installation (#588). */
  protected readonly selfOpen = computed(() =>
    selfApprovalOpen(this.me.me(), this.changeSet(), this.review()),
  );

  protected readonly selfNote = computed(() =>
    this.review()?.selfApproval === 'review-and-sign-off'
      ? 'editor.review.panel.selfNoteAll'
      : 'editor.review.panel.selfNoteReview',
  );

  protected readonly anyTransition = computed(() =>
    Object.values(this.states()).some((s) => s.kind !== 'hidden'),
  );

  protected readonly steps = computed((): Step[] => {
    const cs = this.changeSet().attributes;
    const review = this.review();
    const required = review?.required ?? ['review'];
    const out: Step[] = [];
    let waiting = false;
    for (const requirement of required) {
      const type = signOffType(requirement);
      const label =
        type === undefined
          ? this.t('editor.review.panel.review')
          : this.t('editor.review.panel.signOff', {
              type: this.typeLabel()(type),
            });
      // Only an approval that still holds meets it; a lapsed one is named, counting for nothing.
      const lapsed = review?.lapsed.find((a) => a.requirement === requirement);
      const approval = review?.approvals.find(
        (a) =>
          a.requirement === requirement &&
          !review.lapsed.some(
            (l) =>
              l.requirement === a.requirement &&
              l.approver.kind === a.approver.kind &&
              l.approver.id === a.approver.id,
          ),
      );
      if (approval) {
        out.push({
          key: requirement,
          label,
          status: 'done',
          detail: this.t(
            approval.self
              ? 'editor.review.panel.approvedBySelf'
              : 'editor.review.panel.approvedBy',
            {
              name: this.nameOf()(approval.approver.kind, approval.approver.id),
            },
          ),
          at: approval.at,
        });
        continue;
      }
      const current: boolean = cs.state === 'in-review' && !waiting;
      waiting ||= current;
      out.push({
        key: requirement,
        label,
        status: current ? 'current' : 'later',
        detail: lapsed
          ? this.t('editor.review.panel.lapsed', {
              name: this.nameOf()(lapsed.approver.kind, lapsed.approver.id),
            })
          : this.t(
              cs.state === 'in-review'
                ? type === undefined
                  ? 'editor.review.panel.waitingReviewer'
                  : 'editor.review.panel.waitingApprover'
                : cs.state === 'draft'
                  ? 'editor.review.panel.onceSubmitted'
                  : 'editor.review.panel.notGiven',
            ),
      });
    }
    const merged = cs.state === 'merged';
    out.push({
      key: 'merge',
      label: this.t('editor.review.panel.merge'),
      status: merged ? 'done' : cs.state === 'approved' ? 'current' : 'later',
      detail: this.t(
        merged
          ? 'editor.review.panel.merged'
          : cs.state === 'approved'
            ? 'editor.review.panel.readyToMerge'
            : 'editor.review.panel.mergeLater',
        { ref: this.lines.label(cs.baseRef) },
      ),
      ...(merged ? { at: cs.updatedAt } : {}),
    });
    return out;
  });

  protected readonly afterTitle = computed(() =>
    this.changeSet().attributes.state === 'merged'
      ? 'editor.review.panel.afterMergeTitle'
      : 'editor.review.panel.afterTitle',
  );

  protected readonly afterText = computed(() => {
    const cs = this.changeSet().attributes;
    switch (cs.state) {
      case 'merged':
        return this.lines.lineOf(cs.baseRef)
          ? this.t('editor.review.panel.afterMergedLine', {
              ref: this.lines.label(cs.baseRef),
            })
          : this.t('editor.review.panel.afterMerged', {
              ref: this.lines.label(cs.baseRef),
            });
      case 'abandoned':
        return this.t('editor.review.panel.afterAbandoned');
      default:
        return this.t('editor.review.panel.afterText', {
          ref: this.lines.label(cs.baseRef),
        });
    }
  });

  /**
   * Merged into a maintenance line: "Carry forward to current" is offered (#250), to whoever may
   * edit content (the API lets its author, or an editor covering all it changed, carry it).
   */
  protected readonly carryable = computed(() => {
    const cs = this.changeSet().attributes;
    return cs.state === 'merged' && this.lines.lineOf(cs.baseRef) !== null;
  });

  /** An admin reads the audit log: the panel's menu with "Show in audit log" shows. */
  protected readonly canReadAudit = computed(() =>
    this.me.me().permissions.has(READ_AUDIT_LOG),
  );

  /** The audit log with only this change set's events. */
  protected showInAuditLog(): void {
    const { commands, queryParams } = auditLogLink({
      type: 'change-set',
      id: this.changeSet().id,
    });
    void this.router.navigate(commands, { queryParams });
  }

  protected saveRename(change: ChangeSetRename): void {
    this.renaming.set(false);
    this.renamed.emit(change);
  }

  protected icon(status: Step['status']): string {
    return status === 'done'
      ? 'lucideCircleCheck'
      : status === 'current'
        ? 'lucideCircleDot'
        : 'lucideCircle';
  }

  protected permissionOf(name: TransitionName): string {
    return PERMISSIONS[name];
  }

  protected buttonType(name: TransitionName): 'default' | 'outline' {
    return name === 'return' ? 'outline' : 'default';
  }

  protected buttonClass(name: TransitionName): string {
    return name === 'return'
      ? 'grow basis-auto border-destructive text-destructive hover:bg-destructive-muted hover:text-destructive dark:border-destructive'
      : 'grow basis-auto';
  }

  protected labelOf(name: TransitionName): string {
    return {
      submit: 'editor.review.actions.submit',
      return: 'editor.review.actions.return',
      approve: 'editor.review.actions.approve',
      'sign-off': 'editor.review.actions.signOff',
      merge: 'editor.review.actions.merge',
    }[name];
  }
}
