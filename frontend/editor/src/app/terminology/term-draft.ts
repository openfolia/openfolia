import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { injectFailureText } from '../session/failure-text';
import { contentOf, type TermContent } from './terms-model';

/** The change set a term is read in (and changed in, when the person may). */
export interface TermChangeSet {
  readonly id: string;
  readonly branch: string;
  readonly state: string;
  /** Who started it; empty while unknown (the API then decides). */
  readonly authorId: string;
}

/** Whether the term can be changed now, and if not, why (a key; null: the role never can). */
export type TermMode =
  | { readonly kind: 'edit' }
  | { readonly kind: 'read'; readonly reason: string | null };

/** How long a term stays unchanged before its working copy becomes a save point. */
export const TERM_SAVE_POINT_DELAY_MS = 30_000;

/** Statuses that leave a write's outcome unknown: no answer, or a gateway's. */
const UNKNOWN_OUTCOME = new Set([0, 502, 503, 504]);

/**
 * One term as its panel edits it, provided per page. Reads it in the chosen change set: its
 * working copy when the person may change it there (a draft they started, the term not locked by
 * another change set; the API also asks for a `content.edit` role covering the term's languages),
 * else the file at the branch, read-only with the reason.
 *
 * Saving is eager, as the project settings save (`ConfigDraft`): a change shows at once (`term`)
 * and is saved into the working copy (taking the term's lock first), one save at a time with the
 * newest content. A refused save puts back the last saved content with a toast offering Retry.
 * After a quiet `TERM_SAVE_POINT_DELAY_MS`, and when the panel closes or the page is left
 * (`savePoint`), the working copy becomes a save point. Nothing of an earlier `load` applies after
 * a newer one.
 */
@Injectable()
export class TermDraft {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly error = signal<ApiError | null>(null);
  /** The ID of the term read (or being read); null before the first. */
  readonly termId = signal<string | null>(null);
  readonly term = signal<TermContent | null>(null);
  readonly mode = signal<TermMode>({ kind: 'read', reason: null });
  /** The working copy's state since the panel changed it; null before the first change. */
  readonly saveState = signal<'saved' | 'saving' | 'not-saved' | null>(null);
  /** Counts the save points made here: the list is read again after one. */
  readonly commits = signal(0);

  private generation = 0;
  private changeSet: TermChangeSet | null = null;
  /** The content last saved (or read): what a refusal puts back. */
  private confirmed: TermContent | null = null;
  private version = 0;
  private baseCommit = '';
  private lockHeld = false;
  private uncommitted = false;
  /** The newest content not sent yet. */
  private target: TermContent | null = null;
  private draining = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts changes: a Retry offered before a newer change has nothing left to do. */
  private edits = 0;
  private destroyed = false;
  /** Edits are not taken while set: the term is being deleted. */
  private held = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.generation++;
      clearTimeout(this.timer);
    });
  }

  /** Reads `termId` in `changeSet` (null: the released content). Never rejects. */
  async load(changeSet: TermChangeSet | null, termId: string): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.changeSet = changeSet;
    this.termId.set(termId);
    this.target = null;
    this.draining = false;
    this.lockHeld = false;
    this.uncommitted = false;
    this.edits = 0;
    this.chain = Promise.resolve();
    this.saveState.set(null);
    this.term.set(null);
    this.status.set('loading');
    this.error.set(null);
    const stale = () => generation !== this.generation;
    try {
      const reason = this.readReason(changeSet);
      if (reason !== undefined || !changeSet) {
        await this.readCommitted(changeSet, termId, reason ?? null, stale);
        return;
      }
      const [copy, locks] = await Promise.all([
        firstValueFrom(
          this.api.get(
            '/change-sets/{changeSetId}/terms/{termId}/working-copy',
            {
              path: { changeSetId: changeSet.id, termId },
            },
          ),
        ).catch((error: unknown) => {
          const failure = toApiError(error);
          // Not theirs to change: read what is committed.
          if (failure.status === 403) return null;
          throw failure;
        }),
        firstValueFrom(
          this.api.get('/locks', {
            query: { 'filter[subject]': `term/${termId}` },
          }),
        ).catch(() => null),
      ]);
      if (stale()) return;
      if (!copy) {
        await this.readCommitted(
          changeSet,
          termId,
          'editor.terminology.blocked.forbidden',
          stale,
        );
        return;
      }
      const lock = locks?.data[0];
      const lockedElsewhere =
        !!lock && lock.relationships.changeSet.data.id !== changeSet.id;
      this.lockHeld = !!lock && !lockedElsewhere;
      this.version = copy.data.attributes.version;
      this.baseCommit = copy.data.attributes.baseCommit;
      this.uncommitted = copy.data.meta.saved;
      this.show(
        copy.data.attributes.content,
        lockedElsewhere
          ? { kind: 'read', reason: 'editor.terminology.blocked.locked' }
          : { kind: 'edit' },
      );
      if (this.uncommitted && !lockedElsewhere) this.schedule();
    } catch (error) {
      if (stale()) return;
      this.error.set(toApiError(error));
      this.status.set('error');
    }
  }

  private async readCommitted(
    changeSet: TermChangeSet | null,
    termId: string,
    reason: string | null,
    stale: () => boolean,
  ): Promise<void> {
    const doc = await firstValueFrom(
      this.api.get('/terms/{termId}', {
        path: { termId },
        ...(changeSet ? { query: { ref: changeSet.branch } } : {}),
      }),
    );
    if (stale()) return;
    this.show(contentOf(doc.data), { kind: 'read', reason });
  }

  /** Why terms are read-only in this change set (a key), null if the role never edits, undefined if they may. */
  private readReason(
    changeSet: TermChangeSet | null,
  ): string | null | undefined {
    if (
      this.permissions.state({ permission: 'content.edit' }).kind === 'hidden'
    )
      return null;
    if (!changeSet) return 'editor.terminology.blocked.needsChangeSet';
    if (changeSet.state !== 'draft')
      return 'editor.terminology.blocked.notDraft';
    if (changeSet.authorId !== '' && changeSet.authorId !== this.me.me().id) {
      return 'editor.terminology.blocked.notAuthor';
    }
    return undefined;
  }

  private show(term: TermContent, mode: TermMode): void {
    this.confirmed = term;
    this.term.set(term);
    this.mode.set(mode);
    this.status.set('ready');
  }

  /** Holds edits back (`true`) while the term is deleted, so none recreates it; `false` takes them again. */
  hold(on: boolean): void {
    this.held = on;
  }

  /** Shows `next` at once and saves it into the working copy (only once read, to edit). */
  change(next: TermContent): boolean {
    if (this.destroyed || this.held || this.status() !== 'ready') return false;
    if (this.mode().kind !== 'edit') return false;
    if (next.id !== this.termId()) return false;
    clearTimeout(this.timer);
    this.edits++;
    this.term.set(next);
    this.target = next;
    this.saveState.set('saving');
    if (!this.draining) {
      this.draining = true;
      const generation = this.generation;
      void this.enqueue(() => this.drain(generation));
    }
    return true;
  }

  /** Makes the saved working copy a save point now (after the saves before it); resolves whether nothing is left uncommitted. */
  savePoint(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.destroyed) return Promise.resolve(false);
    const generation = this.generation;
    return this.enqueue(() => this.commit(generation));
  }

  /** Forgets the open term (the panel closed), after its save point. */
  async close(): Promise<void> {
    if (this.mode().kind === 'edit') await this.savePoint();
    this.generation++;
    clearTimeout(this.timer);
    this.termId.set(null);
    this.term.set(null);
    this.saveState.set(null);
    this.status.set('idle');
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.destroyed) return;
    this.timer = setTimeout(
      () => void this.savePoint(),
      TERM_SAVE_POINT_DELAY_MS,
    );
  }

  private subject(): { type: 'term'; termId: string } {
    return { type: 'term', termId: this.termId() ?? '' };
  }

  private async drain(generation: number): Promise<void> {
    const stale = () => generation !== this.generation;
    const changeSet = this.changeSet;
    const termId = this.termId();
    if (!changeSet || !termId) return;
    while (this.target && !stale()) {
      const sending = this.target;
      this.target = null;
      try {
        if (!this.lockHeld) {
          await this.takeLock(changeSet);
          if (stale()) return;
          this.lockHeld = true;
        }
        const doc = await firstValueFrom(
          this.api.put(
            '/change-sets/{changeSetId}/terms/{termId}/working-copy',
            { path: { changeSetId: changeSet.id, termId } },
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
        this.uncommitted = true;
      } catch (error) {
        if (stale()) return;
        this.draining = false;
        this.refused(sending, toApiError(error));
        return;
      }
    }
    if (stale()) return;
    this.draining = false;
    this.saveState.set('saved');
    this.schedule();
  }

  /** A save was refused: the last saved content comes back, and the person is told why. */
  private refused(sending: TermContent, failure: ApiError): void {
    // A change made while this one was sent already holds it: a retry sends that one.
    const newest = this.target ?? sending;
    this.target = null;
    this.term.set(this.confirmed);
    this.saveState.set('not-saved');
    // What was saved before stays due for a save point.
    if (this.uncommitted) this.schedule();
    const what = translated('editor.terminology.save.failed');
    if (failure.code === 'lock-required') this.lockHeld = false;
    if (failure.code === 'locked') {
      this.mode.set({
        kind: 'read',
        reason: 'editor.terminology.blocked.locked',
      });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (failure.status === 403) {
      this.mode.set({
        kind: 'read',
        reason: 'editor.terminology.blocked.forbidden',
      });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (
      failure.code === 'version-conflict' ||
      failure.code === 'stale-working-copy' ||
      UNKNOWN_OUTCOME.has(failure.status)
    ) {
      this.toast.error(translated('editor.terminology.save.reloaded'));
      const termId = this.termId();
      if (termId) void this.load(this.changeSet, termId);
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

  private async takeLock(changeSet: TermChangeSet): Promise<void> {
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/locks',
        { data: { type: 'Lock', attributes: { subject: this.subject() } } },
        { path: { changeSetId: changeSet.id } },
      ),
    );
  }

  private async commit(generation: number): Promise<boolean> {
    const changeSet = this.changeSet;
    const termId = this.termId();
    if (generation !== this.generation || !changeSet || !termId) return false;
    if (!this.uncommitted) return true;
    try {
      if (!this.lockHeld) {
        await this.takeLock(changeSet);
        if (generation !== this.generation) return false;
        this.lockHeld = true;
      }
      const doc = (await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/commits',
          {
            data: {
              type: 'Commit',
              attributes: {
                subjects: [this.subject()],
                message: `Update term ${termId}`,
              },
            },
          },
          { path: { changeSetId: changeSet.id } },
        ),
      )) as Schema<'CommitDocument'> | Schema<'NoCommitDocument'>;
      if (generation !== this.generation) return false;
      this.baseCommit = 'data' in doc ? doc.data.id : doc.meta.head;
      this.version = 0;
      this.uncommitted = false;
      this.commits.update((n) => n + 1);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const failure = toApiError(error);
      const what = translated('editor.terminology.save.savePointFailed');
      if (failure.code === 'locked') {
        this.mode.set({
          kind: 'read',
          reason: 'editor.terminology.blocked.locked',
        });
        this.toast.error(this.failureText(what, failure));
        return false;
      }
      if (failure.code === 'lock-required') this.lockHeld = false;
      if (
        failure.code === 'lock-required' ||
        failure.code === 'version-conflict' ||
        failure.code === 'stale-working-copy'
      ) {
        this.toast.error(translated('editor.terminology.save.reloaded'));
        void this.load(this.changeSet, termId);
        return false;
      }
      this.toast.error(this.failureText(what, failure), {
        actionLabel: translated('editor.session.retry'),
        onAction: () => void this.savePoint(),
      });
      return false;
    }
  }
}
