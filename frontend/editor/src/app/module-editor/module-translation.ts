import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { LanguageService, translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, ApiError, toApiError } from '../api';
import { languageName } from '../content/browser-model';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';
import type { ModuleContent } from './module-model';

/** A language version to start: `moduleId` in `to`, copied from `from`. */
export interface TranslationStart {
  readonly moduleId: string;
  readonly from: string;
  readonly to: string;
  /** The module's title, for the toasts. */
  readonly title: string;
}

/** The person changed while it ran. */
class IdentityChanged extends Error {}

/** The language is locked by another change set. */
class Locked extends Error {}

/**
 * The working copy a new language version starts from: the source's blocks with their IDs and
 * its metadata, in the new language (`meta.lang`), so the translator overwrites the text block by
 * block and every block keeps the ID a translation is matched by. A deprecation is not copied:
 * the module's is its source-language file's (#266).
 */
export function translationOf(
  source: ModuleContent,
  lang: string,
): ModuleContent {
  const { deprecated: _, ...meta } = source.meta;
  return { ...source, meta: { ...meta, lang } };
}

/**
 * Starts a module's version in another language in a draft change set: takes the lock for
 * `module/<to>/<id>` and saves a working copy copied from the source language (what the person's
 * working copy of it holds, else the committed file). Nothing is committed here: the module
 * editor opens on the working copy, and its save point (leaving the module, every few minutes)
 * puts the new language on the branch. A working copy there already (another tab started it) is
 * left as it is and opened. The lock stays with the change set, as the module editor's does.
 */
@Injectable({ providedIn: 'root' })
export class ModuleTranslation {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly language = inject(LanguageService);
  private readonly failureText = injectFailureText();
  private readonly running = new Set<string>();

  /** Starts `start` in `changeSetId`; resolves whether the working copy is there to open. */
  async start(
    start: TranslationStart,
    changeSetId: string,
    /** Who asked for it (the caller read it before waiting); nothing is done for anyone else. */
    person = this.me.me().id,
  ): Promise<boolean> {
    const job = `${changeSetId}\n${start.to}\n${start.moduleId}`;
    if (this.running.has(job) || this.me.me().id !== person) return false;
    this.running.add(job);
    const language = languageName(this.language.locale(), start.to);
    try {
      await this.run(start, changeSetId, person);
      return true;
    } catch (error) {
      if (error instanceof IdentityChanged) return false;
      if (error instanceof Locked) {
        this.toast.error(
          translated('editor.moduleEditor.translate.locked', { language }),
        );
        return false;
      }
      this.toast.error(
        this.failureText(
          translated('editor.moduleEditor.translate.failed', {
            title: start.title,
            language,
          }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            if (this.me.me().id === person) {
              void this.start(start, changeSetId, person);
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
    start: TranslationStart,
    changeSetId: string,
    person: string,
  ): Promise<void> {
    const samePerson = () => {
      if (this.me.me().id !== person) throw new IdentityChanged();
    };
    const copyPath = (lang: string) => ({
      changeSetId,
      lang,
      moduleId: start.moduleId,
    });
    const read = (lang: string) =>
      firstValueFrom(
        this.api.get(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
          { path: copyPath(lang) },
        ),
      ).catch((error: unknown) => {
        if (toApiError(error).status === 404) return null;
        throw error;
      });
    const [existing, source, set] = await Promise.all([
      read(start.to),
      read(start.from),
      firstValueFrom(
        this.api.get('/change-sets/{changeSetId}', { path: { changeSetId } }),
      ),
    ]);
    // Started already (another tab), or committed meanwhile: it is opened as it is.
    if (existing) return;
    if (!source) {
      throw new ApiError('not-found', 404, 'not-found', 'Not found.');
    }
    samePerson();
    const subject = {
      type: 'module' as const,
      lang: start.to,
      moduleId: start.moduleId,
    };
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
    samePerson();
    const saved = firstValueFrom(
      this.api.put(
        '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
        { path: copyPath(start.to) },
        {
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: translationOf(source.data.attributes.content, start.to),
            },
          },
          // Nothing of this language is on the branch: the change set's base stands for it.
          meta: { version: 0, baseCommit: set.data.attributes.baseCommit },
        },
      ),
    );
    await saved.catch((error: unknown) => {
      // Saved by another tab in the meantime: that one is opened.
      if (toApiError(error).code === 'version-conflict') return;
      throw error;
    });
  }
}
