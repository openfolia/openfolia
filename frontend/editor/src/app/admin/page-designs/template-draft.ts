import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../../api';
import { MeService } from '../../permissions/me';
import { PermissionService } from '../../permissions/permission.service';
import { injectFailureText } from '../../session/failure-text';
import { SandboxSession } from '../../sandbox/sandbox-session';
import type { DesignChangeSet, DesignMode } from './design-draft';

/** A file of a template's folder as the screen lists it. */
export interface TemplateFileRow {
  readonly path: string;
  readonly size: number;
  /** Edited as text; an image or font is only listed. */
  readonly text: boolean;
  /** The change set's working copy stands in for it. */
  readonly draft: boolean;
  /** The revision's branch has it (false: only a working copy holds it, deleted by dropping it). */
  readonly committed: boolean;
}

/** The largest file a template may hold, in bytes of UTF-8 (the API's `MAX_TEMPLATE_FILE_BYTES`). */
export const TEMPLATE_FILE_MAX_BYTES = 256 * 1024;
/** The most files a template folder holds (the API's `MAX_TEMPLATE_FILES`): one read lists them all. */
const LIST_SIZE = 200;
/** After the last keystroke, the file waits this long before it is saved. */
export const TEMPLATE_SAVE_DELAY_MS = 700;
/** How long the files stay unchanged before their working copies become a save point. */
export const TEMPLATE_SAVE_POINT_DELAY_MS = 30_000;
/** How long a save point may take before it is given up. */
const SAVE_POINT_TIMEOUT_MS = 20_000;
/** The template's entry file: never deleted on this screen (the template would be gone). */
export const TEMPLATE_ENTRY = 'manual.typ';

/** What the screen knows of a file it has saved or read in the change set. */
interface FileState {
  version: number;
  baseCommit: string;
  lockHeld: boolean;
  /** A working copy is saved that no save point holds yet. */
  uncommitted: boolean;
}

const encoder = new TextEncoder();
/** The file's size as the API counts it. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * A page design template's files (#396), as the template screen edits them, provided per screen:
 * the folder's listing in the chosen change set and the one file open. Each text file is its own
 * subject of the change set (`template/<id>/<path>`): its lock, its working copy, written like
 * any other project file. Changeable where page designs are (the person's own draft revision, a
 * role whose `content.edit` restricts nothing, no other revision holding the file's lock); else
 * read-only with the reason.
 *
 * Typing shows at once (`text`) and is saved into the file's working copy a short while after the
 * last keystroke (`TEMPLATE_SAVE_DELAY_MS`), one save at a time; each counts `saves`, which the
 * preview follows. After a quiet `TEMPLATE_SAVE_POINT_DELAY_MS`, when another file opens and when
 * the screen is left (`savePoint`), the template's saved working copies become one save point.
 * A refused save keeps the text, says why and offers to try again; a conflict reads the file
 * again.
 */
@Injectable()
export class TemplateDraft {
  private readonly api = inject(ApiClient);
  private readonly sandbox = inject(SandboxSession);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  /** The folder's listing. */
  readonly status = signal<'idle' | 'loading' | 'ready' | 'missing' | 'error'>(
    'idle',
  );
  readonly error = signal<ApiError | null>(null);
  readonly files = signal<readonly TemplateFileRow[]>([]);
  /** Whether the template can be changed here at all; the file open may still be locked elsewhere. */
  readonly mode = signal<DesignMode>({ kind: 'read', reason: null });

  /** The file open; null: none. */
  readonly path = signal<string | null>(null);
  readonly fileStatus = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly fileError = signal<ApiError | null>(null);
  /** The open file's text, as typed. */
  readonly text = signal('');
  /** The open file is locked by another revision. */
  readonly fileLocked = signal(false);
  /** The working copies' state since this screen changed them; null before the first change. */
  readonly saveState = signal<'saved' | 'saving' | 'not-saved' | null>(null);
  /** Counts the saves of working copies: the preview renders again after each. */
  readonly saves = signal(0);
  /** Whether the preview reads the working copies (the person's own draft revision). */
  readonly live = signal(false);
  /** The open file is past `TEMPLATE_FILE_MAX_BYTES`: it is not saved until it is smaller. */
  readonly tooLarge = computed(
    () => utf8Bytes(this.text()) > TEMPLATE_FILE_MAX_BYTES,
  );
  readonly editable = computed(
    () =>
      this.mode().kind === 'edit' &&
      this.status() === 'ready' &&
      this.fileStatus() === 'ready' &&
      !this.fileLocked(),
  );

  /** Whether the person may ever change templates (the API also asks for an unrestricted scope). */
  readonly mayEdit = computed(
    () =>
      this.permissions.state({ permission: 'content.edit' }).kind !== 'hidden',
  );

  private changeSet: DesignChangeSet | null = null;
  private templateId = '';
  private readonly state = new Map<string, FileState>();
  /** Counts loads of the template: an answer for an earlier one no longer applies. */
  private generation = 0;
  /** Counts opened files: an answer for a file no longer open no longer applies. */
  private opened = 0;
  /** Text typed and not yet sent, by path. */
  private readonly pending = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pointTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.generation++;
      clearTimeout(this.saveTimer);
      clearTimeout(this.pointTimer);
    });
  }

  /**
   * An identity switch is unanswered (#716): nothing typed is sent under the next person, and
   * nothing is editable until the next `load`.
   */
  forget(): void {
    this.generation++;
    this.opened++;
    clearTimeout(this.saveTimer);
    clearTimeout(this.pointTimer);
    this.pending.clear();
    if (this.saveState() === 'saving') this.saveState.set('not-saved');
    if (this.mode().kind === 'edit') {
      this.mode.set({
        kind: 'read',
        reason: 'editor.changeSet.switchingReason',
      });
    }
  }

  /**
   * Reads the template `templateId`'s files in `changeSet` (null: the released content); what this
   * screen saved of another template or revision becomes a save point first. A template with no
   * file (nor a working copy of one) is `missing`. Never rejects.
   */
  async load(
    changeSet: DesignChangeSet | null,
    templateId: string,
  ): Promise<void> {
    if (this.destroyed) return;
    const elsewhere =
      changeSet?.id !== this.changeSet?.id || templateId !== this.templateId;
    // What is typed is sent first, also when the same template is read again (#396).
    if (
      (elsewhere || this.pending.size > 0) &&
      this.changeSet &&
      this.mode().kind === 'edit'
    ) {
      this.status.set('loading');
      await this.savePoint();
    }
    const generation = ++this.generation;
    this.opened++;
    clearTimeout(this.saveTimer);
    clearTimeout(this.pointTimer);
    this.pending.clear();
    this.state.clear();
    this.chain = Promise.resolve();
    this.changeSet = changeSet;
    this.templateId = templateId;
    this.status.set('loading');
    this.error.set(null);
    this.saveState.set(null);
    this.path.set(null);
    this.fileStatus.set('idle');
    const reason = this.readReason(changeSet);
    this.mode.set(
      reason === undefined ? { kind: 'edit' } : { kind: 'read', reason },
    );
    this.live.set(reason === undefined);
    try {
      const files = await this.readFiles();
      if (generation !== this.generation) return;
      this.files.set(files);
      this.status.set('ready');
    } catch (error) {
      if (generation !== this.generation) return;
      const failure = toApiError(error);
      if (failure.status === 404) {
        this.files.set([]);
        this.status.set('missing');
        return;
      }
      this.error.set(failure);
      this.status.set('error');
    }
  }

  /** Reads the listing again (after a file is made or deleted). */
  async refreshFiles(): Promise<void> {
    const generation = this.generation;
    try {
      const files = await this.readFiles();
      if (generation === this.generation) this.files.set(files);
    } catch {
      // The listing shown stays: the next change reads it again.
    }
  }

  private async readFiles(): Promise<TemplateFileRow[]> {
    const cs = this.changeSet;
    const doc = await firstValueFrom(
      this.api.get('/page-design-templates/{templateId}/files', {
        path: { templateId: this.templateId },
        query: {
          'page[size]': LIST_SIZE,
          ...(cs ? { ref: cs.branch } : {}),
          ...(cs && this.live() ? { workingCopy: 'true' } : {}),
        } as never,
      }),
    );
    return doc.data.map((f) => ({
      path: f.attributes.path,
      size: f.attributes.size,
      text: f.attributes.text,
      draft: f.meta.draft,
      committed: f.meta.committed,
    }));
  }

  /** Why the template is read-only in this change set (a key), null if the role never edits, undefined if they may. */
  private readReason(
    changeSet: DesignChangeSet | null,
  ): string | null | undefined {
    if (!this.mayEdit()) return null;
    // A public sandbox never changes a template (#826): it is read, with why.
    if (this.sandbox.on()) return 'editor.sandbox.templatesOff';
    if (!changeSet) return 'editor.admin.pageDesigns.blocked.needsChangeSet';
    if (changeSet.state !== 'draft') {
      return 'editor.admin.pageDesigns.blocked.notDraft';
    }
    if (changeSet.authorId !== '' && changeSet.authorId !== this.me.me().id) {
      return 'editor.admin.pageDesigns.blocked.notAuthor';
    }
    return undefined;
  }

  /**
   * Opens the text file `path`: its working copy in the person's draft (the committed text while
   * none is saved), else the text at the branch. What was typed in the file before is sent first.
   * Never rejects.
   */
  async open(path: string): Promise<void> {
    if (this.destroyed) return;
    const mine = ++this.opened;
    const generation = this.generation;
    this.flushSoon(0);
    this.path.set(path);
    this.fileStatus.set('loading');
    this.fileError.set(null);
    this.fileLocked.set(false);
    const stale = () => mine !== this.opened || generation !== this.generation;
    try {
      if (this.mode().kind === 'edit' && this.changeSet) {
        const changeSet = this.changeSet;
        // In the queue, after the saves and save points before it: what it reads is never
        // older than what they answered.
        const read = await this.enqueue(async () => {
          const [copy, locks] = await Promise.all([
            this.readCopy(path),
            firstValueFrom(
              this.api.get('/locks', {
                query: { 'filter[subject]': this.key(path) },
              }),
            ).catch(() => null),
          ]);
          if (stale()) return null;
          const lock = locks?.data[0];
          const lockedElsewhere =
            !!lock && lock.relationships.changeSet.data.id !== changeSet.id;
          this.adopt(path, copy, !!lock && !lockedElsewhere);
          return { copy, lockedElsewhere };
        });
        if (!read || stale()) return;
        this.fileLocked.set(read.lockedElsewhere);
        this.text.set(this.pending.get(path) ?? read.copy.text);
      } else {
        const text = await this.readCommitted(path);
        if (stale()) return;
        this.text.set(text);
      }
      this.fileStatus.set('ready');
    } catch (error) {
      if (stale()) return;
      this.fileError.set(toApiError(error));
      this.fileStatus.set('error');
    }
  }

  /**
   * Takes what a read of `path`'s working copy says into its state. The state stays the same
   * object (a save in flight updates it), and a read older than a save answered since never
   * lowers its version.
   */
  private adopt(
    path: string,
    copy: { version: number; baseCommit: string },
    lockHeld: boolean,
  ): void {
    const state = this.state.get(path);
    if (!state) {
      this.state.set(path, {
        version: copy.version,
        baseCommit: copy.baseCommit,
        lockHeld,
        uncommitted: copy.version > 0,
      });
      return;
    }
    if (copy.version >= state.version) {
      state.version = copy.version;
      state.baseCommit = copy.baseCommit;
    }
    state.lockHeld = lockHeld;
    state.uncommitted ||= copy.version > 0;
  }

  private async readCopy(
    path: string,
  ): Promise<{ text: string; version: number; baseCommit: string }> {
    const cs = this.changeSet as DesignChangeSet;
    const doc = await firstValueFrom(
      this.api.get(
        '/change-sets/{changeSetId}/page-design-templates/{templateId}/files/working-copy',
        {
          path: { changeSetId: cs.id, templateId: this.templateId },
          query: { path },
        },
      ),
    );
    const a = doc.data.attributes;
    return {
      text: a.content.text,
      version: a.version,
      baseCommit: a.baseCommit,
    };
  }

  private async readCommitted(path: string): Promise<string> {
    const cs = this.changeSet;
    const doc = await firstValueFrom(
      this.api.get('/page-design-templates/{templateId}/file', {
        path: { templateId: this.templateId },
        query: { path, ...(cs ? { ref: cs.branch } : {}) } as never,
      }),
    );
    return doc.data.attributes.text;
  }

  /** The open file's new text: shown at once, saved shortly after the last change. */
  change(text: string): void {
    const path = this.path();
    if (!path || !this.editable() || text === this.text()) return;
    this.text.set(text);
    this.pending.set(path, text);
    clearTimeout(this.pointTimer);
    if (utf8Bytes(text) > TEMPLATE_FILE_MAX_BYTES) {
      // Not sent: the API would refuse it. Saved again once it is small enough.
      this.saveState.set('not-saved');
      clearTimeout(this.saveTimer);
      return;
    }
    this.saveState.set('saving');
    this.flushSoon(TEMPLATE_SAVE_DELAY_MS);
  }

  /** Sends what is typed after `delay` ms (0: now, queued after the saves before it). */
  private flushSoon(delay: number): void {
    clearTimeout(this.saveTimer);
    if (this.pending.size === 0) return;
    const run = () => void this.enqueue(() => this.flush(this.generation));
    if (delay === 0) run();
    else this.saveTimer = setTimeout(run, delay);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private key(path: string): string {
    return `template/${this.templateId}/${path}`;
  }

  private subject(path: string) {
    return {
      type: 'template' as const,
      templateId: this.templateId,
      path,
    };
  }

  /** Sends every file typed in and not yet saved, one at a time. */
  private async flush(generation: number): Promise<void> {
    const cs = this.changeSet;
    if (!cs || generation !== this.generation) return;
    for (const [path, text] of [...this.pending]) {
      if (generation !== this.generation) return;
      if (utf8Bytes(text) > TEMPLATE_FILE_MAX_BYTES) continue;
      this.pending.delete(path);
      const state = this.state.get(path);
      if (!state) continue;
      try {
        if (!state.lockHeld) {
          await this.takeLock(path);
          state.lockHeld = true;
        }
        const doc = await firstValueFrom(
          this.api.put(
            '/change-sets/{changeSetId}/page-design-templates/{templateId}/files/working-copy',
            {
              path: { changeSetId: cs.id, templateId: this.templateId },
              query: { path },
            },
            {
              data: {
                type: 'WorkingCopy',
                attributes: { content: { schemaVersion: 1, text } },
              },
              meta: { version: state.version, baseCommit: state.baseCommit },
            },
          ),
        );
        if (generation !== this.generation) return;
        state.version = doc.data.attributes.version;
        state.baseCommit = doc.data.attributes.baseCommit;
        state.uncommitted = true;
        this.markDraft(path, utf8Bytes(text));
        this.saves.update((n) => n + 1);
      } catch (error) {
        if (generation !== this.generation) return;
        // Typed again since: the newer text is sent on its own.
        if (!this.pending.has(path)) this.pending.set(path, text);
        this.refused(path, toApiError(error));
        return;
      }
    }
    if (generation !== this.generation) return;
    if (this.pending.size === 0) {
      this.saveState.set('saved');
      this.schedulePoint();
    }
  }

  /** The listing shows the file as a draft of this revision, with its new size. */
  private markDraft(path: string, size: number): void {
    this.files.update((files) =>
      files.map((f) => (f.path === path ? { ...f, size, draft: true } : f)),
    );
  }

  private refused(path: string, failure: ApiError): void {
    this.saveState.set('not-saved');
    const state = this.state.get(path);
    const what: TranslatedText = translated(
      'editor.admin.pageDesigns.templates.save.failed',
      { file: path },
    );
    if (failure.code === 'lock-required' && state) state.lockHeld = false;
    if (failure.code === 'locked') {
      this.pending.delete(path);
      if (this.path() === path) this.fileLocked.set(true);
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (failure.status === 403) {
      this.pending.delete(path);
      this.mode.set({
        kind: 'read',
        reason: 'editor.admin.pageDesigns.blocked.forbidden',
      });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (
      failure.code === 'version-conflict' ||
      failure.code === 'stale-working-copy'
    ) {
      this.pending.delete(path);
      this.toast.error(
        translated('editor.admin.pageDesigns.templates.save.reloaded', {
          file: path,
        }),
      );
      if (this.path() === path) void this.open(path);
      return;
    }
    const generation = this.generation;
    this.toast.error(this.failureText(what, failure), {
      actionLabel: translated('editor.session.retry'),
      onAction: () => {
        if (generation === this.generation) this.flushSoon(0);
      },
    });
  }

  private async takeLock(path: string, within?: number): Promise<void> {
    const cs = this.changeSet as DesignChangeSet;
    const request = this.api.post(
      '/change-sets/{changeSetId}/locks',
      { data: { type: 'Lock', attributes: { subject: this.subject(path) } } },
      { path: { changeSetId: cs.id } },
    );
    await firstValueFrom(
      within === undefined ? request : request.pipe(timeout(within)),
    );
  }

  private schedulePoint(): void {
    clearTimeout(this.pointTimer);
    if (this.destroyed) return;
    this.pointTimer = setTimeout(
      () => void this.savePoint(),
      TEMPLATE_SAVE_POINT_DELAY_MS,
    );
  }

  /**
   * Sends what is typed, then makes the template's saved working copies one save point; resolves
   * whether nothing is left uncommitted. A file past the size limit stays unsent.
   */
  async savePoint(): Promise<boolean> {
    clearTimeout(this.pointTimer);
    if (this.destroyed || !this.changeSet || this.mode().kind !== 'edit') {
      return true;
    }
    this.flushSoon(0);
    const generation = this.generation;
    return this.enqueue(() => this.commit(generation, []));
  }

  private async commit(
    generation: number,
    deletes: readonly string[],
  ): Promise<boolean> {
    const cs = this.changeSet;
    if (!cs || generation !== this.generation) return false;
    // Every working copy of the template, not only the files opened here: the listing's drafts
    // (a new template's files, drafts of an earlier visit) and what was saved since.
    const paths = [
      ...new Set([
        ...[...this.state.entries()]
          .filter(([, s]) => s.uncommitted)
          .map(([path]) => path),
        ...this.files()
          .filter((f) => f.draft)
          .map((f) => f.path),
      ]),
    ].filter((path) => !deletes.includes(path));
    if (paths.length === 0 && deletes.length === 0) return true;
    const deadline = Date.now() + SAVE_POINT_TIMEOUT_MS;
    const left = () => Math.max(1, deadline - Date.now());
    try {
      for (const path of [...paths, ...deletes]) {
        const state = this.state.get(path);
        if (state?.lockHeld) continue;
        await this.takeLock(path, left());
        if (state) state.lockHeld = true;
      }
      const doc = (await firstValueFrom(
        this.api
          .post(
            '/change-sets/{changeSetId}/commits',
            {
              data: {
                type: 'Commit',
                attributes: {
                  // Always named: none would commit every working copy of the revision.
                  subjects: paths.map((p) => this.subject(p)),
                  ...(deletes.length > 0 && {
                    deletes: deletes.map((p) => this.subject(p)),
                  }),
                  message:
                    deletes.length > 0
                      ? `Delete ${deletes.join(', ')} from the template ${this.templateId}`
                      : `Update the template ${this.templateId}`,
                },
              },
            } as never,
            { path: { changeSetId: cs.id } },
          )
          .pipe(timeout(left())),
      )) as Schema<'CommitDocument'> | Schema<'NoCommitDocument'>;
      if (generation !== this.generation) return false;
      const head = 'data' in doc ? doc.data.id : doc.meta.head;
      const made = new Set(paths);
      this.files.update((files) =>
        files.map((f) =>
          made.has(f.path) ? { ...f, draft: false, committed: true } : f,
        ),
      );
      for (const path of paths) {
        const state = this.state.get(path);
        if (state) {
          state.version = 0;
          state.baseCommit = head;
          state.uncommitted = false;
        }
      }
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const failure = toApiError(error);
      // A lock broken meanwhile is taken again by the next attempt.
      if (failure.code === 'lock-required') {
        for (const state of this.state.values()) state.lockHeld = false;
      }
      // The save point may have landed all the same (no answer in time), or the working copies
      // moved: what the next save sends is read again.
      void this.enqueue(() => this.resync(generation));
      // A deletion's caller says why.
      if (deletes.length > 0) throw failure;
      const what = translated(
        'editor.admin.pageDesigns.templates.save.savePointFailed',
      );
      this.toast.error(this.failureText(what, failure), {
        actionLabel: translated('editor.session.retry'),
        onAction: () => {
          if (generation === this.generation) void this.savePoint();
        },
      });
      return false;
    }
  }

  /** Reads the listing and each saved file's working copy again, keeping what is typed. */
  private async resync(generation: number): Promise<void> {
    if (generation !== this.generation || !this.changeSet) return;
    await this.refreshFiles();
    for (const [path, state] of [...this.state]) {
      try {
        const copy = await this.readCopy(path);
        if (generation !== this.generation) return;
        // Committed meanwhile: the working copy starts again from the new head.
        state.version = copy.version;
        state.baseCommit = copy.baseCommit;
        state.uncommitted = copy.version > 0;
      } catch {
        // Unread: the next save says what is wrong.
      }
    }
  }

  /**
   * Makes the file `path` in the template with `text` (empty by default): its lock, then its
   * first working copy on the revision's head. Rejects with the API's error.
   */
  async createFile(path: string, text = ''): Promise<void> {
    const cs = this.changeSet;
    if (!cs || this.mode().kind !== 'edit') return;
    const generation = this.generation;
    await this.enqueue(async () => {
      const changeSet = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}', {
          path: { changeSetId: cs.id },
        }),
      );
      await saveNewFile(
        this.api,
        cs.id,
        this.templateId,
        path,
        text,
        changeSet.data.attributes.baseCommit,
      );
      if (generation !== this.generation) return;
      this.state.set(path, {
        version: 1,
        baseCommit: changeSet.data.attributes.baseCommit,
        lockHeld: true,
        uncommitted: true,
      });
      this.saves.update((n) => n + 1);
      this.schedulePoint();
    });
    if (generation !== this.generation) return;
    await this.refreshFiles();
  }

  /**
   * Deletes the file `path` from the template: a save point with its deletion (and the other
   * files' saved working copies); a file only a working copy holds is that working copy, dropped.
   * Rejects with the API's error.
   */
  async deleteFile(path: string, committed: boolean): Promise<void> {
    const cs = this.changeSet;
    if (!cs || this.mode().kind !== 'edit' || path === TEMPLATE_ENTRY) return;
    this.flushSoon(0);
    this.pending.delete(path);
    const generation = this.generation;
    await this.enqueue(async () => {
      if (committed) {
        const state = this.state.get(path);
        const before = state?.uncommitted ?? false;
        // The file's own working copy is not committed with the deletion.
        if (state) state.uncommitted = false;
        try {
          await this.commit(generation, [path]);
        } catch (error) {
          if (state) state.uncommitted = before;
          throw error;
        }
      } else {
        await firstValueFrom(
          this.api.delete(
            '/change-sets/{changeSetId}/page-design-templates/{templateId}/files/working-copy',
            {
              path: { changeSetId: cs.id, templateId: this.templateId },
              query: { path },
            },
          ),
        );
      }
      this.state.delete(path);
      // Gone from the listing at once: no save point meanwhile names (and locks) it again.
      this.files.update((files) => files.filter((f) => f.path !== path));
      if (generation === this.generation) this.saves.update((n) => n + 1);
    });
    if (generation !== this.generation) return;
    if (this.path() === path) {
      this.path.set(null);
      this.fileStatus.set('idle');
    }
    await this.refreshFiles();
  }
}

/** Saves a new template file's first working copy: its lock, then the save on `baseCommit`. */
async function saveNewFile(
  api: ApiClient,
  changeSetId: string,
  templateId: string,
  path: string,
  text: string,
  baseCommit: string,
): Promise<void> {
  await firstValueFrom(
    api.post(
      '/change-sets/{changeSetId}/locks',
      {
        data: {
          type: 'Lock',
          attributes: { subject: { type: 'template', templateId, path } },
        },
      },
      { path: { changeSetId } },
    ),
  );
  await firstValueFrom(
    api.put(
      '/change-sets/{changeSetId}/page-design-templates/{templateId}/files/working-copy',
      { path: { changeSetId, templateId }, query: { path } },
      {
        data: {
          type: 'WorkingCopy',
          attributes: { content: { schemaVersion: 1, text } },
        },
        meta: { version: 0, baseCommit },
      },
    ),
  );
}

/**
 * Makes a new template `templateId` in `changeSetId` from the example (#396): each of its files
 * a working copy on the revision's head, `manual.typ` first. Rejects with the API's error; what
 * was saved before stays in the revision (its author may delete it).
 */
export async function createTemplate(
  api: ApiClient,
  changeSetId: string,
  templateId: string,
): Promise<void> {
  try {
    const [changeSet, example] = await Promise.all([
      firstValueFrom(
        api.get('/change-sets/{changeSetId}', { path: { changeSetId } }),
      ),
      firstValueFrom(
        api.get('/page-design-template-example/files', {
          query: { 'page[size]': LIST_SIZE } as never,
        }),
      ),
    ]);
    const files = [...example.data].sort((a, b) =>
      a.id === TEMPLATE_ENTRY ? -1 : b.id === TEMPLATE_ENTRY ? 1 : 0,
    );
    // A server without own templates has no example: the entry file alone, to start from.
    if (files.length === 0) {
      files.push({
        type: 'PageDesignTemplateFileText',
        id: TEMPLATE_ENTRY,
        attributes: { path: TEMPLATE_ENTRY, text: '' },
      } as Schema<'PageDesignTemplateFileTextResource'>);
    }
    for (const file of files) {
      await saveNewFile(
        api,
        changeSetId,
        templateId,
        file.attributes.path,
        file.attributes.text,
        changeSet.data.attributes.baseCommit,
      );
    }
  } catch (error) {
    throw toApiError(error);
  }
}
