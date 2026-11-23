import { computed, inject, Injectable, signal } from '@angular/core';
import type { LocalizedText } from '@openfolia/content-model/core';

import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ChangeSetUrl } from '../../session/change-set-url';
import type { InUseRequest } from '../variants/in-use-dialog.component';
import { ConfigDraft, type ConfigRefusal } from './config-draft';
import {
  contentFilter,
  sourceLabel,
  usageKey,
  type ProjectConfig,
  type UsageCount,
  type ValueRef,
} from './config-model';

/** The part of the configuration a change is about: what Undo puts back. */
export type ConfigPart = keyof ProjectConfig;

/** A removal waiting for the person's decision, or sent and possibly refused. */
interface PendingRemoval {
  readonly request: InUseRequest;
}

/**
 * What the topics of the project settings share, provided by the settings page beside its
 * `ConfigDraft`: whether the person may change the settings now, the usage counts, the change
 * set's link parameters, and the two ways of changing: `save` (shown and saved at once, with
 * Undo where asked) and `remove` (at once, with Undo, unless content uses the value: then the
 * in-use decision opens, #91's dialog).
 */
@Injectable()
export class SettingsContext {
  readonly draft = inject(ConfigDraft);
  private readonly toast = inject(ToastService);
  private readonly csLink = inject(ChangeSetUrl);

  readonly config = this.draft.config;
  /** The project's languages: a label is given in each (#731). */
  readonly languages = computed(() => this.config()?.languages ?? null);
  readonly editable = computed(
    () => this.draft.mode().kind === 'edit' && this.draft.status() === 'ready',
  );
  /** Why the settings cannot be changed now (a key). */
  readonly readReason = computed(() => {
    const m = this.draft.mode();
    return m.kind === 'read' && m.reason
      ? m.reason
      : 'editor.admin.settings.blocked.readOnly';
  });
  /** Usage counts by `usageKey`, read at the change set's branch (the page reads them). */
  readonly counts = signal<ReadonlyMap<string, UsageCount>>(new Map());
  /** The change set's query parameters, for links (`?cs=`). */
  readonly linkQuery = computed(() => this.csLink.params());

  /** The in-use decision open now, or null. */
  readonly decision = signal<PendingRemoval | null>(null);
  /** The last removal sent: a refusal of it keeps its count and filter. */
  private lastRemoval: PendingRemoval | null = null;

  countOf(ref: ValueRef): UsageCount | null {
    return this.counts().get(usageKey(ref)) ?? null;
  }

  /**
   * Shows and saves `next`. With `done`, a toast says so and offers Undo, which puts `part` back
   * as it was, as long as nothing changed that part since.
   */
  save(
    next: ProjectConfig,
    what: TranslatedText,
    undo?: { readonly done: TranslatedText; readonly part: ConfigPart },
  ): boolean {
    const before = this.config();
    if (!before || !this.draft.change(next, what)) return false;
    if (undo) {
      const { part, done } = undo;
      this.toast.success(done, {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => {
          const now = this.config();
          if (!now || now[part] !== next[part]) {
            this.toast.show(translated('editor.admin.settings.undoLate'), {
              kind: 'info',
            });
            return;
          }
          this.draft.change(
            { ...now, [part]: before[part] } as ProjectConfig,
            translated('editor.admin.settings.undo'),
          );
        },
      });
    }
    return true;
  }

  /**
   * Removes a value: at once, with Undo, when no content the person reads names it (the API
   * checks again, past their scope); else the in-use decision opens with the count. `ref` null:
   * nothing counts the value's use.
   */
  remove(
    ref: ValueRef | null,
    shown: LocalizedText,
    part: ConfigPart,
    apply: (config: ProjectConfig) => ProjectConfig,
  ): void {
    const c = this.config();
    if (!c) return;
    const label = sourceLabel(c, shown);
    const count = ref ? this.countOf(ref) : null;
    const pending: PendingRemoval = {
      request: {
        what: translated('editor.admin.settings.changes.remove', { label }),
        count,
        filter: ref ? contentFilter(ref) : null,
        places: [],
        total: 0,
        canArchive: false,
      },
    };
    if (count && count.modules + count.manuals > 0) {
      this.decision.set(pending);
      return;
    }
    this.lastRemoval = pending;
    this.save(apply(c), pending.request.what, {
      part,
      done: translated('editor.admin.settings.done.remove', { label }),
    });
  }

  /** A refusal by the API: the decision names where the value is used. */
  refused(refusal: ConfigRefusal): void {
    const last = this.lastRemoval;
    const same = last?.request.what === refusal.what;
    this.decision.set({
      request: {
        what: refusal.what,
        count: same ? last.request.count : null,
        filter: same ? last.request.filter : null,
        places: refusal.places,
        total: refusal.total,
        canArchive: false,
      },
    });
  }
}
