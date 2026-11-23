import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { LanguageService, translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, ApiError, toApiError, type Schema } from '../api';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';
import { languageName } from './browser-model';
import { sameJson } from './module-creation';

type ModuleContent = Schema<'Module'>;
type ModuleSubject = { type: 'module'; lang: string; moduleId: string };
/** A save point's answer: the commit (201), or none made (200). */
type CommitAnswer =
  Schema<'CommitDocument'> | { meta: { commit: null; head: string } };

/** What the delete dialog asks to delete. */
export interface DeleteRequest {
  readonly moduleId: string;
  /** The module's title, for the toasts. */
  readonly title: string;
  /** The languages to delete. */
  readonly langs: readonly string[];
  /** Every language of the module: it is gone from the change set afterwards. */
  readonly all: boolean;
}

/** A module (or some of its languages) this tab deleted from a change set. */
export interface DeletedModule {
  readonly key: number;
  readonly changeSetId: string;
  readonly moduleId: string;
  readonly title: string;
  readonly langs: readonly string[];
  readonly all: boolean;
  /** Who deleted it: only their own deletes are theirs to show and undo. */
  readonly person: string;
}

/** One language as it was before the delete: what Undo writes back. */
interface Removed {
  readonly subject: ModuleSubject;
  readonly content: ModuleContent;
  /** On the branch (deleted by the commit), not only a working copy (discarded). */
  readonly committed: boolean;
  /** The working copy's base, for a language that was only a working copy. */
  readonly baseCommit: string;
}

interface Record extends DeletedModule {
  readonly removed: readonly Removed[];
  /** The delete's commit (or the head, when nothing was committed). */
  readonly commit: string;
  readonly onUndone: (() => void) | undefined;
}

/** A module (or a working copy of it) is there again, and not as it was: Undo would overwrite it. */
class Taken extends Error {}

/** Some of it is locked by another change set. */
class Locked extends Error {}

/** The person changed while it ran. */
class IdentityChanged extends Error {}

/**
 * Deletes modules (one language or every one) in a draft change set, with Undo instead of a
 * confirm afterwards. Delete reads what each language holds now (its working copy, else the
 * committed file), takes the locks and makes one save point that deletes the committed files
 * (`deletes`) and drops their working copies; a language that is only a working copy (a
 * translation started, never committed) is discarded instead. The locks it takes stay with the
 * change set, as the module editor's do. Undo writes what was read back
 * into working copies and commits those that were committed, while the change set is a draft and
 * nobody has put the module back since. A later restore is the history's (#88).
 */
@Injectable({ providedIn: 'root' })
export class ModuleDeletion {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly language = inject(LanguageService);
  private readonly failureText = injectFailureText();
  private keys = 0;
  private readonly running = new Set<string>();
  private readonly undoing = new Set<number>();

  private readonly list = signal<readonly Record[]>([]);
  /** What this tab deleted and has not undone, newest first. */
  readonly deleted = this.list.asReadonly();
  /** Counts deletes and undos: lists read again when it changes. */
  readonly changed = signal(0);

  /**
   * Deletes `request` from `changeSetId`. Resolves the languages it deleted (some may stay, said
   * in a toast), or null when nothing was; a failure says why in a toast. `onUndone` runs after a successful Undo (the module editor opens the module again).
   */
  async delete(
    request: DeleteRequest,
    changeSetId: string,
    onUndone?: () => void,
    /** Who asked for it (the caller read it before waiting); nothing is done for anyone else. */
    person = this.me.me().id,
  ): Promise<readonly string[] | null> {
    const job = `${changeSetId}\n${request.moduleId}`;
    if (this.running.has(job) || request.langs.length === 0) return null;
    if (this.me.me().id !== person) return null;
    this.running.add(job);
    try {
      const record = await this.run(request, changeSetId, person, onUndone);
      this.list.update((list) => [record, ...list]);
      this.changed.update((n) => n + 1);
      // Undo is theirs only: someone else signed in meanwhile gets no toast for it.
      if (this.me.me().id === person) {
        this.toast.success(this.doneText(record), {
          actionLabel: translated('ui.toast.undo'),
          onAction: () => void this.undo(record.key),
        });
      }
      return record.langs;
    } catch (error) {
      if (error instanceof IdentityChanged) return null;
      if (error instanceof Locked) {
        this.toast.error(
          translated('editor.content.delete.locked', { title: request.title }),
        );
        return null;
      }
      const failure: ApiError = toApiError(error);
      this.toast.error(
        this.failureText(
          translated('editor.content.delete.failed', { title: request.title }),
          failure,
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            if (this.me.me().id === person) {
              void this.delete(request, changeSetId, onUndone, person);
            }
          },
        },
      );
      return null;
    } finally {
      this.running.delete(job);
    }
  }

  /** Writes a delete back (the toast's Undo). Resolves whether it was undone. */
  async undo(key: number): Promise<boolean> {
    const record = this.list().find((r) => r.key === key);
    if (!record || this.undoing.has(key)) return false;
    // An undo acts as whoever is signed in: only the person who deleted.
    if (this.me.me().id !== record.person) return false;
    this.undoing.add(key);
    try {
      await this.restore(record);
      this.list.update((list) => list.filter((r) => r.key !== key));
      this.changed.update((n) => n + 1);
      this.toast.success(
        translated('editor.content.delete.restored', { title: record.title }),
      );
      record.onUndone?.();
      return true;
    } catch (error) {
      if (error instanceof IdentityChanged) return false;
      if (error instanceof Taken) {
        this.toast.error(
          translated('editor.content.delete.undoTaken', {
            title: record.title,
          }),
        );
        return false;
      }
      this.toast.error(
        this.failureText(
          translated('editor.content.delete.undoFailed', {
            title: record.title,
          }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => void this.undo(key),
        },
      );
      return false;
    } finally {
      this.undoing.delete(key);
    }
  }

  /** What was deleted: the record's languages, those that stayed left out. */
  private doneText(record: Record) {
    if (record.all) {
      return translated('editor.content.delete.doneAll', {
        title: record.title,
      });
    }
    return translated('editor.content.delete.done', {
      title: record.title,
      languages: record.langs
        .map((l) => languageName(this.language.locale(), l))
        .join(', '),
    });
  }

  private async run(
    request: DeleteRequest,
    changeSetId: string,
    person: string,
    onUndone: (() => void) | undefined,
  ): Promise<Record> {
    const samePerson = () => {
      if (this.me.me().id !== person) throw new IdentityChanged();
    };
    // What each language holds now: Undo writes it back. None there: nothing to delete in it.
    const found = await Promise.all(
      request.langs.map((lang) =>
        this.read(changeSetId, request.moduleId, lang),
      ),
    );
    const removed = found.filter((r): r is Removed => r !== null);
    if (removed.length === 0) {
      throw new ApiError('not-found', 404, 'not-found', 'Not found.');
    }
    samePerson();
    // The locks stay with the change set once taken, as the module editor's do (they go when it
    // is merged or abandoned): giving one back could take it from another tab of the same change
    // set that holds it meanwhile.
    for (const { subject } of removed) await this.lock(changeSetId, subject);
    samePerson();
    const commit = await this.commitDeletes(changeSetId, request, removed);
    // A language that is only a working copy is deleted by discarding it. One that cannot be
    // discarded is still there: it leaves the record (and the done text), and is said on its own;
    // when nothing at all was deleted, the delete failed.
    const kept = new Set<string>();
    let discardError: unknown;
    for (const r of removed.filter((r) => !r.committed)) {
      if (this.me.me().id !== person) {
        kept.add(r.subject.lang); // someone else now: not for them to discard
        continue;
      }
      await firstValueFrom(
        this.api.delete(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
          {
            path: {
              changeSetId,
              lang: r.subject.lang,
              moduleId: r.subject.moduleId,
            },
          },
        ),
      ).catch((error: unknown) => {
        kept.add(r.subject.lang);
        discardError = error;
      });
    }
    const gone = removed.filter((r) => !kept.has(r.subject.lang));
    if (gone.length === 0) throw discardError ?? new IdentityChanged();
    if (discardError !== undefined) {
      this.toast.error(
        this.failureText(
          translated('editor.content.delete.discardFailed', {
            title: request.title,
            languages: [...kept]
              .map((l) => languageName(this.language.locale(), l))
              .join(', '),
          }),
          toApiError(discardError),
        ),
      );
    }
    return {
      key: ++this.keys,
      changeSetId,
      moduleId: request.moduleId,
      title: request.title,
      langs: gone.map((r) => r.subject.lang),
      all: request.all && kept.size === 0,
      removed: gone,
      commit,
      person,
      onUndone,
    };
  }

  /** One language as it is now; null when it has neither a working copy nor a file. */
  private async read(
    changeSetId: string,
    moduleId: string,
    lang: string,
  ): Promise<Removed | null> {
    const subject: ModuleSubject = { type: 'module', lang, moduleId };
    const copy = await firstValueFrom(
      this.api.get(
        '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
        { path: { changeSetId, lang, moduleId } },
      ),
    ).catch((error: unknown) => {
      if (toApiError(error).status === 404) return null;
      throw error;
    });
    if (!copy) return null;
    const { content, baseCommit } = copy.data.attributes;
    // Not saved: the committed file itself. Saved: committed only if the branch has a file too.
    const committed =
      !copy.data.meta.saved ||
      (await this.onBranch(changeSetId, moduleId, lang));
    return { subject, content, committed, baseCommit };
  }

  /** Whether the change set's branch (named, never the one chosen now) has the file. */
  private async onBranch(
    changeSetId: string,
    moduleId: string,
    lang: string,
  ): Promise<boolean> {
    return firstValueFrom(
      this.api.get('/modules/{lang}/{id}', {
        path: { lang, id: moduleId },
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

  /** Takes the lock for the change set (held already: nothing changes). */
  private async lock(
    changeSetId: string,
    subject: ModuleSubject,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/locks',
          { data: { type: 'Lock', attributes: { subject } } },
          { path: { changeSetId } },
        ),
      );
    } catch (error) {
      if (toApiError(error).code === 'locked') throw new Locked();
      throw error;
    }
  }

  /** The save point that deletes the committed languages; the commit, or the head unchanged. */
  private async commitDeletes(
    changeSetId: string,
    request: DeleteRequest,
    removed: readonly Removed[],
  ): Promise<string> {
    const deletes = removed.filter((r) => r.committed).map((r) => r.subject);
    if (deletes.length === 0) return removed[0]?.baseCommit ?? '';
    const answer = (await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/commits',
        {
          data: {
            type: 'Commit',
            attributes: {
              subjects: [],
              deletes,
              message: request.all
                ? `Delete module ${request.moduleId}`
                : `Delete module ${request.moduleId} (${deletes.map((d) => d.lang).join(', ')})`,
            },
          },
        },
        { path: { changeSetId } },
      ),
    )) as CommitAnswer;
    return 'data' in answer ? answer.data.id : answer.meta.head;
  }

  /** Writes every language back as it was, and commits those that were committed. */
  private async restore(record: Record): Promise<void> {
    const { changeSetId } = record;
    // The committed languages whose working copy is there to commit (an earlier try may have
    // committed some already).
    const subjects: ModuleSubject[] = [];
    for (const r of record.removed) {
      if (this.me.me().id !== record.person) throw new IdentityChanged();
      const path = {
        changeSetId,
        lang: r.subject.lang,
        moduleId: r.subject.moduleId,
      };
      await this.lock(changeSetId, r.subject).catch((error: unknown) => {
        throw error instanceof Locked ? new Taken() : error;
      });
      const now = await firstValueFrom(
        this.api.get(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
          { path },
        ),
      ).catch((error: unknown) => {
        if (toApiError(error).status === 404) return null;
        throw error;
      });
      if (now) {
        // Written back (or committed) by an earlier try of this Undo: done. Anything else is
        // someone's since.
        if (!sameJson(now.data.attributes.content, r.content))
          throw new Taken();
        if (r.committed && now.data.meta.saved) subjects.push(r.subject);
        continue;
      }
      await firstValueFrom(
        this.api.put(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
          { path },
          {
            data: { type: 'WorkingCopy', attributes: { content: r.content } },
            meta: {
              version: 0,
              baseCommit: r.committed ? record.commit : r.baseCommit,
            },
          },
        ),
      );
      if (r.committed) subjects.push(r.subject);
    }
    if (subjects.length === 0) return;
    if (this.me.me().id !== record.person) throw new IdentityChanged();
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/commits',
        {
          data: {
            type: 'Commit',
            attributes: {
              subjects,
              message: `Restore module ${record.moduleId}`,
            },
          },
        },
        { path: { changeSetId } },
      ),
    );
  }
}
