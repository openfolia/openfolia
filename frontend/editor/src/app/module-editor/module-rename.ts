import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';

type LockSubject = Schema<'LockSubject'>;

/** What renaming a module would touch at the change set's head (`GET …/module-references`). */
export interface RenamePlan {
  /** The languages the module has a file in. */
  readonly languages: readonly string[];
  /** The other modules (per language) and manuals naming it: rewritten by the rename. */
  readonly references: readonly LockSubject[];
  /** The modules in a target language whose translation records the rename brings up to date. */
  readonly translations: readonly LockSubject[];
  /** The subjects among those (the module's own too) with a working copy: committed first. */
  readonly workingCopies: readonly LockSubject[];
}

/** A rename the person asked for. */
export interface RenameRequest {
  /** The module's ID now. */
  readonly from: string;
  /** Its new ID. */
  readonly to: string;
  /** The module's title, for the toasts. */
  readonly title: string;
}

/** What the page does around a rename's Undo. */
export interface RenameHooks {
  /** Before Undo renames back: the editor saves and stops (false: it could not, no Undo now). */
  readonly beforeUndo?: () => Promise<boolean>;
  /** After a successful Undo (the module editor opens the old ID again). */
  readonly undone?: () => void;
}

/** Another change set holds a lock the rename needs; `kind` says what it is on. */
class Locked extends Error {
  constructor(readonly kind: LockSubject['type']) {
    super('locked');
  }
}

/** The person changed while it ran. */
class IdentityChanged extends Error {}

/**
 * Changes a module's ID in a draft change set (#265), with Undo instead of a confirm. A rename
 * reads what it touches (`references`), takes the locks it needs (the module under both IDs in
 * every language, and every module and manual naming it: they stay with the change set, as the
 * module editor's do), commits the working copies of those subjects (a save point), then renames
 * (`POST …/module-renames`), which moves the module and rewrites the files naming it in one
 * commit. Undo renames back the same way.
 */
@Injectable({ providedIn: 'root' })
export class ModuleRename {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly failureText = injectFailureText();
  private readonly running = new Set<string>();

  /** What renaming `moduleId` in `changeSetId` would touch. */
  async references(changeSetId: string, moduleId: string): Promise<RenamePlan> {
    const answer = await firstValueFrom(
      this.api.get('/change-sets/{changeSetId}/module-references/{moduleId}', {
        path: { changeSetId, moduleId },
      }),
    );
    return {
      languages: answer.data.attributes.languages,
      references: answer.data.attributes.references,
      translations: answer.data.attributes.translations,
      workingCopies: answer.data.meta.workingCopies,
    };
  }

  /**
   * Renames `request.from` to `request.to` in `changeSetId`. Resolves whether it was renamed; a
   * failure says why in a toast. The success toast offers Undo.
   */
  async rename(
    request: RenameRequest,
    changeSetId: string,
    hooks: RenameHooks = {},
    /** Who asked for it (the caller read it before waiting); nothing is done for anyone else. */
    person = this.me.me().id,
  ): Promise<boolean> {
    const job = `${changeSetId}\n${request.from}`;
    if (this.running.has(job) || this.me.me().id !== person) return false;
    this.running.add(job);
    try {
      await this.run(request.from, request.to, changeSetId, person);
      if (this.me.me().id === person) {
        this.toast.success(
          translated('editor.moduleEditor.rename.done', {
            title: request.title,
            id: request.to,
          }),
          {
            actionLabel: translated('ui.toast.undo'),
            onAction: () => void this.undo(request, changeSetId, hooks, person),
          },
        );
      }
      return true;
    } catch (error) {
      this.fail(
        error,
        translated('editor.moduleEditor.rename.failed', {
          title: request.title,
        }),
        () => void this.rename(request, changeSetId, hooks, person),
        person,
      );
      return false;
    } finally {
      this.running.delete(job);
    }
  }

  /** Renames back (the toast's Undo). Resolves whether it was undone. */
  async undo(
    request: RenameRequest,
    changeSetId: string,
    hooks: RenameHooks = {},
    person = this.me.me().id,
  ): Promise<boolean> {
    // An undo acts as whoever is signed in: only the person who renamed.
    if (this.me.me().id !== person) return false;
    const job = `${changeSetId}\n${request.to}`;
    if (this.running.has(job)) return false;
    this.running.add(job);
    try {
      if (hooks.beforeUndo && !(await hooks.beforeUndo())) return false;
      await this.run(request.to, request.from, changeSetId, person);
      this.toast.success(
        translated('editor.moduleEditor.rename.undone', {
          title: request.title,
          id: request.from,
        }),
      );
      hooks.undone?.();
      return true;
    } catch (error) {
      this.fail(
        error,
        translated('editor.moduleEditor.rename.undoFailed', {
          title: request.title,
        }),
        () => void this.undo(request, changeSetId, hooks, person),
        person,
      );
      return false;
    } finally {
      this.running.delete(job);
    }
  }

  private fail(
    error: unknown,
    what: ReturnType<typeof translated>,
    retry: () => void,
    person: string,
  ): void {
    if (error instanceof IdentityChanged || this.me.me().id !== person) return;
    if (error instanceof Locked) {
      this.toast.error(
        translated(
          error.kind === 'manual'
            ? 'editor.moduleEditor.rename.lockedManual'
            : 'editor.moduleEditor.rename.lockedModule',
        ),
      );
      return;
    }
    const failure: ApiError = toApiError(error);
    // A refusal on what the rename is (its ID, the scope) is not worth a retry as it stands.
    const final = failure.status === 403 || failure.status === 422;
    this.toast.error(
      this.failureText(what, failure),
      final
        ? {}
        : { actionLabel: translated('editor.session.retry'), onAction: retry },
    );
  }

  /** Locks, the save point of the working copies in the way, then the rename itself. */
  private async run(
    from: string,
    to: string,
    changeSetId: string,
    person: string,
  ): Promise<void> {
    const samePerson = () => {
      if (this.me.me().id !== person) throw new IdentityChanged();
    };
    const plan = await this.references(changeSetId, from);
    samePerson();
    const subjects: LockSubject[] = [
      ...plan.languages.flatMap((lang): LockSubject[] => [
        { type: 'module', lang, moduleId: from },
        { type: 'module', lang, moduleId: to },
      ]),
      ...plan.references,
      ...plan.translations,
    ];
    for (const subject of subjects) {
      samePerson();
      await this.lock(changeSetId, subject);
    }
    if (plan.workingCopies.length > 0) {
      samePerson();
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/commits',
          {
            data: {
              type: 'Commit',
              attributes: { subjects: [...plan.workingCopies] },
            },
          },
          { path: { changeSetId } },
        ),
      );
    }
    samePerson();
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/module-renames',
        { data: { type: 'ModuleRename', attributes: { from, to } } },
        { path: { changeSetId } },
      ),
    );
  }

  /** Takes the lock for the change set (held already: nothing changes). */
  private async lock(changeSetId: string, subject: LockSubject): Promise<void> {
    try {
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/locks',
          { data: { type: 'Lock', attributes: { subject } } },
          { path: { changeSetId } },
        ),
      );
    } catch (error) {
      if (toApiError(error).code === 'locked') throw new Locked(subject.type);
      throw error;
    }
  }
}
