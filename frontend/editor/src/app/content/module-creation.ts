import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { Block } from '@openfolia/content-model/core';
import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, ApiError, toApiError, type Schema } from '../api';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';

type ModuleContent = Schema<'Module'>;

/** What the new-module dialog asks for. */
export interface NewModule {
  readonly id: string;
  readonly title: string;
  /** The module's language: its source language. */
  readonly lang: string;
  readonly type: string;
  readonly audience?: string | undefined;
  readonly facets: Readonly<Record<string, readonly string[]>>;
  /** Free-form keywords in the module's language; none when empty. */
  readonly keywords?: readonly string[] | undefined;
  /** Start from a copy of this module's blocks (in this language). */
  readonly copyFrom?:
    { readonly id: string; readonly lang: string } | undefined;
  /** Start with these blocks (a snippet saved from a selection, #309); `copyFrom` wins. */
  readonly blocks?: readonly Block[] | undefined;
}

/** What `ModuleCreation.create` may be told besides the module and its change set. */
export interface CreateOptions {
  /** It can never be created (the ID is taken, or 403): no retry is offered. */
  readonly onRefused?: () => void;
  /** It was created (now, or by a retry the failure toast offered). */
  readonly onCreated?: () => void;
  /** The toast once it is created; default: "Module “…” created."; null: none (the caller says). */
  readonly doneText?: TranslatedText | null;
}

/** The change set a module is created in. */
export interface TargetChangeSet {
  readonly id: string;
  readonly branch: string;
}

/** A module being created: shown at once, before the API has answered. */
export interface PendingModule {
  readonly key: number;
  readonly module: NewModule;
  readonly changeSetId: string;
}

/** A module (or a working copy of one) with this ID is there already, and is not ours. */
class ModuleExists extends Error {}

/** The person changed (another identity was picked) while the module was being created. */
class IdentityChanged extends Error {}

/** How many module summaries are read per page while looking for a module ID. */
const ID_SEARCH_PAGE_SIZE = 100;

/** Statuses that leave a write's outcome unknown: no answer, or a gateway's. */
const UNKNOWN_OUTCOME = new Set([0, 502, 503, 504]);

/** Equal as JSON whatever the order of object members (the database may reorder them). */
export function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Creates modules in a change set, eagerly: the module is listed at once (`pending`) while the
 * API takes the lock, saves the working copy and commits it (a save point), so it is on the
 * change set's branch for everyone who reads it. A failure takes it back out with a toast that
 * offers a retry. When this tab saved the working copy itself (now, or in an attempt whose
 * outcome was unknown), a refused commit discards it and releases the lock, so a corrected
 * attempt starts clean; what another tab made is never removed. An unknown outcome of the save
 * or the commit (no answer, or a proxy's 502/503/504) keeps them: the commit may have gone through, and a retry then finds the working copy
 * holding exactly this module and counts it as done, so it never makes two. A module ID that
 * exists already, in any language the person reads, is refused before anything is taken. The
 * steps stop when the person changes; what was taken by then stays theirs (the new person may
 * not release it). One module is created once at a time per change set in this tab.
 */
@Injectable({ providedIn: 'root' })
export class ModuleCreation {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();
  private readonly me = inject(MeService);
  private keys = 0;
  private readonly running = new Set<string>();
  /** Working copies (change set, language, ID) this tab may have saved and kept after an
   * unknown outcome: a retry resumes them as its own. */
  private readonly kept = new Set<string>();

  private readonly list = signal<readonly PendingModule[]>([]);
  /** The modules being created, newest first. */
  readonly pending = this.list.asReadonly();
  /** Counts the modules created: lists read again when it changes. */
  readonly created = signal(0);

  /**
   * Creates `module` in `changeSet`; resolves whether it was created. `onRefused` runs when it
   * never can be (the ID is taken, or 403): then no retry is offered with it (#137: a change set
   * started for the module alone is given up).
   */
  async create(
    module: NewModule,
    changeSet: TargetChangeSet,
    options: CreateOptions = {},
  ): Promise<boolean> {
    // One module ID once at a time per change set, whatever the language (the ID check spans all).
    const job = `${changeSet.id}\n${module.id}`;
    if (this.running.has(job)) return false; // a double submit: the first one goes on
    this.running.add(job);
    const key = ++this.keys;
    const person = this.me.me().id;
    this.list.update((list) => [
      { key, module, changeSetId: changeSet.id },
      ...list,
    ]);
    try {
      await this.run(module, changeSet, person);
      this.created.update((n) => n + 1);
      if (options.doneText !== null) {
        this.toast.success(
          options.doneText ??
            translated('editor.content.create.done', { title: module.title }),
        );
      }
      options.onCreated?.();
      return true;
    } catch (error) {
      if (error instanceof IdentityChanged) return false;
      if (error instanceof ModuleExists) {
        this.toast.error(
          translated('editor.content.create.exists', { id: module.id }),
        );
        options.onRefused?.();
        return false;
      }
      const failure: ApiError = toApiError(error);
      if (options.onRefused && failure.status === 403) {
        this.toast.error(
          this.failureText(
            translated('editor.content.create.failed', { title: module.title }),
            failure,
          ),
        );
        options.onRefused();
        return false;
      }
      this.toast.error(
        this.failureText(
          translated('editor.content.create.failed', { title: module.title }),
          failure,
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            // A retry acts as whoever is signed in when it is pressed: only the same person.
            if (this.me.me().id === person) {
              void this.create(module, changeSet, options);
            }
          },
        },
      );
      return false;
    } finally {
      this.running.delete(job);
      this.list.update((list) => list.filter((p) => p.key !== key));
    }
  }

  private async run(
    module: NewModule,
    changeSet: TargetChangeSet,
    person: string,
  ): Promise<void> {
    const samePerson = () => {
      if (this.me.me().id !== person) throw new IdentityChanged();
    };
    const subject = {
      type: 'module' as const,
      lang: module.lang,
      moduleId: module.id,
    };
    const [set, blocks] = await Promise.all([
      firstValueFrom(
        this.api.get('/change-sets/{changeSetId}', {
          path: { changeSetId: changeSet.id },
        }),
      ),
      module.copyFrom
        ? firstValueFrom(
            this.api.get('/modules/{lang}/{id}', {
              path: module.copyFrom,
              query: { ref: changeSet.branch },
            }),
          ).then((doc) => doc.data.attributes.blocks)
        : Promise.resolve(module.blocks ? [...module.blocks] : []),
    ]);
    const content: ModuleContent = {
      schemaVersion: 1,
      id: module.id,
      meta: {
        title: module.title,
        type: module.type,
        lang: module.lang,
        ...(module.audience ? { audience: module.audience } : {}),
        facets: Object.fromEntries(
          Object.entries(module.facets)
            .filter(([, values]) => values.length > 0)
            .map(([id, values]) => [id, [...values]]),
        ),
        ...(module.keywords?.length ? { keywords: [...module.keywords] } : {}),
      },
      blocks,
    };
    const path = {
      changeSetId: changeSet.id,
      lang: module.lang,
      moduleId: module.id,
    };
    const copy = `${changeSet.id}\n${module.lang}\n${module.id}`;
    const existing = await firstValueFrom(
      this.api.get(
        '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
        { path },
      ),
    ).catch((error: unknown) => {
      const failure = toApiError(error);
      if (failure.status === 404) return undefined;
      throw failure;
    });
    // None there: a kept entry from an unknown-outcome save that never landed no longer applies.
    if (!existing) this.kept.delete(copy);
    if (existing) {
      // An earlier attempt whose commit answer was lost got this far; anything else is not ours.
      if (!sameJson(existing.data.attributes.content, content)) {
        throw new ModuleExists();
      }
      if (!existing.data.meta.saved) {
        this.kept.delete(copy);
        return; // committed already
      }
    } else if (await this.idExists(module.id, changeSet.branch)) {
      throw new ModuleExists();
    }
    samePerson();
    const lock = await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/locks',
        { data: { type: 'Lock', attributes: { subject } } },
        { path: { changeSetId: changeSet.id } },
      ),
    );
    /** Whether this tab saved the working copy: only then are the lock and the copy its own. */
    let ours = !!existing && this.kept.has(copy);
    /** Whether this attempt sent the save: an unknown answer to it may still have saved. */
    let putSent = false;
    try {
      if (!existing) {
        samePerson();
        putSent = true;
        await firstValueFrom(
          this.api.put(
            '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
            { path },
            {
              data: { type: 'WorkingCopy', attributes: { content } },
              meta: { version: 0, baseCommit: set.data.attributes.baseCommit },
            },
          ),
        );
        ours = true;
      }
      samePerson();
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/commits',
          {
            data: {
              type: 'Commit',
              attributes: {
                subjects: [subject],
                message: `Add module ${module.id}`,
              },
            },
          },
          { path: { changeSetId: changeSet.id } },
        ),
      );
      this.kept.delete(copy);
    } catch (error) {
      // The person changed: what was saved stays theirs, for their retry.
      if (error instanceof IdentityChanged) {
        if (ours) this.kept.add(copy);
        throw error;
      }
      // An unknown outcome: the save or the commit may have gone through, so keep what a
      // retry resumes from.
      // An HTTP failure (an `ApiError` from the API layer, or a raw one); anything else, such
      // as a bug in this code, is no answer from the API and so no sign the write went through.
      const http =
        error instanceof ApiError || error instanceof HttpErrorResponse
          ? toApiError(error)
          : null;
      const unknown =
        !!http && http.kind !== 'unknown' && UNKNOWN_OUTCOME.has(http.status);
      if (unknown && (ours || putSent)) {
        this.kept.add(copy);
      } else if (ours && this.me.me().id === person) {
        this.kept.delete(copy);
        await this.rollBack(path, lock.data.id);
      }
      throw error;
    }
  }

  /** Whether a module with this ID is on `branch` in any language. */
  private async idExists(id: string, branch: string): Promise<boolean> {
    for (let page = 1; ; page++) {
      const found = await firstValueFrom(
        this.api.get('/module-summaries', {
          query: {
            ref: branch,
            'filter[q]': id,
            'page[number]': page,
            'page[size]': ID_SEARCH_PAGE_SIZE,
          },
        }),
      );
      if (found.data.some((s) => s.id === id)) return true;
      if (!found.links.next) return false;
    }
  }

  /** Discards the working copy (when saved) and releases the lock; best effort. */
  private async rollBack(
    workingCopy:
      { changeSetId: string; lang: string; moduleId: string } | undefined,
    lockId: string,
  ): Promise<void> {
    if (workingCopy) {
      await firstValueFrom(
        this.api.delete(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
          { path: workingCopy },
        ),
      ).catch(() => undefined);
    }
    await firstValueFrom(
      this.api.delete('/locks/{lockId}', { path: { lockId } }),
    ).catch(() => undefined);
  }
}
