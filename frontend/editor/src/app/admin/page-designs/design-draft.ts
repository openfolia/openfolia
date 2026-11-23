import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import {
  EmptyError,
  firstValueFrom,
  Subject,
  takeUntil,
  timeout,
  TimeoutError,
  type Observable,
} from 'rxjs';

import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../../api';
import { MeService } from '../../permissions/me';
import { PermissionService } from '../../permissions/permission.service';
import { injectFailureText } from '../../session/failure-text';
import type { DesignIssue, PageDesign } from './design-model';

/** The change set a design is read in (and changed in, when the person may). */
export interface DesignChangeSet {
  readonly id: string;
  readonly branch: string;
  readonly state: string;
  /** Who started it; empty while unknown (the API then decides). */
  readonly authorId: string;
}

/** Whether the design can be changed now, and if not, why (a key; null: the role never can). */
export type DesignMode =
  | { readonly kind: 'edit' }
  | { readonly kind: 'read'; readonly reason: string | null };

/** How long the design stays unchanged before the working copy becomes a save point. */
export const DESIGN_SAVE_POINT_DELAY_MS = 30_000;
/**
 * How long a save point may take before it is given up (its request cancelled): a navigation
 * waiting for it then shows that it stalled, with a retry, instead of loading for ever (#557).
 */
export const DESIGN_SAVE_POINT_TIMEOUT_MS = 20_000;
/** How long a failed create waits for its lock to be released (best effort) before it says so. */
const RELEASE_TIMEOUT_MS = 10_000;
/** The most changes Undo walks back. */
export const UNDO_DEPTH = 50;

/** How a save point ended: made (or nothing to make), refused, or given up after the timeout. */
type SavePointOutcome = 'done' | 'failed' | 'timeout';

/** Statuses that leave a write's outcome unknown: no answer, or a gateway's. */
const UNKNOWN_OUTCOME = new Set([0, 502, 503, 504]);

/**
 * One page design as the design screen edits it (#392), provided per screen: read in the chosen
 * change set, its working copy when the person may change it there (a draft they started, not
 * locked by another change set; the API asks for an unrestricted `content.edit`), else what is
 * committed, read-only with the reason. A new design (`createDesign`) is its working copy, written
 * like any other project file's (#390): the lock first, then the save; no save path of its own.
 *
 * Saving is eager: a change shows at once (`design`) and is saved into the working copy, one save
 * at a time with the newest design; each save counts `saves`, which the preview follows. Undo puts
 * back the design before the last change (and saves it). A refusal puts back the last saved
 * design with a toast. After a quiet `DESIGN_SAVE_POINT_DELAY_MS`, and when the screen is left
 * (`savePoint`), the working copy becomes a save point. Nothing of an earlier `load` applies
 * after a newer one.
 */
@Injectable()
export class DesignDraft {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  /** `stalled`: the save point before a navigation took too long (`DESIGN_SAVE_POINT_TIMEOUT_MS`); loading again retries. */
  readonly status = signal<
    'idle' | 'loading' | 'ready' | 'missing' | 'error' | 'stalled'
  >('idle');
  readonly error = signal<ApiError | null>(null);
  readonly design = signal<PageDesign | null>(null);
  readonly mode = signal<DesignMode>({ kind: 'read', reason: null });
  /** The working copy's state since this screen changed it; null before the first change. */
  readonly saveState = signal<'saved' | 'saving' | 'not-saved' | null>(null);
  /** The problems the API found in the design as last read or saved. */
  readonly issues = signal<readonly DesignIssue[]>([]);
  /** Counts the saves of the working copy: the preview renders again after each. */
  readonly saves = signal(0);
  /** Whether what the preview reads is the working copy (else the branch's file). */
  readonly live = signal(false);
  private readonly history = signal<readonly PageDesign[]>([]);
  readonly canUndo = computed(
    () =>
      this.history().length > 0 &&
      this.mode().kind === 'edit' &&
      this.status() === 'ready',
  );

  private generation = 0;
  /** Counts `load` calls: a later call supersedes one still waiting for its save point. */
  private loads = 0;
  private changeSet: DesignChangeSet | null = null;
  private designId = '';
  /** The design last saved (or read): what a refusal puts back. */
  private confirmed: PageDesign | null = null;
  /** The undo history as it was while `confirmed` was shown: what a refusal puts back with it. */
  private confirmedHistory: readonly PageDesign[] = [];
  /** The history to go with `target` once it is saved. */
  private targetHistory: readonly PageDesign[] = [];
  /**
   * The `loads` number of a navigation waiting for its save point; 0: none. Meanwhile no read
   * of the design shown before shows it (#557): the page shows the target as loading.
   */
  private navigating = 0;
  /**
   * A navigation gave up waiting for its save point (`stalled`): until a newer load, nothing of
   * the design before shows again, as while it waited.
   */
  private stalled = false;
  /** Cancels the saves and save points under way: a navigation gave up waiting for them. */
  private readonly abandon = new Subject<void>();
  private version = 0;
  private baseCommit = '';
  private lockHeld = false;
  private uncommitted = false;
  private target: PageDesign | null = null;
  private draining = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private edits = 0;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.generation++;
      clearTimeout(this.timer);
    });
  }

  /**
   * An identity switch is unanswered (#716): nothing of the person before is sent under the next
   * one, so a change still to send and its save point are dropped, a load waiting for that save
   * point no longer counts, and nothing is editable until the next person's `load`.
   */
  forget(): void {
    this.generation++;
    this.loads++;
    clearTimeout(this.timer);
    this.target = null;
    this.draining = false;
    if (this.saveState() === 'saving') this.saveState.set('not-saved');
    if (this.mode().kind === 'edit') {
      this.mode.set({
        kind: 'read',
        reason: 'editor.changeSet.switchingReason',
      });
    }
  }

  /** Whether the person may ever change designs (the API also asks for an unrestricted scope). */
  readonly mayEdit = computed(
    () =>
      this.permissions.state({ permission: 'content.edit' }).kind !== 'hidden',
  );

  /**
   * Reads the design `designId` in `changeSet` (null: the released content); a design that is
   * nowhere is `missing`. Never rejects.
   */
  async load(
    changeSet: DesignChangeSet | null,
    designId: string,
    /** Reading the shown design again after a refusal: no navigation, so a load waiting for its save point still wins. */
    again = false,
  ): Promise<void> {
    if (this.destroyed) return;
    // The last load called wins, whichever waits longest below.
    const mine = again ? this.loads : ++this.loads;
    // Another design or change set: what is saved of this one, and a change still to send,
    // becomes a save point first (the screen is reused when only the design's ID changes).
    // Nothing more is taken meanwhile: the page shows it is loading.
    const elsewhere =
      changeSet?.id !== this.changeSet?.id || designId !== this.designId;
    if (again && this.leaving()) return;
    // Back to the design a navigation is leaving (waiting or stalled): its unsent change and save
    // point first too.
    if (
      (elsewhere || this.leaving()) &&
      this.changeSet &&
      this.mode().kind === 'edit'
    ) {
      this.status.set('loading');
      this.navigating = mine;
      // The save point sends a change left unsent first (a stalled navigation cancelled it).
      const outcome = await this.withinDeadline(mine, this.savePointOutcome());
      if (this.destroyed || mine !== this.loads) return;
      this.navigating = 0;
      if (outcome === 'timeout') {
        // Still on the design before: loading the target again retries its save point.
        this.stalled = true;
        this.status.set('stalled');
        return;
      }
    }
    // The last load called wins: one still waiting for its save point no longer counts.
    this.navigating = 0;
    this.stalled = false;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.changeSet = changeSet;
    this.designId = designId;
    this.target = null;
    this.draining = false;
    this.lockHeld = false;
    this.uncommitted = false;
    this.chain = Promise.resolve();
    this.history.set([]);
    this.saveState.set(null);
    this.status.set('loading');
    this.error.set(null);
    this.live.set(false);
    // A read answering while a navigation waits would show the design it leaves.
    const stale = () => generation !== this.generation || this.leaving();
    try {
      const reason = this.readReason(changeSet);
      if (reason !== undefined || !changeSet) {
        const committed = await this.committed(changeSet);
        if (stale()) return;
        if (!committed) {
          this.status.set('missing');
          return;
        }
        this.show(committed.design, committed.issues, {
          kind: 'read',
          reason: reason ?? null,
        });
        return;
      }
      const [copy, locks] = await Promise.all([
        firstValueFrom(
          this.api.get(
            '/change-sets/{changeSetId}/page-designs/{designId}/working-copy',
            { path: { changeSetId: changeSet.id, designId } },
          ),
        ).catch((error: unknown) => {
          const failure = toApiError(error);
          if (failure.status === 404) return 'none' as const;
          if (failure.status === 403) return 'forbidden' as const;
          throw failure;
        }),
        firstValueFrom(
          this.api.get('/locks', {
            query: { 'filter[subject]': `design/${designId}` },
          }),
        ).catch(() => null),
      ]);
      if (stale()) return;
      const lock = locks?.data[0];
      const lockedElsewhere =
        !!lock && lock.relationships.changeSet.data.id !== changeSet.id;
      this.lockHeld = !!lock && !lockedElsewhere;
      if (copy === 'forbidden') {
        const committed = await this.committed(changeSet);
        if (stale()) return;
        if (!committed) {
          this.status.set('missing');
          return;
        }
        this.show(committed.design, committed.issues, {
          kind: 'read',
          reason: 'editor.admin.pageDesigns.blocked.forbidden',
        });
        return;
      }
      const mode: DesignMode = lockedElsewhere
        ? { kind: 'read', reason: 'editor.admin.pageDesigns.blocked.locked' }
        : { kind: 'edit' };
      if (copy === 'none') {
        this.status.set('missing');
        return;
      }
      this.version = copy.data.attributes.version;
      this.baseCommit = copy.data.attributes.baseCommit;
      this.uncommitted = copy.data.meta.saved;
      this.live.set(copy.data.meta.saved);
      this.show(copy.data.attributes.content, copy.data.meta.issues, mode);
      if (this.uncommitted && !lockedElsewhere) this.schedule();
    } catch (error) {
      if (stale()) return;
      this.error.set(toApiError(error));
      this.status.set('error');
    }
  }

  /** Whether a navigation waits for its save point, or gave up on it: the design shown is being left. */
  private leaving(): boolean {
    return this.navigating !== 0 || this.stalled;
  }

  /**
   * `saving` (the saves and save points queued before it, which a navigation waits for) within
   * `DESIGN_SAVE_POINT_TIMEOUT_MS` of now; else `timeout`, and what is under way is cancelled
   * while the navigation `mine` is still the one waiting.
   */
  private async withinDeadline(
    mine: number,
    saving: Promise<SavePointOutcome>,
  ): Promise<SavePointOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        DESIGN_SAVE_POINT_TIMEOUT_MS,
      );
    });
    const outcome = await Promise.race([saving, expired]);
    clearTimeout(timer);
    // Only for the navigation still waiting: a newer load's saves are its own (#557).
    if (
      outcome === 'timeout' &&
      mine === this.loads &&
      this.navigating === mine
    ) {
      this.abandon.next();
    }
    return outcome;
  }

  /** An API call that a navigation giving up cancels (it then rejects with `EmptyError`). */
  private ask<T>(request: Observable<T>): Promise<T> {
    return firstValueFrom(request.pipe(takeUntil(this.abandon)));
  }

  /** The design as committed at the change set's branch (or released), with its issues; null: none. */
  private async committed(
    changeSet: DesignChangeSet | null,
  ): Promise<{ design: PageDesign; issues: readonly DesignIssue[] } | null> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/page-designs/{designId}', {
          path: { designId: this.designId },
          ...(changeSet ? { query: { ref: changeSet.branch } } : {}),
        }),
      );
      return {
        design: { ...doc.data.attributes, id: doc.data.id } as PageDesign,
        issues: doc.data.meta.issues,
      };
    } catch (error) {
      const failure = toApiError(error);
      if (failure.status === 404) return null;
      throw failure;
    }
  }

  /** Why the design is read-only in this change set (a key), null if the role never edits, undefined if they may. */
  private readReason(
    changeSet: DesignChangeSet | null,
  ): string | null | undefined {
    if (!this.mayEdit()) return null;
    if (!changeSet) return 'editor.admin.pageDesigns.blocked.needsChangeSet';
    if (changeSet.state !== 'draft') {
      return 'editor.admin.pageDesigns.blocked.notDraft';
    }
    if (changeSet.authorId !== '' && changeSet.authorId !== this.me.me().id) {
      return 'editor.admin.pageDesigns.blocked.notAuthor';
    }
    return undefined;
  }

  private show(
    design: PageDesign,
    issues: readonly DesignIssue[],
    mode: DesignMode,
  ): void {
    this.confirmed = design;
    this.confirmedHistory = [];
    this.design.set(design);
    this.issues.set(issues);
    this.mode.set(mode);
    this.status.set('ready');
  }

  /** Shows `next` at once and saves it into the working copy (only once read, to edit). */
  change(next: PageDesign): boolean {
    if (this.destroyed || this.status() !== 'ready') return false;
    if (this.mode().kind !== 'edit') return false;
    const before = this.design();
    if (!before || JSON.stringify(before) === JSON.stringify(next))
      return false;
    this.history.update((h) => [...h, before].slice(-UNDO_DEPTH));
    this.send(next);
    return true;
  }

  /** Puts back the design before the last change, and saves it. */
  undo(): void {
    if (!this.canUndo()) return;
    const h = this.history();
    const previous = h[h.length - 1];
    if (!previous) return;
    this.history.set(h.slice(0, -1));
    this.send(previous);
  }

  private send(next: PageDesign): void {
    clearTimeout(this.timer);
    this.edits++;
    this.design.set(next);
    this.target = next;
    this.targetHistory = this.history();
    this.saveState.set('saving');
    this.drainLater();
  }

  /** Sends `target` (after the jobs queued before), unless that is under way already. */
  private drainLater(): void {
    if (!this.target || this.draining) return;
    this.draining = true;
    const generation = this.generation;
    void this.enqueue(() => this.drain(generation));
  }

  /** Makes the saved working copy a save point now (after the saves before it); resolves whether nothing is left uncommitted. */
  async savePoint(): Promise<boolean> {
    return (await this.savePointOutcome()) === 'done';
  }

  private savePointOutcome(): Promise<SavePointOutcome> {
    clearTimeout(this.timer);
    if (this.destroyed) return Promise.resolve('failed');
    const generation = this.generation;
    return this.enqueue(() => this.commit(generation));
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    // A navigation makes its own save point; a stalled one, its retry.
    if (this.destroyed || this.leaving()) return;
    this.timer = setTimeout(
      () => void this.savePoint(),
      DESIGN_SAVE_POINT_DELAY_MS,
    );
  }

  private get subject() {
    return { type: 'design' as const, designId: this.designId };
  }

  private async drain(generation: number): Promise<void> {
    const stale = () => generation !== this.generation;
    const changeSet = this.changeSet;
    if (!changeSet) return;
    while (this.target && !stale()) {
      const sending = this.target;
      const sendingHistory = this.targetHistory;
      this.target = null;
      try {
        if (!this.lockHeld) {
          await this.takeLock(changeSet);
          if (stale()) return;
          this.lockHeld = true;
        }
        const doc = await this.ask(
          this.api.put(
            '/change-sets/{changeSetId}/page-designs/{designId}/working-copy',
            { path: { changeSetId: changeSet.id, designId: this.designId } },
            {
              data: { type: 'WorkingCopy', attributes: { content: sending } },
              meta: { version: this.version, baseCommit: this.baseCommit },
            },
          ),
        );
        if (stale()) return;
        this.version = doc.data.attributes.version;
        this.baseCommit = doc.data.attributes.baseCommit;
        this.confirmed = sending;
        this.confirmedHistory = sendingHistory;
        this.uncommitted = true;
        this.live.set(true);
        // Only the newest design's issues: one still to send has its own.
        if (!this.target) this.issues.set(doc.data.meta.issues);
        this.saves.update((n) => n + 1);
      } catch (error) {
        if (stale()) return;
        this.draining = false;
        if (error instanceof EmptyError) {
          // Cancelled by a navigation giving up: sent again before its retry's save point.
          if (!this.target) {
            this.target = sending;
            this.targetHistory = sendingHistory;
          }
          this.saveState.set('not-saved');
          return;
        }
        this.refused(sending, toApiError(error));
        return;
      }
    }
    if (stale()) return;
    this.draining = false;
    this.saveState.set('saved');
    this.schedule();
  }

  /** A save was refused: the last saved design comes back, and the person is told why. */
  private refused(sending: PageDesign, failure: ApiError): void {
    const newest = this.target ?? sending;
    this.target = null;
    if (this.confirmed) {
      // The history as it was with what is saved: a refused change is no step to undo, and a
      // refused undo keeps the step it tried to take (#557).
      this.design.set(this.confirmed);
      this.history.set(this.confirmedHistory);
    }
    this.saveState.set('not-saved');
    if (this.uncommitted) this.schedule();
    const what: TranslatedText = translated(
      'editor.admin.pageDesigns.save.failed',
    );
    if (failure.code === 'lock-required') this.lockHeld = false;
    if (failure.code === 'locked') {
      this.mode.set({
        kind: 'read',
        reason: 'editor.admin.pageDesigns.blocked.locked',
      });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (failure.status === 403) {
      this.mode.set({
        kind: 'read',
        reason: 'editor.admin.pageDesigns.blocked.forbidden',
      });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (
      failure.code === 'version-conflict' ||
      failure.code === 'stale-working-copy' ||
      UNKNOWN_OUTCOME.has(failure.status)
    ) {
      this.toast.error(translated('editor.admin.pageDesigns.save.reloaded'));
      void this.load(this.changeSet, this.designId, true);
      return;
    }
    const generation = this.generation;
    const edits = this.edits;
    this.toast.error(this.failureText(what, failure), {
      actionLabel: translated('editor.session.retry'),
      onAction: () => {
        // A newer change since is saved on its own: retrying would undo it.
        if (generation === this.generation && edits === this.edits) {
          this.change(newest);
        }
      },
    });
  }

  private async takeLock(
    changeSet: DesignChangeSet,
    within?: number,
  ): Promise<void> {
    const request = this.api.post(
      '/change-sets/{changeSetId}/locks',
      { data: { type: 'Lock', attributes: { subject: this.subject } } },
      { path: { changeSetId: changeSet.id } },
    );
    await this.ask(
      within === undefined ? request : request.pipe(timeout(within)),
    );
  }

  private async commit(generation: number): Promise<SavePointOutcome> {
    const changeSet = this.changeSet;
    if (generation !== this.generation || !changeSet) return 'failed';
    // A change left unsent (its save cancelled by a navigation that gave up) is sent first, so
    // no save point is made, or answers 'done', without it.
    if (this.target && !this.draining) {
      this.draining = true;
      await this.drain(generation);
      if (generation !== this.generation) return 'failed';
      // Cancelled again: the navigation gave up once more.
      if (this.target && !this.draining) return 'timeout';
    }
    if (!this.uncommitted) return 'done';
    // One deadline for the lock and the commit; a request still open then is cancelled.
    const deadline = Date.now() + DESIGN_SAVE_POINT_TIMEOUT_MS;
    const left = () => Math.max(0, deadline - Date.now());
    try {
      if (!this.lockHeld) {
        await this.takeLock(changeSet, left());
        if (generation !== this.generation) return 'failed';
        this.lockHeld = true;
      }
      // No time left for the commit: never sent, rather than sent and cancelled at once.
      if (left() === 0) throw new TimeoutError();
      const doc = (await this.ask(
        this.api
          .post(
            '/change-sets/{changeSetId}/commits',
            {
              data: {
                type: 'Commit',
                attributes: {
                  subjects: [this.subject],
                  message: `Update the page design ${this.designId}`,
                },
              },
            },
            { path: { changeSetId: changeSet.id } },
          )
          .pipe(timeout(left())),
      )) as Schema<'CommitDocument'> | Schema<'NoCommitDocument'>;
      if (generation !== this.generation) return 'failed';
      this.baseCommit = 'data' in doc ? doc.data.id : doc.meta.head;
      this.version = 0;
      this.uncommitted = false;
      return 'done';
    } catch (error) {
      if (generation !== this.generation) return 'failed';
      // Cancelled by a navigation giving up: it says so itself.
      if (error instanceof EmptyError) return 'timeout';
      if (error instanceof TimeoutError) {
        // The commit may still have gone through: what the design is now is unknown. A navigation
        // waiting shows it stalled (its retry commits again, which answers the head either way);
        // otherwise the design is read again, as after any answer that was lost.
        if (!this.leaving()) {
          this.toast.error(
            translated('editor.admin.pageDesigns.save.savePointTimedOut'),
          );
          // After the saves queued meanwhile: a change made while it hung is sent first.
          void this.enqueue(async () => {
            if (generation === this.generation && !this.leaving()) {
              void this.load(this.changeSet, this.designId, true);
            }
          });
        }
        return 'timeout';
      }
      const failure = toApiError(error);
      const what = translated('editor.admin.pageDesigns.save.savePointFailed');
      if (failure.code === 'locked') {
        this.mode.set({
          kind: 'read',
          reason: 'editor.admin.pageDesigns.blocked.locked',
        });
        this.toast.error(this.failureText(what, failure));
        return 'failed';
      }
      if (failure.code === 'lock-required') this.lockHeld = false;
      if (
        failure.code === 'lock-required' ||
        failure.code === 'version-conflict' ||
        failure.code === 'stale-working-copy'
      ) {
        this.toast.error(translated('editor.admin.pageDesigns.save.reloaded'));
        void this.load(this.changeSet, this.designId, true);
        return 'failed';
      }
      this.toast.error(this.failureText(what, failure), {
        actionLabel: translated('editor.session.retry'),
        onAction: () => {
          // Only for the design it failed for: another one shown since has its own.
          if (generation === this.generation) void this.savePoint();
        },
      });
      return 'failed';
    }
  }
}

/**
 * Makes a new page design in `changeSetId` as any project file is made (#390): takes its lock,
 * then saves its first working copy on the change set's base commit. Rejects with the API's error
 * (`ApiError`); `locked` when another change set holds it. A first save that fails releases the
 * lock again (#557): only a lock it took (not one the change set held before, in another tab),
 * and only while the change set has no changes to the design (`ifUnchanged`: a save whose answer
 * was lost may have gone through, and then the lock stays with it); best effort, the save's error
 * is what rejects.
 */
export async function createDesign(
  api: ApiClient,
  changeSetId: string,
  design: PageDesign,
): Promise<void> {
  let lockId: string | null = null;
  try {
    const [changeSet, before] = await Promise.all([
      firstValueFrom(
        api.get('/change-sets/{changeSetId}', { path: { changeSetId } }),
      ),
      // A lock the change set holds already (another tab of the author's) is not this one's to
      // free; unknown (the read failed), none is freed.
      firstValueFrom(
        api.get('/locks', {
          query: { 'filter[subject]': `design/${design.id}` },
        }),
      ).catch(() => null),
    ]);
    const lock = await firstValueFrom(
      api.post(
        '/change-sets/{changeSetId}/locks',
        {
          data: {
            type: 'Lock',
            attributes: { subject: { type: 'design', designId: design.id } },
          },
        },
        { path: { changeSetId } },
      ),
    );
    if (before && !before.data.some((l) => l.id === lock.data.id)) {
      lockId = lock.data.id;
    }
    await firstValueFrom(
      api.put(
        '/change-sets/{changeSetId}/page-designs/{designId}/working-copy',
        { path: { changeSetId, designId: design.id } },
        {
          data: { type: 'WorkingCopy', attributes: { content: design } },
          meta: {
            version: 0,
            baseCommit: changeSet.data.attributes.baseCommit,
          },
        },
      ),
    );
  } catch (error) {
    if (lockId !== null) {
      const id = lockId;
      await firstValueFrom(
        api
          .delete('/locks/{lockId}', {
            path: { lockId: id },
            query: { ifUnchanged: 'true' },
          })
          .pipe(timeout(RELEASE_TIMEOUT_MS)),
      ).catch(() => undefined);
    }
    throw toApiError(error);
  }
}
