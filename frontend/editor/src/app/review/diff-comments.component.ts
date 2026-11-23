import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucidePencil,
  lucideReply,
  lucideRotateCcw,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';

import { AvatarComponent } from '@openfolia/ui/avatar';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { injectTranslate, RelativeTimePipe } from '@openfolia/ui/i18n';
import { KbdComponent } from '@openfolia/ui/kbd';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import { toApiError } from '../api';
import { apiErrorText } from '../i18n';
import {
  ReviewComments,
  type Comment,
  type ModuleKey,
  type Thread,
} from './review-comments';

/** The longest comment the API takes. */
const BODY_MAX = 10_000;

/**
 * The review threads on one block, next to it (or, given `list`, the threads passed, as the
 * module's orphaned ones): each with who wrote it, what it is on (`anchor`), when, the text and
 * the replies, a reply box, and resolve or reopen; a resolved thread folds to one line. Below
 * them, while the person writes one, a new thread's box. Their own comments they edit in place
 * ("edited" next to the time once changed) or delete with Undo (`ReviewComments.remove`): a
 * thread's first comment with replies then reads "Comment deleted" above them; anything else
 * folds away. Writing is offered only to who may write (`ReviewComments.canWrite`) and is eager
 * (`ReviewComments`): a box closes on sending, the comment shows at once as being sent, and a
 * refusal puts the text back in its box. Ctrl or Cmd+Enter sends, Escape cancels.
 */
@Component({
  selector: 'of-diff-comments',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    RelativeTimePipe,
    AvatarComponent,
    CollapseComponent,
    KbdComponent,
    ZardButtonComponent,
    ZardTextareaComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucidePencil,
      lucideReply,
      lucideRotateCcw,
      lucideTrash2,
      lucideX,
    }),
  ],
  host: {
    class: 'flex min-w-0 flex-col gap-2 outline-none',
    tabindex: '-1',
  },
  template: `
    @for (thread of threads(); track thread.first.id) {
      @let resolved = !!thread.first.attributes.resolvedAt;
      @let open = !resolved || shownResolved().has(thread.first.id);
      @let firstGone = gone(thread.first);
      @let pending = comments.isPending(thread.first);
      <of-collapse [open]="!threadGone(thread)">
        <section
          class="bg-muted/70 animate-in fade-in-0 flex min-w-0 gap-3 rounded-lg px-3 py-2.5 text-sm transition-opacity duration-200 motion-reduce:animate-none motion-reduce:transition-none"
          [class.opacity-70]="resolved || pending"
          [attr.aria-label]="threadLabel(thread)"
          [attr.aria-busy]="
            (pending && !comments.isFailed(thread.first)) || null
          "
          [attr.data-thread]="thread.first.id"
          data-slot="thread"
        >
          <of-avatar class="mt-0.5" [name]="nameOf(thread.first)" />
          <div class="flex min-w-0 flex-1 flex-col">
            <header
              class="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-5"
            >
              <span class="break-words">{{ nameOf(thread.first) }}</span>
              @if (anchorFor(thread); as anchor) {
                <span aria-hidden="true">·</span>
                <span class="break-words" data-slot="anchor">{{ anchor }}</span>
              }
              <span aria-hidden="true">·</span>
              <ng-container
                *ngTemplateOutlet="when; context: { $implicit: thread.first }"
              />
              @if (resolved) {
                <span
                  class="border-border bg-background rounded-full border px-2"
                  >{{ 'editor.review.comments.resolved' | transloco }}</span
                >
              }
              @if (thread.first.meta.orphaned) {
                <span
                  class="border-border bg-background rounded-full border px-2"
                  data-slot="orphaned"
                  >{{ 'editor.review.comments.orphaned' | transloco }}</span
                >
              }
              @if (resolved) {
                <button
                  type="button"
                  class="hover:text-foreground focus-visible:ring-ring ms-auto rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2"
                  [attr.aria-expanded]="open"
                  (click)="toggleResolved(thread.first.id)"
                >
                  {{
                    (open
                      ? 'editor.review.comments.hide'
                      : 'editor.review.comments.show'
                    ) | transloco: { count: thread.replies.length + 1 }
                  }}
                </button>
              }
            </header>
            <of-collapse [open]="open">
              <div class="flex min-w-0 flex-col gap-2 pt-0.5">
                @if (firstGone) {
                  <p
                    class="text-muted-foreground m-0 italic"
                    data-slot="deleted"
                  >
                    {{ 'editor.review.comments.deleted' | transloco }}
                  </p>
                } @else {
                  <ng-container
                    *ngTemplateOutlet="
                      text;
                      context: { $implicit: thread.first, own: false }
                    "
                  />
                }
                @for (reply of thread.replies; track reply.id) {
                  <of-collapse [open]="!gone(reply)">
                    <div
                      class="animate-in fade-in-0 flex min-w-0 gap-2 pt-1 transition-opacity duration-200 motion-reduce:animate-none motion-reduce:transition-none"
                      [class.opacity-70]="comments.isPending(reply)"
                      [attr.aria-busy]="
                        (comments.isPending(reply) &&
                          !comments.isFailed(reply)) ||
                        null
                      "
                      data-slot="reply"
                    >
                      <of-avatar
                        class="mt-0.5"
                        size="sm"
                        [name]="nameOf(reply)"
                      />
                      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <p
                          class="text-muted-foreground m-0 flex flex-wrap items-center gap-x-1.5 text-xs leading-5"
                          data-slot="byline"
                        >
                          <span class="break-words">{{ nameOf(reply) }}</span>
                          <span aria-hidden="true">·</span>
                          <ng-container
                            *ngTemplateOutlet="
                              when;
                              context: { $implicit: reply }
                            "
                          />
                        </p>
                        <ng-container
                          *ngTemplateOutlet="
                            text;
                            context: { $implicit: reply, own: true }
                          "
                        />
                      </div>
                    </div>
                  </of-collapse>
                }
                @if (comments.canWrite() && !pending) {
                  @if (replying() === thread.first.id) {
                    <label class="flex flex-col gap-1">
                      <span class="sr-only">{{
                        'editor.review.comments.replyLabel' | transloco
                      }}</span>
                      <textarea
                        #replyBox
                        z-textarea
                        rows="2"
                        class="bg-background min-h-16 resize-y"
                        [maxLength]="max"
                        [placeholder]="
                          'editor.review.comments.replyHint' | transloco
                        "
                        [value]="draft()"
                        (input)="draft.set($any($event.target).value)"
                        (keydown.escape)="cancel()"
                        (keydown.control.enter)="sendReply(thread)"
                        (keydown.meta.enter)="sendReply(thread)"
                      ></textarea>
                    </label>
                    <div class="flex flex-wrap items-center gap-2">
                      <button
                        z-button
                        zSize="sm"
                        type="button"
                        [disabled]="!draft().trim()"
                        (click)="sendReply(thread)"
                      >
                        {{ 'editor.review.comments.reply' | transloco }}
                      </button>
                      <button
                        z-button
                        zSize="sm"
                        zType="ghost"
                        type="button"
                        (click)="cancel()"
                      >
                        {{ 'editor.review.comments.cancel' | transloco }}
                      </button>
                      <ng-container *ngTemplateOutlet="sendHint" />
                    </div>
                  } @else {
                    <div class="-ms-2 flex flex-wrap gap-1">
                      @if (editing() !== thread.first.id && !firstGone) {
                        <ng-container
                          *ngTemplateOutlet="
                            ownActions;
                            context: { $implicit: thread.first }
                          "
                        />
                      }
                      @if (!resolved) {
                        <button
                          z-button
                          zSize="xs"
                          zType="ghost"
                          type="button"
                          (click)="startReply(thread.first.id)"
                        >
                          <ng-icon name="lucideReply" aria-hidden="true" />
                          {{ 'editor.review.comments.reply' | transloco }}
                        </button>
                      }
                      <button
                        z-button
                        zSize="xs"
                        zType="ghost"
                        type="button"
                        [disabled]="comments.busy(thread.first.id)"
                        (click)="toggleState(thread, resolved)"
                      >
                        <ng-icon
                          [name]="resolved ? 'lucideRotateCcw' : 'lucideCheck'"
                          aria-hidden="true"
                        />
                        {{
                          (resolved
                            ? 'editor.review.comments.reopen'
                            : 'editor.review.comments.resolve'
                          ) | transloco
                        }}
                      </button>
                    </div>
                  }
                }
              </div>
            </of-collapse>
          </div>
        </section>
      </of-collapse>
    }
    <ng-template #when let-comment>
      @if (comments.isFailed(comment)) {
        <span class="text-destructive font-medium" data-slot="not-sent">{{
          'editor.review.comments.notSent' | transloco
        }}</span>
      } @else if (comments.isPending(comment)) {
        <span data-slot="sending">{{
          'editor.review.comments.sending' | transloco
        }}</span>
      } @else {
        <time [attr.datetime]="comment.attributes.createdAt">{{
          comment.attributes.createdAt | ofRelativeTime
        }}</time>
        @if (comment.meta.editedAt && !gone(comment)) {
          <span>{{ 'editor.review.comments.edited' | transloco }}</span>
        }
      }
    </ng-template>
    <ng-template #sendHint>
      <span
        class="text-muted-foreground hidden items-center gap-1 text-xs sm:inline-flex"
      >
        <kbd of-kbd>{{ modKey() }}</kbd><kbd of-kbd>↵</kbd>
        <span class="sr-only">{{
          'editor.review.comments.sendKey' | transloco
        }}</span>
      </span>
    </ng-template>
    <ng-template #text let-comment let-own="own">
      @if (editing() === comment.id) {
        <label class="flex flex-col gap-1">
          <span class="sr-only">{{
            'editor.review.comments.editLabel' | transloco
          }}</span>
          <textarea
            #editBox
            z-textarea
            rows="2"
            class="bg-background min-h-16 resize-y"
            [maxLength]="max"
            [value]="editDraft()"
            (input)="editDraft.set($any($event.target).value)"
            (keydown.escape)="cancelEdit()"
            (keydown.control.enter)="saveEdit(comment)"
            (keydown.meta.enter)="saveEdit(comment)"
          ></textarea>
        </label>
        <div class="flex flex-wrap items-center gap-2">
          <button
            z-button
            zSize="sm"
            type="button"
            [disabled]="!editDraft().trim()"
            (click)="saveEdit(comment)"
          >
            {{ 'editor.review.comments.save' | transloco }}
          </button>
          <button
            z-button
            zSize="sm"
            zType="ghost"
            type="button"
            (click)="cancelEdit()"
          >
            {{ 'editor.review.comments.cancel' | transloco }}
          </button>
          <ng-container *ngTemplateOutlet="sendHint" />
        </div>
      } @else {
        <p
          class="text-foreground m-0 leading-6 break-words whitespace-pre-line"
        >
          {{ comment.attributes.body }}
        </p>
        @if (comments.isFailed(comment)) {
          <div class="-ms-2 flex flex-wrap gap-1" data-slot="failed-actions">
            <button
              z-button
              zSize="xs"
              zType="ghost"
              type="button"
              (click)="retry(comment)"
            >
              <ng-icon name="lucideRotateCcw" aria-hidden="true" />
              {{ 'editor.review.comments.tryAgain' | transloco }}
            </button>
            <button
              z-button
              zSize="xs"
              zType="ghost"
              type="button"
              (click)="discard(comment)"
            >
              <ng-icon name="lucideX" aria-hidden="true" />
              {{ 'editor.review.comments.discard' | transloco }}
            </button>
          </div>
        }
        @if (own) {
          <div class="-ms-2 flex flex-wrap gap-1 empty:hidden">
            <ng-container
              *ngTemplateOutlet="ownActions; context: { $implicit: comment }"
            />
          </div>
        }
      }
    </ng-template>
    <ng-template #ownActions let-comment>
      @if (comments.mayChange(comment)) {
        <span class="contents" data-slot="own-actions">
          <button
            z-button
            zSize="xs"
            zType="ghost"
            type="button"
            (click)="startEdit(comment)"
          >
            <ng-icon name="lucidePencil" aria-hidden="true" />
            {{ 'editor.review.comments.edit' | transloco }}
          </button>
          <button
            z-button
            zSize="xs"
            zType="ghost"
            type="button"
            (click)="remove(comment)"
          >
            <ng-icon name="lucideTrash2" aria-hidden="true" />
            {{ 'editor.review.comments.delete' | transloco }}
          </button>
        </span>
      }
    </ng-template>
    @if (composingHere()) {
      <div
        class="bg-muted/70 animate-in fade-in-0 flex min-w-0 gap-3 rounded-lg px-3 py-2.5 motion-reduce:animate-none"
        data-slot="composer"
      >
        <of-avatar class="mt-0.5" [name]="myName()" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-muted-foreground text-xs">
              {{ 'editor.review.comments.newLabel' | transloco }}
              @if (anchor(); as a) {
                · {{ a }}
              }
            </span>
            <textarea
              #newBox
              z-textarea
              rows="3"
              class="bg-background min-h-20 resize-y"
              [maxLength]="max"
              [placeholder]="'editor.review.comments.newHint' | transloco"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.escape)="cancel()"
              (keydown.control.enter)="sendNew()"
              (keydown.meta.enter)="sendNew()"
            ></textarea>
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <button
              z-button
              zSize="sm"
              type="button"
              [disabled]="!draft().trim()"
              (click)="sendNew()"
            >
              {{ 'editor.review.comments.send' | transloco }}
            </button>
            <button
              z-button
              zSize="sm"
              zType="ghost"
              type="button"
              (click)="cancel()"
            >
              {{ 'editor.review.comments.cancel' | transloco }}
            </button>
            <ng-container *ngTemplateOutlet="sendHint" />
          </div>
        </div>
      </div>
    }
  `,
})
export class DiffCommentsComponent {
  protected readonly comments = inject(ReviewComments);
  private readonly t = injectTranslate();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The module (`<lang>/<moduleId>`) and block the threads are on. */
  readonly module = input.required<ModuleKey>();
  readonly blockId = input('');
  /** What the threads are on, in words ("on: Paragraph"); null: not said. */
  readonly anchor = input<string | null>(null);
  /** The threads to show in place of the block's (the module's orphaned ones). */
  readonly list = input<readonly Thread[] | null>(null);
  /** What each of `list`'s threads is on, by its block ID. */
  readonly anchorOf = input<(blockId: string) => string | null>(() => null);

  protected readonly max = BODY_MAX;
  /** The modifier Ctrl or Cmd+Enter is sent with, as this device names it. */
  protected readonly modKey = computed(() =>
    this.t(
      typeof navigator !== 'undefined' &&
        /Mac|iPhone|iPad/.test(navigator.platform ?? '')
        ? 'editor.review.comments.cmdKey'
        : 'editor.review.comments.ctrlKey',
    ),
  );
  protected readonly draft = signal('');
  /** The thread a reply is being written to. */
  protected readonly replying = signal<string | null>(null);
  /** The comment being edited, and its text. */
  protected readonly editing = signal<string | null>(null);
  protected readonly editDraft = signal('');
  /** Resolved threads opened. */
  protected readonly shownResolved = signal<ReadonlySet<string>>(new Set());

  protected readonly threads = computed(
    () =>
      this.list() ??
      this.comments.threadsOf(this.module()).get(this.blockId()) ??
      [],
  );

  protected readonly composingHere = computed(() => {
    const at = this.comments.composing();
    return (
      this.list() === null &&
      this.comments.canWrite() &&
      at?.module === this.module() &&
      at.blockId === this.blockId()
    );
  });

  protected readonly myName = computed(() => {
    const me = this.comments.me();
    return me ? this.comments.nameOf()(me.kind, me.id) : '';
  });

  private readonly newBox = viewChild('newBox', {
    read: ElementRef<HTMLTextAreaElement>,
  });
  private readonly replyBox = viewChild('replyBox', {
    read: ElementRef<HTMLTextAreaElement>,
  });
  private readonly editBox = viewChild('editBox', {
    read: ElementRef<HTMLTextAreaElement>,
  });

  constructor() {
    // A new thread started here closes a reply being written (they share the draft); asked for
    // again while open, the box keeps what was typed.
    let composed = false;
    effect(() => {
      const here = this.composingHere();
      untracked(() => {
        if (here && !composed) {
          this.replying.set(null);
          this.draft.set('');
        }
        composed = here;
      });
    });
    // A box that opens takes the focus.
    afterRenderEffect(() => {
      this.newBox()?.nativeElement.focus({ preventScroll: false });
    });
    afterRenderEffect(() => {
      this.replyBox()?.nativeElement.focus({ preventScroll: false });
    });
    afterRenderEffect(() => {
      this.editBox()?.nativeElement.focus({ preventScroll: false });
    });
  }

  /** Deleted, or deleted here and waiting for its Undo window: shown as gone. */
  protected gone(comment: Comment): boolean {
    return comment.meta.deleted || this.comments.deleting().has(comment.id);
  }

  /** Nothing of the thread is left to read: its first comment and every reply gone. */
  protected threadGone(thread: Thread): boolean {
    return this.gone(thread.first) && thread.replies.every((r) => this.gone(r));
  }

  protected anchorFor(thread: Thread): string | null {
    return this.list()
      ? this.anchorOf()(thread.first.attributes.blockId)
      : this.anchor();
  }

  protected startEdit(comment: Comment): void {
    this.editDraft.set(comment.attributes.body ?? '');
    this.editing.set(comment.id);
  }

  protected cancelEdit(): void {
    this.editing.set(null);
    this.editDraft.set('');
  }

  protected saveEdit(comment: Comment): void {
    const body = this.editDraft().trim();
    if (!body) return;
    this.cancelEdit();
    this.keepFocus();
    if (body !== comment.attributes.body)
      this.comments.edit(this.module(), comment.id, body);
  }

  /** Deletes one's own comment, with Undo in a toast; the request goes when the toast ends. */
  protected remove(comment: Comment): void {
    if (this.editing() === comment.id) this.cancelEdit();
    this.keepFocus();
    this.comments.remove(this.module(), comment.id, (failure) =>
      this.failure('editor.review.comments.deleteFailed', failure),
    );
  }

  /** A failed write's toast: what did not happen, and the API's reason. */
  private failure(key: string, error: unknown): string {
    const text = apiErrorText(toApiError(error));
    return `${this.t(key)} ${this.t(text.key, text.params)}`;
  }

  protected nameOf(comment: {
    attributes: Thread['first']['attributes'];
  }): string {
    const a = comment.attributes.author;
    return this.comments.nameOf()(a.kind, a.id);
  }

  protected threadLabel(thread: Thread): string {
    return this.t('editor.review.comments.threadBy', {
      name: this.nameOf(thread.first),
    });
  }

  protected toggleResolved(id: string): void {
    this.shownResolved.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected startReply(threadId: string): void {
    this.comments.composing.set(null);
    this.draft.set('');
    this.replying.set(threadId);
  }

  protected cancel(): void {
    this.draft.set('');
    this.replying.set(null);
    if (this.composingHere()) this.comments.composing.set(null);
    this.keepFocus();
  }

  protected sendNew(): void {
    const body = this.draft().trim();
    if (!body) return;
    this.draft.set('');
    this.comments.composing.set(null);
    this.keepFocus();
    this.comments.start(this.module(), this.blockId(), body);
  }

  protected sendReply(thread: Thread): void {
    const body = this.draft().trim();
    if (!body) return;
    this.draft.set('');
    this.replying.set(null);
    this.keepFocus();
    this.comments.reply(this.module(), thread.first.id, body);
  }

  /** A refused comment sent once more; the focus stays with the threads. */
  protected retry(comment: Comment): void {
    this.keepFocus();
    this.comments.retry(comment.id);
  }

  /** A refused comment dropped; the focus stays with the threads. */
  protected discard(comment: Comment): void {
    this.keepFocus();
    this.comments.discard(comment.id);
  }

  protected toggleState(thread: Thread, resolved: boolean): void {
    this.comments.resolve(this.module(), thread.first.id, resolved);
  }

  /** A box about to close had the focus: it stays with the threads, not lost to the page. */
  private keepFocus(): void {
    const host = this.host.nativeElement;
    if (host.contains(document.activeElement))
      host.focus({ preventScroll: true });
  }
}
