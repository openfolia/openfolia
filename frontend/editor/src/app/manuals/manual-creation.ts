import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LocalizedText } from '@openfolia/content-model/core';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import type { ProjectConfig } from '../content/browser-model';
import { sameJson, type TargetChangeSet } from '../content/module-creation';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { injectFailureText } from '../session/failure-text';
import { newRule } from './derived-rule';
import { headingText } from './manual-outline';
import { defaultVariant } from './manual-variants';

export type DraftManifest = Schema<'DraftManifest'>;

/** What the new-manual dialog asks for. */
export interface NewManual {
  readonly id: string;
  /** One text, or one per language (#731). */
  readonly title: LocalizedText;
  /** None: no audience limit, so modules of every audience are included. */
  readonly audience?: string | undefined;
  /** Start from a copy of this manual's entries, variants and text attributes. */
  readonly copyFrom?: string | undefined;
  /**
   * A derived manual (#451, #669) gathering from this manual: its rule names it, with
   * `moduleTypes` (none: the configured safety types), and it starts with its source's variants.
   */
  readonly derivedFrom?: string | undefined;
  readonly moduleTypes?: readonly string[] | undefined;
  /**
   * An update guide (#908): the version attribute it follows and the versions a reader picks
   * from (oldest first, at least two); it starts with no step.
   */
  readonly updateGuide?:
    | { readonly attribute: string; readonly versions: readonly string[] }
    | undefined;
  /** An update guide's product: the manual whose variants and text attributes it starts with. */
  readonly productFrom?: string | undefined;
}

/** A manual (or a working copy of one) with this ID is there already, and is not this one. */
class ManualExists extends Error {}

/** The person changed (another identity was picked) while the manual was being created. */
class IdentityChanged extends Error {}

/** The subject a manual's lock, working copy and commit name. */
export function manualSubject(manualId: string) {
  return { type: 'manual' as const, manualId };
}

/**
 * Creates manuals in a change set: takes the manual's lock, writes its manifest as the working
 * copy (a manual with nothing committed: title, audience, one default variant and no entries, or
 * the copy's entries, variants and text attributes; a derived manual: its rule and its source's
 * variants, #669) and, when it has entries (a derived manual: always), makes it a save point. A manifest with no entries cannot be committed: an empty new manual stays in the working
 * copy until its first module is added (the builder's save points commit it then). A refused save
 * point is not a failure: the working copy holds the manual, and the builder commits it later.
 *
 * An ID taken on the change set's branch, or by a working copy of this change set holding
 * something else, is refused before anything is taken (the working-copy read answers with the
 * branch's file when there is no working copy). A retry after an unknown outcome finds the
 * working copy holding exactly this manual and goes on from there, so it never makes two. The
 * steps stop when the person changes. One manual ID is created once at a time per change set.
 */
@Injectable({ providedIn: 'root' })
export class ManualCreation {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();
  private readonly me = inject(MeService);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly running = new Set<string>();

  /**
   * Creates `manual` in `changeSet`; resolves whether it was created. `created` runs once it is
   * (also after a retry from the failure toast), so the caller opens it either way.
   */
  async create(
    manual: NewManual,
    changeSet: TargetChangeSet,
    config: ProjectConfig,
    created: () => void = () => undefined,
  ): Promise<boolean> {
    const job = `${changeSet.id}\n${manual.id}`;
    if (this.running.has(job)) return false; // a double submit: the first one goes on
    this.running.add(job);
    const person = this.me.me().id;
    try {
      await this.run(manual, changeSet, config, person);
      this.toast.success(
        translated('editor.manuals.create.done', {
          title: headingText(manual.title, config.languages.source),
        }),
      );
      created();
      return true;
    } catch (error) {
      if (error instanceof IdentityChanged) return false;
      if (error instanceof ManualExists) {
        this.toast.error(
          translated('editor.manuals.create.exists', { id: manual.id }),
        );
        return false;
      }
      const failure: ApiError = toApiError(error);
      this.toast.error(
        this.failureText(
          translated('editor.manuals.create.failed', {
            title: headingText(manual.title, config.languages.source),
          }),
          failure,
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            // A retry acts as whoever is signed in when it is pressed: only the same person, in
            // the change set still chosen.
            if (
              this.me.me().id === person &&
              this.changeSets.selected()?.id === changeSet.id
            ) {
              void this.create(manual, changeSet, config, created);
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
    manual: NewManual,
    changeSet: TargetChangeSet,
    config: ProjectConfig,
    person: string,
  ): Promise<void> {
    const samePerson = () => {
      if (this.me.me().id !== person) throw new IdentityChanged();
    };
    const [set, source] = await Promise.all([
      firstValueFrom(
        this.api.get('/change-sets/{changeSetId}', {
          path: { changeSetId: changeSet.id },
        }),
      ),
      (manual.derivedFrom ?? manual.copyFrom ?? manual.productFrom)
        ? this.readSource(
            (manual.derivedFrom ??
              manual.copyFrom ??
              manual.productFrom) as string,
            changeSet,
          )
        : Promise.resolve(null),
    ]);
    const derived = manual.derivedFrom !== undefined;
    const guide = manual.updateGuide;
    const content: DraftManifest = {
      schemaVersion: 1,
      id: manual.id,
      ...(derived ? { kind: 'derived' as const } : {}),
      ...(guide ? { kind: 'update-guide' as const } : {}),
      title: manual.title,
      ...(manual.audience ? { audience: manual.audience } : {}),
      variants: source
        ? source.variants.map((v) => ({ ...v }))
        : [defaultVariant(config)],
      // A derived manual takes its source's text attributes when it is read: none of its own.
      attributes: source && !derived ? structuredClone(source.attributes) : {},
      ...(manual.derivedFrom
        ? { rule: newRule(manual.derivedFrom, manual.moduleTypes) }
        : {}),
      ...(guide
        ? {
            guide: {
              attribute: guide.attribute,
              versions: [...guide.versions],
              steps: [],
            },
          }
        : {}),
      // A derived manual's entries are gathered by its rule, never written; an update guide's
      // are its steps (#906), none yet; its product gives it variants and text attributes only.
      entries:
        source && !derived && !guide ? structuredClone(source.entries) : [],
    };
    const path = { changeSetId: changeSet.id, manualId: manual.id };
    const existing = await firstValueFrom(
      this.api.get(
        '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
        { path },
      ),
    ).catch((error: unknown) => {
      const failure = toApiError(error);
      if (failure.status === 404) return undefined;
      throw failure;
    });
    // This read answers with the working copy, else the file on the branch (`saved` false), so
    // a manual on the branch is found here too, whatever the lists showed.
    if (existing) {
      // An earlier attempt whose answer was lost got this far; anything else is not this one.
      if (!sameJson(existing.data.attributes.content, content)) {
        throw new ManualExists();
      }
      // It even made the save point: done.
      if (!existing.data.meta.saved) return;
    }
    samePerson();
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/locks',
        {
          data: {
            type: 'Lock',
            attributes: { subject: manualSubject(manual.id) },
          },
        },
        { path: { changeSetId: changeSet.id } },
      ),
    );
    if (!existing) {
      samePerson();
      await firstValueFrom(
        this.api.put(
          '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
          { path },
          {
            data: { type: 'WorkingCopy', attributes: { content } },
            meta: { version: 0, baseCommit: set.data.attributes.baseCommit },
          },
        ),
      );
    }
    // A manifest needs an entry to be committed; a derived one, its rule.
    if (content.entries.length === 0 && !derived) return;
    samePerson();
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/commits',
        {
          data: {
            type: 'Commit',
            attributes: {
              subjects: [manualSubject(manual.id)],
              message: `Add manual ${manual.id}`,
            },
          },
        },
        { path: { changeSetId: changeSet.id } },
      ),
    ).catch(() => undefined); // the builder makes the save point later
  }

  /**
   * The manual to copy, as the person sees it in the change set: their working copy of it (or its
   * file there), else the manifest read on the branch.
   */
  private async readSource(
    manualId: string,
    changeSet: TargetChangeSet,
  ): Promise<Pick<DraftManifest, 'variants' | 'attributes' | 'entries'>> {
    try {
      const copy = await firstValueFrom(
        this.api.get(
          '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
          { path: { changeSetId: changeSet.id, manualId } },
        ),
      );
      return copy.data.attributes.content;
    } catch (error) {
      const failure = toApiError(error);
      if (failure.status !== 403 && failure.status !== 404) throw failure;
    }
    const doc = await firstValueFrom(
      this.api.get('/manuals/{id}', {
        path: { id: manualId },
        query: { ref: changeSet.branch },
      }),
    );
    const a = doc.data.attributes;
    return {
      variants: a.variants,
      attributes: a.textAttributes ?? {},
      entries: a.entries,
    };
  }
}
