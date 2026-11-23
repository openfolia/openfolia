import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { translated, type Translatable } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type Schema } from '../api';
import { contentOf, type ModuleContent } from '../module-editor/module-model';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { ChangeSetSession } from '../session/change-set-session';
import { injectFailureText } from '../session/failure-text';
import { subjectKeyOf, type HistorySubject } from './history-model';

type DraftManifest = Schema<'DraftManifest'>;
type ManualAttributes = Schema<'ManualAttributes'>;

/** What a working copy holds: a module's text or a manual's manifest. */
type Content = ModuleContent | DraftManifest;

/** A version to restore: the subject as it was after `commit`. */
export interface RestoreRequest {
  readonly subject: HistorySubject;
  readonly commit: string;
  /** How the version is named to the person ("version 2"). */
  readonly label: string;
  /** The module's or manual's title, for a new change set's title and the toasts. */
  readonly title: string;
}

/** A restore that was undone: the editor or builder showing it opens it again. */
export interface RestoreUndone {
  readonly changeSetId: string;
  readonly subject: HistorySubject;
  /** Counts undos, so the same subject undone twice is a change. */
  readonly count: number;
}

/** The subject is locked by another change set. */
class Locked extends Error {}
/** The person changed while it ran. */
class IdentityChanged extends Error {}
/** The old manual names modules the person may not see: restoring it would drop them. */
class HiddenEntries extends Error {}

/** Who restored: the same person is a user (or demo user) with the same ID. */
interface Person {
  readonly id: string;
  readonly kind: string;
}

/** What the working copy held before the restore, for Undo. */
interface Before {
  readonly changeSetId: string;
  readonly request: RestoreRequest;
  /**
   * What the working copy held, saved or the committed file (version 0); null: nothing at all,
   * a subject deleted on the branch (Undo discards the restored copy).
   */
  readonly content: Content | null;
  /** The working copy's version the restore saved: Undo only applies to exactly that one. */
  readonly restoredVersion: number;
  readonly person: Person;
}

/** A working copy as both routes answer it: what Undo and the save read. */
interface WorkingCopy {
  readonly data: {
    readonly attributes: {
      readonly content: Content;
      readonly version: number;
      readonly baseCommit: string;
    };
    readonly meta: { readonly saved: boolean };
  };
}

/** A manual's attributes, as `GET /manuals/{id}` reads them, as the manifest a working copy takes. */
export function manifestOf(id: string, a: ManualAttributes): DraftManifest {
  return {
    schemaVersion: a.schemaVersion,
    id,
    title: a.title,
    ...(a.audience === undefined ? {} : { audience: a.audience }),
    ...(a.deprecated === undefined ? {} : { deprecated: a.deprecated }),
    variants: a.variants,
    attributes: a.textAttributes,
    entries: a.entries,
  };
}

/**
 * Restores an older version of a module (#88) or a manual (#321) as a draft: into the person's
 * open change set (the chosen one, when it is a draft of theirs), else a new one, started as the
 * change-set picker starts one. It takes the subject's lock there and saves the old version into
 * the working copy (`PUT …/working-copy`), so the server checks the change set's state, the lock
 * and the restorer's scope exactly as for an edit; nothing is committed here (the editor's save
 * point does it). Then the module editor (or the manual builder) opens on it, with a toast
 * offering Undo, which puts back what the working copy held before (or discards it), but only
 * while nobody saved over the restored version since. An old manual that names modules the
 * person may not see (its `outside-scope` notes) is not restored: its working copy would leave
 * them out.
 */
@Injectable({ providedIn: 'root' })
export class VersionRestore {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly permissions = inject(PermissionService);
  private readonly failureText = injectFailureText();

  private readonly running = signal(false);
  /** A restore is in progress (one at a time). */
  readonly busy = this.running.asReadonly();

  private readonly undoneState = signal<RestoreUndone | null>(null);
  /** The last restore undone. */
  readonly undone = this.undoneState.asReadonly();

  /** The change set a restore goes into: the chosen one when it is the person's own draft. */
  openChangeSet(): string | null {
    const chosen = this.changeSets.selected();
    if (!chosen || chosen.branch === null) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    if (!option || option.pending || option.state !== 'draft') return null;
    return option.authorId === this.me.me().id ? option.id : null;
  }

  /** Restores the version; resolves whether the editor was opened on it. */
  async restore(request: RestoreRequest): Promise<boolean> {
    // A contributor works only in their own suggestion (#137): restoring is not theirs.
    if (this.running() || this.permissions.suggestsOnly()) return false;
    const person = this.person();
    this.running.set(true);
    try {
      const changeSetId = await this.changeSetFor(request);
      if (changeSetId === null) return false;
      const before = await this.save(request, changeSetId, person);
      const { subject } = request;
      await (subject.type === 'module'
        ? this.router.navigate(['/content', subject.lang, subject.moduleId], {
            queryParams: { cs: changeSetId },
          })
        : this.router.navigate(['/manuals'], {
            queryParams: { manual: subject.manualId, cs: changeSetId },
          }));
      this.toast.success(
        translated('editor.history.restore.done', { revision: request.label }),
        {
          actionLabel: translated('ui.toast.undo'),
          onAction: () => void this.undo(before),
        },
      );
      return true;
    } catch (error) {
      if (error instanceof IdentityChanged) return false;
      if (error instanceof Locked) {
        this.toast.error(
          translated('editor.history.restore.locked', { title: request.title }),
        );
        return false;
      }
      if (error instanceof HiddenEntries) {
        this.toast.error(
          translated('editor.history.restore.hiddenEntries', {
            revision: request.label,
          }),
        );
        return false;
      }
      this.toast.error(
        this.failureText(
          translated('editor.history.restore.failed', {
            revision: request.label,
          }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            if (this.isPerson(person)) void this.restore(request);
          },
        },
      );
      return false;
    } finally {
      this.running.set(false);
    }
  }

  /** The open change set, else a new one (null: it could not be started; the picker said why). */
  private async changeSetFor(request: RestoreRequest): Promise<string | null> {
    const open = this.openChangeSet();
    if (open) return open;
    const started = await this.changeSets.start(
      // A title the person recognises in the picker; the session caps its length.
      `${request.title} (${request.label})`.slice(0, 200),
    );
    if (!started) return null;
    return this.openChangeSet();
  }

  /** The subject's content as it was after `commit`, as a working copy takes it. */
  private async oldContent(request: RestoreRequest): Promise<Content> {
    const { subject, commit } = request;
    if (subject.type === 'module') {
      const old = await firstValueFrom(
        this.api.get('/modules/{lang}/{id}', {
          path: { lang: subject.lang, id: subject.moduleId },
          query: { ref: commit },
        }),
      );
      return contentOf(old.data.attributes);
    }
    const old = await firstValueFrom(
      this.api.get('/manuals/{id}', {
        path: { id: subject.manualId },
        query: { ref: commit },
      }),
    );
    if (old.data.meta.issues.some((i) => i.code === 'outside-scope')) {
      throw new HiddenEntries();
    }
    return manifestOf(subject.manualId, old.data.attributes);
  }

  /** The working copy (404: none, nor a committed file), saved over, or discarded. */
  private readCopy(
    changeSetId: string,
    subject: HistorySubject,
  ): Promise<WorkingCopy> {
    return subject.type === 'module'
      ? firstValueFrom(
          this.api.get(
            '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
            {
              path: {
                changeSetId,
                lang: subject.lang,
                moduleId: subject.moduleId,
              },
            },
          ),
        )
      : firstValueFrom(
          this.api.get(
            '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
            { path: { changeSetId, manualId: subject.manualId } },
          ),
        );
  }

  private saveCopy(
    changeSetId: string,
    subject: HistorySubject,
    content: Content,
    meta: { version: number; baseCommit: string },
  ): Promise<WorkingCopy> {
    return subject.type === 'module'
      ? firstValueFrom(
          this.api.put(
            '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
            {
              path: {
                changeSetId,
                lang: subject.lang,
                moduleId: subject.moduleId,
              },
            },
            {
              data: {
                type: 'WorkingCopy',
                attributes: { content: content as ModuleContent },
              },
              meta,
            },
          ),
        )
      : firstValueFrom(
          this.api.put(
            '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
            { path: { changeSetId, manualId: subject.manualId } },
            {
              data: {
                type: 'WorkingCopy',
                attributes: { content: content as DraftManifest },
              },
              meta,
            },
          ),
        );
  }

  private discardCopy(
    changeSetId: string,
    subject: HistorySubject,
  ): Promise<unknown> {
    return subject.type === 'module'
      ? firstValueFrom(
          this.api.delete(
            '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
            {
              path: {
                changeSetId,
                lang: subject.lang,
                moduleId: subject.moduleId,
              },
            },
          ),
        )
      : firstValueFrom(
          this.api.delete(
            '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
            { path: { changeSetId, manualId: subject.manualId } },
          ),
        );
  }

  /**
   * Locks the subject in the change set and saves the version into its working copy; resolves
   * what the working copy held, for Undo (the latest restore's only).
   */
  private async save(
    request: RestoreRequest,
    changeSetId: string,
    person: Person,
  ): Promise<Before> {
    const samePerson = () => {
      if (!this.isPerson(person)) throw new IdentityChanged();
    };
    const { subject } = request;
    const [old, set] = await Promise.all([
      this.oldContent(request),
      firstValueFrom(
        this.api.get('/change-sets/{changeSetId}', { path: { changeSetId } }),
      ),
    ]);
    samePerson();
    try {
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/locks',
          {
            data: {
              type: 'Lock',
              attributes: {
                subject:
                  subject.type === 'module'
                    ? {
                        type: 'module',
                        lang: subject.lang,
                        moduleId: subject.moduleId,
                      }
                    : { type: 'manual', manualId: subject.manualId },
              },
            },
          },
          { path: { changeSetId } },
        ),
      );
    } catch (error) {
      if (toApiError(error).code === 'locked') throw new Locked();
      throw error;
    }
    samePerson();
    // The working copy, else the committed file (version 0); nothing at all for a subject
    // deleted on the branch, which the change set's base then stands for.
    const current = await this.readCopy(changeSetId, subject).catch(
      (error: unknown) => {
        if (toApiError(error).status === 404) return null;
        throw error;
      },
    );
    samePerson();
    const saved = await this.saveCopy(changeSetId, subject, old, {
      version: current?.data.attributes.version ?? 0,
      baseCommit:
        current?.data.attributes.baseCommit ?? set.data.attributes.baseCommit,
    });
    const before: Before = {
      changeSetId,
      request,
      content: current ? current.data.attributes.content : null,
      restoredVersion: saved.data.attributes.version,
      person,
    };
    this.latest = before;
    return before;
  }

  /** The latest restore: only its toast's Undo applies. */
  private latest: Before | null = null;

  private person(): Person {
    const me = this.me.me();
    return { id: me.id, kind: me.kind };
  }

  private isPerson(person: Person): boolean {
    const me = this.me.me();
    return me.id === person.id && me.kind === person.kind;
  }

  /**
   * Undoes the restore: what the working copy held goes back, saved over exactly the restored
   * version, so nothing typed since is lost (the committed file put back is dropped by the next
   * save point). Only for the latest restore, by the person who made it.
   */
  private async undo(before: Before): Promise<void> {
    if (this.latest !== before || !this.isPerson(before.person)) return;
    const { request, changeSetId } = before;
    const { subject } = request;
    const refuse = (message: Translatable) => this.toast.error(message);
    try {
      const now = await this.readCopy(changeSetId, subject);
      if (
        !now.data.meta.saved ||
        now.data.attributes.version !== before.restoredVersion
      ) {
        refuse(translated('editor.history.restore.undoChanged'));
        return;
      }
      // Another person meanwhile (a demo user switched): nothing is written for them.
      if (!this.isPerson(before.person)) return;
      if (before.content) {
        await this.saveCopy(changeSetId, subject, before.content, {
          version: before.restoredVersion,
          baseCommit: now.data.attributes.baseCommit,
        });
      } else {
        // Nothing was there (deleted on the branch): the restored copy is discarded. The
        // server takes no version here, so a save in the moment since the check is lost too.
        await this.discardCopy(changeSetId, subject);
      }
      this.latest = null;
      this.undoneState.update((last) => ({
        changeSetId,
        subject,
        count: (last?.count ?? 0) + 1,
      }));
      this.toast.success(
        translated('editor.history.restore.undone', {
          revision: request.label,
        }),
      );
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'version-conflict') {
        refuse(translated('editor.history.restore.undoChanged'));
        return;
      }
      this.toast.error(
        this.failureText(
          translated('editor.history.restore.undoFailed', {
            revision: request.label,
          }),
          failure,
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => void this.undo(before),
        },
      );
    }
  }
}

/** Whether an undone restore is of `subject` in `changeSetId`. */
export function undoneOf(
  undone: RestoreUndone,
  subject: HistorySubject,
  changeSetId: string | undefined,
): boolean {
  return (
    undone.changeSetId === changeSetId &&
    subjectKeyOf(undone.subject) === subjectKeyOf(subject)
  );
}
