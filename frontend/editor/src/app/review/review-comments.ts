import { HttpClient } from '@angular/common/http';
import {
  computed,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';

import {
  injectTranslate,
  translated,
  type Translatable,
} from '@openfolia/ui/i18n';
import { ToastService, type ToastCloseReason } from '@openfolia/ui/toast';

import {
  API_BASE_URL,
  ApiClient,
  pageQuery,
  toApiError,
  type Schema,
} from '../api';
import { JSON_API } from '../api/api-config';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import { retryableFailure } from './review-model';

export type Comment = Schema<'CommentResource'>;

/** A thread on a block: its first comment and the replies, oldest first. */
export interface Thread {
  readonly first: Comment;
  readonly replies: readonly Comment[];
}

/** A module of the change set, as comments name it: `<lang>/<moduleId>`. */
export type ModuleKey = string;

/** Comments read per page, and at most this many pages for one module. */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/** Where a new thread is being written: a module's block. */
export interface Composing {
  readonly module: ModuleKey;
  readonly blockId: string;
}

/** The IDs of comments shown before the API has them start with this. */
const PENDING = 'pending:';

/** A write shown before the API has answered it. */
type OpInput =
  | {
      readonly kind: 'start';
      readonly module: ModuleKey;
      readonly blockId: string;
      readonly body: string;
    }
  | {
      readonly kind: 'reply';
      readonly module: ModuleKey;
      readonly threadId: string;
      readonly body: string;
    }
  | {
      readonly kind: 'state';
      readonly module: ModuleKey;
      readonly threadId: string;
      readonly resolved: boolean;
    }
  | {
      readonly kind: 'edit';
      readonly module: ModuleKey;
      readonly commentId: string;
      readonly body: string;
    };
/** Being sent; taken by the API (shown until a later read has it); refused (a new comment). */
type OpStatus = 'sending' | 'sent' | 'failed';
type Op = OpInput & {
  readonly id: string;
  readonly at: string;
  readonly author: Person;
  readonly changeSetId: string;
  readonly send: () => Observable<unknown>;
  readonly status: OpStatus;
  /** Once sent: dropped when a read numbered this or later is applied. */
  readonly sentBefore: number;
};

/** What a refused write's toast says did not happen. */
const failedKey = (op: OpInput): string => {
  switch (op.kind) {
    case 'start':
    case 'reply':
      return 'editor.review.comments.sendFailed';
    case 'state':
      return op.resolved
        ? 'editor.review.comments.resolveFailed'
        : 'editor.review.comments.reopenFailed';
    case 'edit':
      return 'editor.review.comments.editFailed';
  }
};
/** Who is acting, as comments name their author. */
export interface Person {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

/**
 * The review threads of the change set shown (`GET /change-sets/:id/comments`), per module and
 * block, read when a module's diff asks for them; and writing them: a new thread on a block, a
 * reply, resolving and reopening, and editing or deleting one's own comment. Threads whose block
 * a later save point removed (`meta.orphaned`) are kept apart (`orphansOf`). Writes are eager:
 * they show at once (a new comment marked as being sent) and the module's threads are read
 * again after each, so what is shown is what the API holds. A refusal is said in a toast (Retry
 * where it can help): a new comment then stays, "Not sent", with Try again and Discard; a state
 * change or an edit goes back to what it was. Deleting offers Undo
 * instead of asking first: the comment goes from view at once and the request is sent only when
 * the toast ends (its time ran out, or it was closed); Undo just keeps it. Provided by the
 * review page, which names the change set, who is acting and whether they may write (its
 * author, or a reviewer, while it is open). The threads are the acting person's: another person
 * (a demo switch, a sign-in) forgets them, as another change set does, and a read answered after
 * the change never lands (#716).
 */
@Injectable()
export class ReviewComments {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly toast = inject(ToastService);
  /** Who is acting app-wide: a delete waiting for its toast may outlive the page. */
  private readonly acting = inject(MeService);
  private readonly t = injectTranslate();

  /** The change set the comments are of; '' for none. */
  readonly changeSetId = signal('');
  /** The person may start, answer, resolve and reopen threads here. */
  readonly canWrite = signal(false);
  /** Who is acting: only their own comments are theirs to edit and delete. */
  readonly me = signal<Person | null>(null);
  /** How a person is named (the page's lookup). */
  readonly nameOf = signal<(kind: string, id: string) => string>((_, id) => id);

  private readonly threads = signal<ReadonlyMap<ModuleKey, readonly Thread[]>>(
    new Map(),
  );
  private readonly reads = new Map<ModuleKey, Promise<void>>();
  /** The latest read of each module: an older one that answers later is dropped. */
  private readonly latest = new Map<ModuleKey, number>();
  private readNumber = 0;
  private readonly failedModules = signal<ReadonlySet<ModuleKey>>(new Set());

  /** The block a new thread is being written on (one at a time on the page). */
  readonly composing = signal<Composing | null>(null);

  /** Writes shown before the API has answered them, in the order they were made. */
  private readonly ops = signal<readonly Op[]>([]);
  private opNumber = 0;

  /** Comments deleted here whose request waits for its Undo window, or is under way. */
  private readonly deletingIds = signal<ReadonlySet<string>>(new Set());
  readonly deleting = this.deletingIds.asReadonly();

  private readonly resetCount = signal(0);
  /** Counts the resets (another change set or person): the diffs read their threads again. */
  readonly resets = this.resetCount.asReadonly();

  constructor() {
    // Read before anyone was known (start-up, `/me` not answered): with the identity `/me` then
    // confirms, so theirs, as in `ChangeSetSession`.
    let acting = untracked(() => this.acting.me().id);
    effect(() => {
      const id = this.acting.me().id;
      untracked(() => {
        if (acting !== '' && acting !== id) this.reset(this.changeSetId());
        acting = id;
      });
    });
  }

  /** A comment shown before the API has it (sent, or refused): nothing else can be done with it. */
  isPending(comment: Comment): boolean {
    return comment.id.startsWith(PENDING);
  }

  /** A change of the thread's state waits for the API's answer. */
  busy(threadId: string): boolean {
    return this.ops().some(
      (o) => o.kind === 'state' && o.threadId === threadId,
    );
  }

  /** The person may edit and delete `comment`: theirs, not deleted, while they may write. */
  mayChange(comment: Comment): boolean {
    const me = this.me();
    const author = comment.attributes.author;
    return (
      this.canWrite() &&
      !this.isPending(comment) &&
      !this.ops().some(
        (o) => o.kind === 'edit' && o.commentId === comment.id,
      ) &&
      !comment.meta.deleted &&
      !!me &&
      author.kind === me.kind &&
      author.id === me.id
    );
  }

  /**
   * A module's threads on blocks still there (resolved ones included), by block ID, once `load`
   * has read them, with the writes not answered yet.
   */
  threadsOf(module: ModuleKey): ReadonlyMap<string, readonly Thread[]> {
    return this.grouped().get(module)?.blocks ?? EMPTY;
  }

  /** A module's threads whose block a later save point removed (`meta.orphaned`). */
  orphansOf(module: ModuleKey): readonly Thread[] {
    return this.grouped().get(module)?.orphans ?? NO_THREADS;
  }

  /** A module's threads have been read (once at least). */
  loaded(module: ModuleKey): boolean {
    return this.threads().has(module);
  }

  /** A module's threads could not be read. */
  failed(module: ModuleKey): boolean {
    return this.failedModules().has(module);
  }

  private readonly grouped = computed(() => {
    const threads = this.threads();
    const ops = this.ops();
    const modules = new Set([...threads.keys(), ...ops.map((o) => o.module)]);
    const out = new Map<
      ModuleKey,
      { blocks: Map<string, Thread[]>; orphans: Thread[] }
    >();
    for (const module of modules) {
      const list = withOps(
        threads.get(module) ?? NO_THREADS,
        ops.filter((o) => o.module === module),
        this.changeSetId(),
      );
      const blocks = new Map<string, Thread[]>();
      const orphans: Thread[] = [];
      for (const thread of list) {
        if (thread.first.meta.orphaned) {
          orphans.push(thread);
          continue;
        }
        const id = thread.first.attributes.blockId;
        blocks.set(id, [...(blocks.get(id) ?? []), thread]);
      }
      out.set(module, { blocks, orphans });
    }
    return out;
  });

  /** Forgets every thread (another change set, another person). */
  reset(changeSetId: string): void {
    this.changeSetId.set(changeSetId);
    this.resetCount.update((n) => n + 1);
    this.threads.set(new Map());
    this.reads.clear();
    this.latest.clear();
    this.failedModules.set(new Set());
    this.composing.set(null);
    this.ops.set([]);
  }

  /**
   * Deletes one's own comment, Undo instead of a confirm: it goes from view at once (a thread's
   * first comment with replies shows as deleted), a toast offers Undo, and
   * `DELETE …/comments/:id` is sent when the toast ends. A refusal brings it back, said in a
   * toast (`failed` builds its text from the API's error).
   */
  remove(
    module: ModuleKey,
    commentId: string,
    failed: (error: ReturnType<typeof toApiError>) => Translatable,
  ): void {
    if (this.deletingIds().has(commentId)) return;
    const changeSetId = this.changeSetId();
    const person = this.me();
    this.deletingIds.update((s) => new Set(s).add(commentId));
    this.toast.success(translated('editor.review.comments.deletedToast'), {
      actionLabel: translated('ui.toast.undo'),
      onAction: () => this.forget(commentId),
      onClose: (reason: ToastCloseReason) => {
        if (reason !== 'action')
          void this.send(changeSetId, module, commentId, person, failed);
      },
    });
  }

  private async send(
    changeSetId: string,
    module: ModuleKey,
    commentId: string,
    person: Person | null,
    failed: (error: ReturnType<typeof toApiError>) => Translatable,
  ): Promise<void> {
    // Someone else acting now (a demo switch, maybe after leaving the page): not theirs to
    // delete, so nothing is sent. Another change set shown meanwhile still gets its delete: the
    // request names the change set it was asked on.
    const now = this.acting.me();
    if (!person || now.kind !== person.kind || now.id !== person.id) {
      this.forget(commentId);
      return;
    }
    try {
      await firstValueFrom(
        this.api.delete('/change-sets/{changeSetId}/comments/{commentId}', {
          path: { changeSetId, commentId },
        }),
      );
    } catch (error) {
      const failure = toApiError(error);
      // Gone already (another tab): what was asked for.
      if (failure.status !== 404) this.toast.error(failed(failure));
    }
    // Shown as deleted (or back, when refused) only once the threads are read again.
    if (this.changeSetId() === changeSetId)
      await this.load(module, true).catch(() => undefined);
    this.forget(commentId);
  }

  private forget(commentId: string): void {
    this.deletingIds.update((s) => {
      const next = new Set(s);
      next.delete(commentId);
      return next;
    });
  }

  /** Reads a module's threads again (or for the first time). */
  load(module: ModuleKey, again = false): Promise<void> {
    const changeSetId = this.changeSetId();
    if (!changeSetId) return Promise.resolve();
    const running = this.reads.get(module);
    if (running && !again) return running;
    const number = ++this.readNumber;
    this.latest.set(module, number);
    // Read for whoever acts now: another person's answer is not theirs, even before the reset.
    const who = untracked(() => this.acting.me().id);
    const current = () =>
      this.changeSetId() === changeSetId &&
      this.latest.get(module) === number &&
      (who === '' || untracked(() => this.acting.me().id) === who);
    const read = this.read(changeSetId, module).then(
      (list) => {
        if (!current()) return;
        this.threads.update((m) => new Map(m).set(module, list));
        // What this read holds replaces the writes the API had taken before it started.
        this.ops.update((ops) =>
          ops.filter(
            (o) =>
              !(
                o.module === module &&
                o.status === 'sent' &&
                o.sentBefore <= number
              ),
          ),
        );
        this.failedModules.update((s) => {
          const next = new Set(s);
          next.delete(module);
          return next;
        });
      },
      () => {
        if (!current()) return;
        this.reads.delete(module);
        this.failedModules.update((s) => new Set(s).add(module));
      },
    );
    this.reads.set(module, read);
    return read;
  }

  private async read(
    changeSetId: string,
    module: ModuleKey,
  ): Promise<Thread[]> {
    const comments: Comment[] = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const doc = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}/comments', {
          path: { changeSetId },
          query: {
            'filter[module]': module,
            'filter[resolved]': 'any',
            ...pageQuery({ number, size: PAGE_SIZE }),
          },
        }),
      );
      comments.push(...doc.data);
      if (number >= (doc.meta.page.lastPage ?? 1)) break;
    }
    return threadsFrom(comments);
  }

  /** Starts a thread on a block, eagerly: it shows at once, marked as being sent. */
  start(module: ModuleKey, blockId: string, body: string): void {
    const [lang, moduleId] = splitModule(module);
    const changeSetId = this.changeSetId();
    this.eager({ kind: 'start', module, blockId, body }, () =>
      this.api.post(
        '/change-sets/{changeSetId}/comments',
        {
          data: {
            type: 'Comment',
            attributes: {
              body,
              blockId,
              subject: { type: 'module', lang, moduleId },
            },
          },
        },
        { path: { changeSetId } },
      ),
    );
  }

  /** Answers a thread, eagerly (as `start`). */
  reply(module: ModuleKey, threadId: string, body: string): void {
    const changeSetId = this.changeSetId();
    this.eager({ kind: 'reply', module, threadId, body }, () =>
      this.api.post(
        '/change-sets/{changeSetId}/comments',
        {
          data: {
            type: 'Comment',
            attributes: { body },
            relationships: {
              thread: { data: { type: 'Comment', id: threadId } },
            },
          },
        },
        { path: { changeSetId } },
      ),
    );
  }

  /** Resolves (or, `open`, reopens) a thread, eagerly: it folds (or opens) at once. */
  resolve(module: ModuleKey, threadId: string, open: boolean): void {
    // Neither route takes a body: posted as they are.
    const e = encodeURIComponent;
    const url = `${this.base}/change-sets/${e(this.changeSetId())}/comments/${e(threadId)}/${open ? 'reopen' : 'resolve'}`;
    this.eager({ kind: 'state', module, threadId, resolved: !open }, () =>
      this.http.post(url, null, {
        headers: { Accept: JSON_API, 'Content-Type': JSON_API },
      }),
    );
  }

  /** Changes one's own comment's text, eagerly: the new text shows at once. */
  edit(module: ModuleKey, commentId: string, body: string): void {
    const changeSetId = this.changeSetId();
    this.eager({ kind: 'edit', module, commentId, body }, () =>
      this.api.patch(
        '/change-sets/{changeSetId}/comments/{commentId}',
        { path: { changeSetId, commentId } },
        { data: { type: 'Comment', id: commentId, attributes: { body } } },
      ),
    );
  }

  /** A new comment that was refused: sent once more (its "Try again", or the toast's Retry). */
  retry(commentId: string): void {
    const op = this.ops().find((o) => o.id === commentId);
    if (op?.status === 'failed' && this.mayAct(op)) this.dispatch(op);
  }

  /** A new comment that was refused: dropped. */
  discard(commentId: string): void {
    this.ops.update((list) =>
      list.filter((o) => !(o.id === commentId && o.status === 'failed')),
    );
  }

  /** The comment was refused and is kept, "Not sent", until tried again or discarded. */
  isFailed(comment: Comment): boolean {
    return this.ops().some((o) => o.id === comment.id && o.status === 'failed');
  }

  /**
   * A write, eagerly: `input` is shown at once and the request sent (`dispatch`). It stays shown
   * until a read of the module that started after the API took it is applied, so what shows next
   * is what the API holds, with no gap between.
   */
  private eager(input: OpInput, send: () => Observable<unknown>): void {
    const changeSetId = this.changeSetId();
    const me = this.me();
    if (!changeSetId || !me || !this.canWrite()) return;
    const op: Op = {
      ...input,
      id: `${PENDING}${++this.opNumber}`,
      at: new Date().toISOString(),
      author: me,
      changeSetId,
      send,
      status: 'sending',
      sentBefore: 0,
    };
    this.ops.update((list) => [...list, op]);
    this.dispatch(op);
  }

  /**
   * Sends a write. A refusal says why in a toast, with Retry where trying again can help; a new
   * comment then stays shown as "Not sent" (so its text is never lost, and no box the person is
   * writing in is taken over), anything else goes back to what it was.
   */
  private dispatch(op: Op): void {
    this.setStatus(op.id, 'sending');
    // Forgotten since (another change set or person): its answer is nobody's to show.
    const resets = untracked(this.resetCount);
    const forgotten = () =>
      this.changeSetId() !== op.changeSetId ||
      untracked(this.resetCount) !== resets;
    void firstValueFrom(op.send()).then(
      () => {
        if (forgotten()) return;
        // Dropped once a read that starts from here on is applied.
        this.setStatus(op.id, 'sent', this.readNumber + 1);
        void this.load(op.module, true).catch(() => undefined);
      },
      (error: unknown) => {
        if (forgotten()) return;
        const kept = op.kind === 'start' || op.kind === 'reply';
        if (kept) this.setStatus(op.id, 'failed');
        else this.drop(op.id);
        const failure = toApiError(error);
        const reason = apiErrorText(failure);
        this.toast.error(
          `${this.t(failedKey(op))} ${this.t(reason.key, reason.params)}`,
          retryableFailure(failure)
            ? {
                actionLabel: translated('editor.session.retry'),
                onAction: () => (kept ? this.retry(op.id) : this.again(op)),
              }
            : {},
        );
        // What the API holds now (a thread resolved meanwhile, a comment gone).
        void this.load(op.module, true).catch(() => undefined);
      },
    );
  }

  /** A refused state change or edit, sent once more unless it no longer changes anything. */
  private again(op: Op): void {
    if (!this.mayAct(op) || this.ops().some((o) => o.id === op.id)) return;
    if (op.kind === 'state') {
      const thread = [...this.threadsOf(op.module).values()]
        .flat()
        .find((t) => t.first.id === op.threadId);
      // Gone, or toggled by hand since: the person's later choice stands.
      if (!thread || !!thread.first.attributes.resolvedAt === op.resolved)
        return;
    }
    const next: Op = { ...op, at: new Date().toISOString() };
    this.ops.update((list) => [...list, next]);
    this.dispatch(next);
  }

  /** A write may go (again): same change set, same person acting, who may still write. */
  private mayAct(op: Op): boolean {
    const now = this.acting.me();
    return (
      this.changeSetId() === op.changeSetId &&
      this.canWrite() &&
      now.kind === op.author.kind &&
      now.id === op.author.id
    );
  }

  private setStatus(id: string, status: OpStatus, sentBefore = 0): void {
    this.ops.update((list) =>
      list.map((o) => (o.id === id ? { ...o, status, sentBefore } : o)),
    );
  }

  private drop(id: string): void {
    this.ops.update((list) => list.filter((o) => o.id !== id));
  }
}

const EMPTY: ReadonlyMap<string, readonly Thread[]> = new Map();
const NO_THREADS: readonly Thread[] = [];

/** The threads as the API holds them, with the writes not answered yet applied in order. */
function withOps(
  threads: readonly Thread[],
  ops: readonly Op[],
  changeSetId: string,
): readonly Thread[] {
  if (ops.length === 0) return threads;
  let list = [...threads];
  const update = (
    threadId: string,
    change: (thread: Thread) => Thread,
  ): void => {
    list = list.map((t) => (t.first.id === threadId ? change(t) : t));
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'start':
        list.push({
          first: pendingComment(op, op.id, op.blockId, changeSetId),
          replies: [],
        });
        break;
      case 'reply':
        update(op.threadId, (t) => ({
          ...t,
          replies: [
            ...t.replies,
            pendingComment(
              op,
              op.threadId,
              t.first.attributes.blockId,
              changeSetId,
            ),
          ],
        }));
        break;
      case 'state':
        update(op.threadId, (t) => ({
          ...t,
          first: {
            ...t.first,
            attributes: {
              ...t.first.attributes,
              resolvedAt: op.resolved ? op.at : null,
              resolvedBy: op.resolved ? op.author : null,
            },
          },
        }));
        break;
      case 'edit': {
        const edited = (c: Comment): Comment =>
          c.id === op.commentId
            ? {
                ...c,
                attributes: { ...c.attributes, body: op.body },
                meta: { ...c.meta, editedAt: op.at },
              }
            : c;
        list = list.map((t) => ({
          first: edited(t.first),
          replies: t.replies.map(edited),
        }));
        break;
      }
    }
  }
  return list;
}

/** A new comment as shown until the API has it. */
function pendingComment(
  op: Op & { readonly body: string },
  threadId: string,
  blockId: string,
  changeSetId: string,
): Comment {
  const [lang, moduleId] = splitModule(op.module);
  return {
    type: 'Comment',
    id: op.id,
    attributes: {
      subject: { type: 'module', lang, moduleId },
      blockId,
      body: op.body,
      author: op.author,
      commit: '',
      createdAt: op.at,
      resolvedAt: null,
      resolvedBy: null,
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: changeSetId } },
      thread: { data: { type: 'Comment', id: threadId } },
    },
    meta: { orphaned: false, deleted: false, editedAt: null },
  };
}

/** `<lang>/<moduleId>` as its two parts. */
export function splitModule(module: ModuleKey): [string, string] {
  const at = module.indexOf('/');
  return [module.slice(0, at), module.slice(at + 1)];
}

/** Comments in thread order (each thread followed by its replies) as threads. */
export function threadsFrom(comments: readonly Comment[]): Thread[] {
  const threads = new Map<string, { first: Comment; replies: Comment[] }>();
  for (const c of comments) {
    const threadId = c.relationships.thread.data.id;
    if (threadId === c.id) threads.set(c.id, { first: c, replies: [] });
  }
  for (const c of comments) {
    const threadId = c.relationships.thread.data.id;
    if (threadId !== c.id) threads.get(threadId)?.replies.push(c);
  }
  return [...threads.values()];
}
