import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, ApiError, toApiError, type Schema } from '../api';
import { sameJson } from '../content/module-creation';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';
import type { TermContent } from './terms-model';

type TermSubject = { type: 'term'; termId: string };
/** A save point's answer: the commit (201), or none made (200). */
type CommitAnswer = Schema<'CommitDocument'> | Schema<'NoCommitDocument'>;

/** A term with this ID is on the branch, or a working copy of it is in the change set. */
export class TermExists extends Error {}

/** Another change set holds the term's lock. */
export class TermLocked extends Error {}

/** The term is there again, and not as it was: Undo would overwrite it. */
class Taken extends Error {}

/** The person changed while it ran. */
class IdentityChanged extends Error {}

interface Deleted {
  readonly changeSetId: string;
  readonly content: TermContent;
  /** On the branch (deleted by a commit), not only a working copy (discarded). */
  readonly committed: boolean;
  /** The delete's commit (or the working copy's base, when nothing was committed). */
  readonly commit: string;
  readonly person: string;
}

/**
 * Adds and deletes terms in a draft change set of one's own. A new term takes its lock, is saved
 * as a working copy and committed at once (a save point), so it is on the change set's branch and
 * in the list for everyone who reads it. Delete reads what the term holds now (its working copy,
 * else the committed file), takes the lock and makes one save point that deletes the file (a term
 * that is only a working copy is discarded instead), with Undo in its toast: Undo writes what was
 * read back and commits it, while nobody has put the term back since. The locks stay with the
 * change set, as the module editor's do.
 */
@Injectable({ providedIn: 'root' })
export class TermWrites {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly failureText = injectFailureText();
  private readonly running = new Set<string>();

  /** Counts adds, deletes and undos: lists read again when it changes. */
  readonly changed = signal(0);
  /** The terms deleted in this tab and not undone (by change set and ID): hidden from the list. */
  readonly hidden = signal<ReadonlySet<string>>(new Set());

  /** Creates `term` in `changeSetId`; rejects with `TermExists`, `TermLocked` or the API's failure. */
  async create(term: TermContent, changeSetId: string): Promise<void> {
    const person = this.me.me().id;
    const subject: TermSubject = { type: 'term', termId: term.id };
    const path = { changeSetId, termId: term.id };
    const existing = await this.readCopy(changeSetId, term.id);
    if (existing) {
      // A copy in this change set (or the file on its branch): not a new term.
      throw new TermExists();
    }
    this.samePerson(person);
    const set = await firstValueFrom(
      this.api.get('/change-sets/{changeSetId}', { path: { changeSetId } }),
    );
    await this.lock(changeSetId, subject);
    this.samePerson(person);
    let saved = false;
    try {
      await firstValueFrom(
        this.api.put(
          '/change-sets/{changeSetId}/terms/{termId}/working-copy',
          { path },
          {
            data: { type: 'WorkingCopy', attributes: { content: term } },
            meta: { version: 0, baseCommit: set.data.attributes.baseCommit },
          },
        ),
      );
      saved = true;
      this.samePerson(person);
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/commits',
          {
            data: {
              type: 'Commit',
              attributes: {
                subjects: [subject],
                message: `Add term ${term.id}`,
              },
            },
          },
          { path: { changeSetId } },
        ),
      );
    } catch (error) {
      // A refused commit: the working copy this saved goes again, so a corrected retry starts
      // clean. An unknown outcome may have committed it: it stays for the retry to find.
      const failure =
        error instanceof IdentityChanged ? null : toApiError(error);
      if (
        saved &&
        failure &&
        failure.status >= 400 &&
        failure.status < 500 &&
        this.me.me().id === person
      ) {
        await firstValueFrom(
          this.api.delete(
            '/change-sets/{changeSetId}/terms/{termId}/working-copy',
            { path },
          ),
        ).catch(() => undefined);
      }
      throw error;
    }
    // A term deleted here before and added again: shown again.
    this.hide(`${changeSetId}\n${term.id}`, false);
    this.changed.update((n) => n + 1);
  }

  /**
   * Deletes the term from `changeSetId`, with Undo in a toast. Resolves whether it was deleted; a
   * failure says why in a toast.
   */
  async delete(
    termId: string,
    label: string,
    changeSetId: string,
    onUndone?: () => void,
  ): Promise<boolean> {
    const job = `${changeSetId}\n${termId}`;
    if (this.running.has(job)) return false;
    const person = this.me.me().id;
    this.running.add(job);
    try {
      const record = await this.run(termId, changeSetId, person);
      this.hide(job, true);
      this.changed.update((n) => n + 1);
      if (this.me.me().id === person) {
        this.toast.success(
          translated('editor.terminology.delete.done', { term: label }),
          {
            actionLabel: translated('ui.toast.undo'),
            onAction: () => void this.undo(record, label, onUndone),
          },
        );
      }
      return true;
    } catch (error) {
      if (error instanceof IdentityChanged) return false;
      if (error instanceof TermLocked) {
        this.toast.error(
          translated('editor.terminology.delete.locked', { term: label }),
        );
        return false;
      }
      this.toast.error(
        this.failureText(
          translated('editor.terminology.delete.failed', { term: label }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            if (this.me.me().id === person) {
              void this.delete(termId, label, changeSetId, onUndone);
            }
          },
        },
      );
      return false;
    } finally {
      this.running.delete(job);
    }
  }

  private async run(
    termId: string,
    changeSetId: string,
    person: string,
  ): Promise<Deleted> {
    const subject: TermSubject = { type: 'term', termId };
    const copy = await this.readCopy(changeSetId, termId);
    if (!copy) throw new ApiError('not-found', 404, 'not-found', 'Not found.');
    const { content, baseCommit } = copy.data.attributes;
    // Not saved: the committed file itself. Saved: committed only if the branch has a file too.
    const committed =
      !copy.data.meta.saved || (await this.onBranch(changeSetId, termId));
    this.samePerson(person);
    await this.lock(changeSetId, subject);
    this.samePerson(person);
    if (!committed) {
      await firstValueFrom(
        this.api.delete(
          '/change-sets/{changeSetId}/terms/{termId}/working-copy',
          { path: { changeSetId, termId } },
        ),
      );
      return { changeSetId, content, committed, commit: baseCommit, person };
    }
    const answer = (await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/commits',
        {
          data: {
            type: 'Commit',
            attributes: {
              subjects: [],
              deletes: [subject],
              message: `Delete term ${termId}`,
            },
          },
        },
        { path: { changeSetId } },
      ),
    )) as CommitAnswer;
    const commit = 'data' in answer ? answer.data.id : answer.meta.head;
    return { changeSetId, content, committed, commit, person };
  }

  /** Writes a delete back (the toast's Undo). Resolves whether it was undone. */
  async undo(
    record: Deleted,
    label: string,
    onUndone?: () => void,
  ): Promise<boolean> {
    const termId = record.content.id;
    const { changeSetId } = record;
    const job = `${changeSetId}\n${termId}`;
    if (this.running.has(job)) return false;
    // An undo acts as whoever is signed in: only the person who deleted.
    if (this.me.me().id !== record.person) return false;
    this.running.add(job);
    try {
      await this.restore(record);
      this.hide(job, false);
      this.changed.update((n) => n + 1);
      this.toast.success(
        translated('editor.terminology.delete.restored', { term: label }),
      );
      onUndone?.();
      return true;
    } catch (error) {
      if (error instanceof IdentityChanged) return false;
      if (error instanceof Taken) {
        this.hide(job, false);
        this.toast.error(
          translated('editor.terminology.delete.undoTaken', { term: label }),
        );
        return false;
      }
      this.toast.error(
        this.failureText(
          translated('editor.terminology.delete.undoFailed', { term: label }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => void this.undo(record, label, onUndone),
        },
      );
      return false;
    } finally {
      this.running.delete(job);
    }
  }

  private async restore(record: Deleted): Promise<void> {
    const termId = record.content.id;
    const { changeSetId } = record;
    const subject: TermSubject = { type: 'term', termId };
    const path = { changeSetId, termId };
    await this.lock(changeSetId, subject).catch((error: unknown) => {
      throw error instanceof TermLocked ? new Taken() : error;
    });
    this.samePerson(record.person);
    const now = await this.readCopy(changeSetId, termId);
    if (now) {
      // Written back (or committed) by an earlier try of this Undo: done, or only the commit is
      // left. Anything else is someone's since.
      if (!sameJson(now.data.attributes.content, record.content))
        throw new Taken();
      if (!record.committed || !now.data.meta.saved) return;
    } else {
      await firstValueFrom(
        this.api.put(
          '/change-sets/{changeSetId}/terms/{termId}/working-copy',
          { path },
          {
            data: {
              type: 'WorkingCopy',
              attributes: { content: record.content },
            },
            meta: { version: 0, baseCommit: record.commit },
          },
        ),
      );
      if (!record.committed) return;
    }
    this.samePerson(record.person);
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/commits',
        {
          data: {
            type: 'Commit',
            attributes: {
              subjects: [subject],
              message: `Restore term ${termId}`,
            },
          },
        },
        { path: { changeSetId } },
      ),
    );
  }

  private hide(job: string, hidden: boolean): void {
    this.hidden.update((set) => {
      const next = new Set(set);
      if (hidden) next.add(job);
      else next.delete(job);
      return next;
    });
  }

  /** Whether the term with `termId` is hidden in `changeSetId`: deleted here, not undone. */
  isHidden(changeSetId: string | null, termId: string): boolean {
    return !!changeSetId && this.hidden().has(`${changeSetId}\n${termId}`);
  }

  /** The term's working copy, else its file on the branch; null when neither is there. */
  private async readCopy(changeSetId: string, termId: string) {
    return firstValueFrom(
      this.api.get('/change-sets/{changeSetId}/terms/{termId}/working-copy', {
        path: { changeSetId, termId },
      }),
    ).catch((error: unknown) => {
      if (toApiError(error).status === 404) return null;
      throw error;
    });
  }

  /** Whether the change set's branch has the term's file. */
  private async onBranch(
    changeSetId: string,
    termId: string,
  ): Promise<boolean> {
    return firstValueFrom(
      this.api.get('/terms/{termId}', {
        path: { termId },
        query: { ref: `change-sets/${changeSetId}` },
      }),
    ).then(
      () => true,
      (error: unknown) => {
        if (toApiError(error).status === 404) return false;
        throw error;
      },
    );
  }

  private async lock(changeSetId: string, subject: TermSubject): Promise<void> {
    try {
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/locks',
          { data: { type: 'Lock', attributes: { subject } } },
          { path: { changeSetId } },
        ),
      );
    } catch (error) {
      if (toApiError(error).code === 'locked') throw new TermLocked();
      throw error;
    }
  }

  private samePerson(person: string): void {
    if (this.me.me().id !== person) throw new IdentityChanged();
  }
}
