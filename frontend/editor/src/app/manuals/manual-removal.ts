import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type Schema } from '../api';
import type { TargetChangeSet } from '../content/module-creation';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';
import { manualSubject, type DraftManifest } from './manual-creation';

/** What `remove` asks for: the manual as the builder holds it. */
export interface ManualToRemove {
  readonly manualId: string;
  readonly title: string;
  /** The manifest as last saved: what an undo writes back. */
  readonly content: DraftManifest;
}

/** A manual removed in a change set, with what brings it back. */
export interface RemovedManual extends ManualToRemove {
  /** Whether its file was on the branch (deleted by a save point), else only a working copy. */
  readonly committed: boolean;
  readonly changeSet: TargetChangeSet;
  /** The commit a restored working copy is based on. */
  readonly base: string;
  /** Who removed it: only they may bring it back. */
  readonly person: string;
}

/**
 * Deletes manuals in a change set, and brings them back. A manual with a file on the branch is
 * deleted by a save point (`deletes: [manual/<id>]`, which drops its working copy too); one that
 * is only a working copy (a new manual with no entries yet) has its working copy discarded. The
 * lock stays with the change set, so an undo can write the manifest back at once. Published
 * content keeps the manual until the change set is merged.
 */
@Injectable({ providedIn: 'root' })
export class ManualRemoval {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();
  private readonly me = inject(MeService);

  /** Removes the manual; resolves what an undo needs, or null when it failed (with a toast). */
  async remove(
    manual: ManualToRemove,
    changeSet: TargetChangeSet,
  ): Promise<RemovedManual | null> {
    const person = this.me.me().id;
    try {
      await this.takeLock(manual.manualId, changeSet);
      // The branch decides, not what the page last knew: a save point may have committed a new
      // manual since. A file to delete goes in a save point; with none (422 `nothing-to-delete`),
      // the manual is only a working copy, which is discarded.
      let base = await this.deleteFile(manual.manualId, changeSet);
      const committed = base !== null;
      if (base === null) {
        const [set] = await Promise.all([
          firstValueFrom(
            this.api.get('/change-sets/{changeSetId}', {
              path: { changeSetId: changeSet.id },
            }),
          ),
          firstValueFrom(
            this.api.delete(
              '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
              {
                path: { changeSetId: changeSet.id, manualId: manual.manualId },
              },
            ),
          ).catch((error: unknown) => {
            // Gone already: nothing left to discard.
            if (toApiError(error).status !== 404) throw error;
          }),
        ]);
        base = set.data.attributes.baseCommit;
      }
      return { ...manual, committed, changeSet, base, person };
    } catch (error) {
      this.toast.error(
        this.failureText(
          translated('editor.manuals.delete.failed', { title: manual.title }),
          toApiError(error),
        ),
      );
      return null;
    }
  }

  /**
   * Writes the removed manual's manifest back into the change set (a save point when it was
   * committed); resolves whether it is back. Only for the person who removed it.
   */
  async restore(removed: RemovedManual): Promise<boolean> {
    if (this.me.me().id !== removed.person) return false;
    const { changeSet, manualId } = removed;
    try {
      await this.takeLock(manualId, changeSet);
      await firstValueFrom(
        this.api.put(
          '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
          { path: { changeSetId: changeSet.id, manualId } },
          {
            data: {
              type: 'WorkingCopy',
              attributes: { content: removed.content },
            },
            meta: { version: 0, baseCommit: removed.base },
          },
        ),
      );
      // A manifest needs an entry to be committed; a derived one, its rule (#669).
      if (
        removed.committed &&
        (removed.content.entries.length > 0 ||
          removed.content.kind === 'derived')
      ) {
        await firstValueFrom(
          this.api.post(
            '/change-sets/{changeSetId}/commits',
            {
              data: {
                type: 'Commit',
                attributes: {
                  subjects: [manualSubject(manualId)],
                  message: `Restore manual ${manualId}`,
                },
              },
            },
            { path: { changeSetId: changeSet.id } },
          ),
        ).catch(() => undefined); // in the working copy: the builder commits it later
      }
      this.toast.success(
        translated('editor.manuals.delete.restored', { title: removed.title }),
      );
      return true;
    } catch (error) {
      this.toast.error(
        this.failureText(
          translated('editor.manuals.delete.restoreFailed', {
            title: removed.title,
          }),
          toApiError(error),
        ),
      );
      return false;
    }
  }

  /** Deletes the manual's file in a save point; resolves the new head, or null when there is none. */
  private async deleteFile(
    manualId: string,
    changeSet: TargetChangeSet,
  ): Promise<string | null> {
    try {
      const doc = (await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/commits',
          {
            data: {
              type: 'Commit',
              attributes: {
                subjects: [],
                deletes: [manualSubject(manualId)],
                message: `Delete manual ${manualId}`,
              },
            },
          },
          { path: { changeSetId: changeSet.id } },
        ),
      )) as Schema<'CommitDocument'> | Schema<'NoCommitDocument'>;
      return 'data' in doc ? doc.data.id : doc.meta.head;
    } catch (error) {
      if (toApiError(error).code === 'nothing-to-delete') return null;
      throw error;
    }
  }

  private async takeLock(
    manualId: string,
    changeSet: TargetChangeSet,
  ): Promise<void> {
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/locks',
        {
          data: {
            type: 'Lock',
            attributes: { subject: manualSubject(manualId) },
          },
        },
        { path: { changeSetId: changeSet.id } },
      ),
    );
  }
}
