import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../../api';
import { MeService } from '../../permissions/me';
import { PermissionService } from '../../permissions/permission.service';
import { injectFailureText } from '../../session/failure-text';
import {
  configProblem,
  usagePlaces,
  type ProjectConfig,
  type UsagePlace,
} from './config-model';

/** The change set the configuration is read in (and changed in, when the person may). */
export interface ConfigChangeSet {
  readonly id: string;
  readonly branch: string;
  readonly state: string;
  /** Who started it; empty while unknown (the API then decides). */
  readonly authorId: string;
}

/** Whether the settings can be changed now, and if not, why (a key; null: the role never can). */
export type ConfigMode =
  | { readonly kind: 'edit' }
  | { readonly kind: 'read'; readonly reason: string | null };

/** A change the usage check refused: what it was, and where content uses what it took away. */
export interface ConfigRefusal {
  /** What the change was, for the dialog's heading. */
  readonly what: TranslatedText;
  readonly places: readonly UsagePlace[];
  /** How many places there are; more than `places` when the API listed only the first ones. */
  readonly total: number;
}

/** How long the settings stay unchanged before the working copy becomes a save point. */
export const CONFIG_SAVE_POINT_DELAY_MS = 30_000;

/** Statuses that leave a write's outcome unknown: no answer, or a gateway's. */
const UNKNOWN_OUTCOME = new Set([0, 502, 503, 504]);

const SUBJECT = { type: 'config' } as const;

/**
 * The project configuration as the settings edit it, provided per page. Reads it in the chosen
 * change set: its working copy when the person may change it there (a draft they started, not
 * locked by another change set; the API also asks for `admin.roles` and an unrestricted
 * `content.edit`), else what is committed, read-only with the reason.
 *
 * Saving is eager: a change shows at once (`config`) and is saved into the working copy (taking
 * the configuration's lock first), one save at a time with the newest configuration. A refusal
 * puts back the last saved configuration: a value content still uses (`config-in-use`) is told
 * through `refusal` (the page asks what to do), anything else with a toast offering Retry. After a
 * quiet `CONFIG_SAVE_POINT_DELAY_MS` and when the page is left (`savePoint`), the working copy
 * becomes a save point. Nothing of an earlier `load` applies after a newer one.
 */
@Injectable()
export class ConfigDraft {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly error = signal<ApiError | null>(null);
  readonly config = signal<ProjectConfig | null>(null);
  readonly mode = signal<ConfigMode>({ kind: 'read', reason: null });
  /** The working copy's state since this page changed it; null before the first change. */
  readonly saveState = signal<'saved' | 'saving' | 'not-saved' | null>(null);
  /** The last change the usage check refused; the page shows it and clears it. */
  readonly refusal = signal<ConfigRefusal | null>(null);
  /** Counts the save points made here (what usage counts are read again after). */
  readonly commits = signal(0);

  private generation = 0;
  private changeSet: ConfigChangeSet | null = null;
  /** The configuration last saved (or read): what a refusal puts back. */
  private confirmed: ProjectConfig | null = null;
  private version = 0;
  private baseCommit = '';
  private lockHeld = false;
  private uncommitted = false;
  /** The newest configuration not sent yet, and what changed in it. */
  private target: { config: ProjectConfig; what: TranslatedText } | null = null;
  private draining = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts changes: a Retry offered before a newer change has nothing left to do. */
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
   * An identity switch begins (#716): nothing asked for the person before (a read, a save, its
   * save point) lands or is sent from now on, and nothing is changed meanwhile. What is shown
   * stays, read-only, until the next `load`.
   */
  forget(): void {
    this.generation++;
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

  /** Reads the configuration in `changeSet` (null: the released content). Never rejects. */
  async load(changeSet: ConfigChangeSet | null): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.changeSet = changeSet;
    this.target = null;
    this.draining = false;
    this.lockHeld = false;
    this.uncommitted = false;
    this.chain = Promise.resolve();
    this.saveState.set(null);
    this.refusal.set(null);
    this.status.set('loading');
    this.error.set(null);
    const stale = () => generation !== this.generation;
    try {
      const reason = this.readReason(changeSet);
      if (reason !== undefined || !changeSet) {
        const doc = await firstValueFrom(
          this.api.get('/config', {
            ...(changeSet ? { query: { ref: changeSet.branch } } : {}),
          }),
        );
        if (stale()) return;
        this.show(doc.data.attributes, {
          kind: 'read',
          reason: reason ?? null,
        });
        return;
      }
      const [copy, locks] = await Promise.all([
        firstValueFrom(
          this.api.get('/change-sets/{changeSetId}/config/working-copy', {
            path: { changeSetId: changeSet.id },
          }),
        ).catch((error: unknown) => {
          const failure = toApiError(error);
          // Not theirs to change: read what is committed.
          if (failure.status === 403 || failure.status === 404) return null;
          throw failure;
        }),
        firstValueFrom(
          this.api.get('/locks', { query: { 'filter[subject]': 'config' } }),
        ).catch(() => null),
      ]);
      if (stale()) return;
      if (!copy) {
        const doc = await firstValueFrom(
          this.api.get('/config', { query: { ref: changeSet.branch } }),
        );
        if (stale()) return;
        this.show(doc.data.attributes, {
          kind: 'read',
          reason: 'editor.admin.settings.blocked.forbidden',
        });
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
          ? { kind: 'read', reason: 'editor.admin.settings.blocked.locked' }
          : { kind: 'edit' },
      );
      if (this.uncommitted && !lockedElsewhere) this.schedule();
    } catch (error) {
      if (stale()) return;
      this.error.set(toApiError(error));
      this.status.set('error');
    }
  }

  /** Why the settings are read-only in this change set (a key), null if the role never edits, undefined if they may. */
  private readReason(
    changeSet: ConfigChangeSet | null,
  ): string | null | undefined {
    const may = (permission: 'content.edit' | 'admin.roles') =>
      this.permissions.state({ permission }).kind !== 'hidden';
    if (!may('content.edit') || !may('admin.roles')) return null;
    if (!changeSet) return 'editor.admin.settings.blocked.needsChangeSet';
    if (changeSet.state !== 'draft')
      return 'editor.admin.settings.blocked.notDraft';
    if (changeSet.authorId !== '' && changeSet.authorId !== this.me.me().id) {
      return 'editor.admin.settings.blocked.notAuthor';
    }
    return undefined;
  }

  private show(config: ProjectConfig, mode: ConfigMode): void {
    this.confirmed = config;
    this.config.set(config);
    this.mode.set(mode);
    this.status.set('ready');
  }

  /**
   * Shows `next` at once and saves it into the working copy (only once read, to edit). `what`
   * names the change for a refusal. A configuration the content model would refuse is not sent.
   */
  change(next: ProjectConfig, what: TranslatedText): boolean {
    if (this.destroyed || this.status() !== 'ready') return false;
    if (this.mode().kind !== 'edit') return false;
    const problem = configProblem(next);
    if (problem !== null) {
      // The forms keep to the schema; this is the last guard, never a silent save.
      this.toast.error(translated('editor.admin.settings.save.invalid'));
      return false;
    }
    clearTimeout(this.timer);
    this.edits++;
    this.config.set(next);
    this.target = { config: next, what };
    this.saveState.set('saving');
    if (!this.draining) {
      this.draining = true;
      const generation = this.generation;
      void this.enqueue(() => this.drain(generation));
    }
    return true;
  }

  /**
   * Resolves once the saves queued so far are done: whether the newest change is saved (false
   * when one was refused, the draft was read again or went away meanwhile).
   */
  async settled(): Promise<boolean> {
    await this.enqueue(() => Promise.resolve());
    return !this.destroyed && this.saveState() === 'saved';
  }

  /** Makes the saved working copy a save point now (after the saves before it); resolves whether nothing is left uncommitted. */
  savePoint(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.destroyed) return Promise.resolve(false);
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
    if (this.destroyed) return;
    this.timer = setTimeout(
      () => void this.savePoint(),
      CONFIG_SAVE_POINT_DELAY_MS,
    );
  }

  private async drain(generation: number): Promise<void> {
    const stale = () => generation !== this.generation;
    const changeSet = this.changeSet;
    if (!changeSet) return;
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
            '/change-sets/{changeSetId}/config/working-copy',
            { path: { changeSetId: changeSet.id } },
            {
              data: {
                type: 'WorkingCopy',
                attributes: { content: sending.config },
              },
              meta: { version: this.version, baseCommit: this.baseCommit },
            },
          ),
        );
        if (stale()) return;
        this.version = doc.data.attributes.version;
        this.baseCommit = doc.data.attributes.baseCommit;
        this.confirmed = sending.config;
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

  /** A save was refused: the last saved configuration comes back, and the person is told why. */
  private refused(
    sending: { config: ProjectConfig; what: TranslatedText },
    failure: ApiError,
  ): void {
    // A change made while this one was sent already holds it: a retry sends that one.
    const newest = this.target ?? sending;
    this.target = null;
    this.config.set(this.confirmed);
    this.saveState.set('not-saved');
    // What was saved before stays due for a save point.
    if (this.uncommitted) this.schedule();
    if (failure.code === 'config-in-use') {
      const places = usagePlaces(failure.errors);
      this.refusal.set({
        what: sending.what,
        places,
        total: Math.max(places.length, failure.errors.length),
      });
      // Nothing to retry: the content has to change first, or the value be archived.
      this.saveState.set(this.uncommitted ? 'saved' : null);
      return;
    }
    const what = translated('editor.admin.settings.save.failed');
    if (failure.code === 'lock-required') this.lockHeld = false;
    if (failure.code === 'locked') {
      this.mode.set({
        kind: 'read',
        reason: 'editor.admin.settings.blocked.locked',
      });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (failure.status === 403) {
      this.mode.set({
        kind: 'read',
        reason: 'editor.admin.settings.blocked.forbidden',
      });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (
      failure.code === 'version-conflict' ||
      failure.code === 'stale-working-copy' ||
      UNKNOWN_OUTCOME.has(failure.status)
    ) {
      this.toast.error(translated('editor.admin.settings.save.reloaded'));
      void this.load(this.changeSet);
      return;
    }
    const generation = this.generation;
    const edits = this.edits;
    this.toast.error(this.failureText(what, failure), {
      actionLabel: translated('editor.session.retry'),
      onAction: () => {
        // A newer change since is saved on its own: retrying would undo it.
        if (generation === this.generation && edits === this.edits) {
          this.change(newest.config, newest.what);
        }
      },
    });
  }

  private async takeLock(changeSet: ConfigChangeSet): Promise<void> {
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/locks',
        { data: { type: 'Lock', attributes: { subject: SUBJECT } } },
        { path: { changeSetId: changeSet.id } },
      ),
    );
  }

  private async commit(generation: number): Promise<boolean> {
    const changeSet = this.changeSet;
    if (generation !== this.generation || !changeSet) return false;
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
                subjects: [SUBJECT],
                message: 'Update the project settings',
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
      const what = translated('editor.admin.settings.save.savePointFailed');
      if (failure.code === 'config-in-use') {
        // Content changed since the save: the working copy stays, and says where.
        const places = usagePlaces(failure.errors);
        this.refusal.set({
          what,
          places,
          total: Math.max(places.length, failure.errors.length),
        });
        return false;
      }
      if (failure.code === 'locked') {
        this.mode.set({
          kind: 'read',
          reason: 'editor.admin.settings.blocked.locked',
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
        this.toast.error(translated('editor.admin.settings.save.reloaded'));
        void this.load(this.changeSet);
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
