import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookOpen,
  lucideFileText,
  lucideLock,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { LanguageService } from '@openfolia/ui/i18n';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { ApiClient } from '../api';
import { languageName } from './browser-model';
import type { DeleteRequest } from './module-deletion';
import { loadModuleUsage, type ModuleUsage } from './module-usage';

/** The module the dialog asks about. */
export interface DeleteTarget {
  readonly moduleId: string;
  readonly title: string;
  /** The languages it exists in. */
  readonly languages: readonly string[];
  /** The language chosen first (the one open in the editor); none: every language. */
  readonly lang?: string | undefined;
  /** The configured source language: where it is used is read in it, when the module has it. */
  readonly source: string;
  /**
   * The configured languages: "Every language" also removes one that is only a working copy
   * (a translation started and not committed yet), which the module's languages do not list.
   */
  readonly configured: readonly string[];
  /** The change set it is deleted in. */
  readonly changeSetId: string;
  readonly changeSetTitle: string;
}

/** `all`, or one language's code. */
type Choice = string;
const ALL: Choice = '*';

/**
 * Asks how much of a module to delete (one language, or every one) and shows where it is used
 * first: the manuals that include it and the modules that reference it, which the checks then
 * report until they are fixed (a used module may still be deleted). A lock another change set
 * holds blocks it, with the reason. Deleting hands the request on (`confirm`); Undo is the
 * toast's, afterwards, not a question here.
 */
@Component({
  selector: 'of-delete-module-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardRadioGroupImports,
    ZardSkeletonComponent,
    CollapseComponent,
    FadeInDirective,
    TranslocoPipe,
    NgIcon,
  ],
  viewProviders: [
    provideIcons({
      lucideBookOpen,
      lucideFileText,
      lucideLock,
      lucideTriangleAlert,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="!!target()"
      (zVisibleChange)="$event || cancel()"
      class="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[34rem]"
    >
      @if (target(); as t) {
        <z-dialog-header>
          <z-dialog-title class="break-words">{{
            'editor.content.delete.title' | transloco: { title: t.title }
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            'editor.content.delete.description'
              | transloco: { changeSet: t.changeSetTitle }
          }}</z-dialog-description>
        </z-dialog-header>
        <div class="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
          @if (t.languages.length > 1) {
            <fieldset class="m-0 flex flex-col gap-2 border-0 p-0">
              <legend class="text-muted-foreground mb-2 p-0 text-xs">
                {{ 'editor.content.delete.what' | transloco }}
              </legend>
              <z-radio-group
                class="flex flex-col gap-2.5"
                [attr.aria-label]="'editor.content.delete.what' | transloco"
                [value]="choice()"
                (valueChange)="choice.set($any($event))"
              >
                @for (l of t.languages; track l) {
                  <label class="flex cursor-pointer items-start gap-3">
                    <z-radio [value]="l" [zId]="'delete-module-' + l" />
                    <span class="text-sm break-words" [attr.lang]="l">{{
                      'editor.content.delete.onlyLanguage'
                        | transloco: { language: name(l) }
                    }}</span>
                  </label>
                }
                <label class="flex cursor-pointer items-start gap-3">
                  <z-radio [value]="all" zId="delete-module-all" />
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-sm">{{
                      'editor.content.delete.everyLanguage' | transloco
                    }}</span>
                    <span class="text-muted-foreground text-xs break-words">{{
                      names(t.languages)
                    }}</span>
                  </span>
                </label>
              </z-radio-group>
            </fieldset>
          }

          <section
            class="flex flex-col gap-2"
            aria-labelledby="delete-module-uses"
          >
            <h3 id="delete-module-uses" class="m-0 text-sm font-medium">
              @if (usage(); as u) {
                {{
                  'editor.content.delete.usedIn' | transloco: { count: u.count }
                }}
              } @else {
                {{ 'editor.content.delete.usedInTitle' | transloco }}
              }
            </h3>
            <of-collapse [open]="usageState() === 'loading'">
              <div role="status" aria-busy="true" class="flex flex-col gap-2">
                <span class="sr-only">{{
                  'editor.content.delete.checking' | transloco
                }}</span>
                <z-skeleton class="h-4 w-3/4" aria-hidden="true" />
                <z-skeleton class="h-4 w-1/2" aria-hidden="true" />
              </div>
            </of-collapse>
            <of-collapse [open]="usageState() !== 'loading'">
              @if (usage(); as u) {
                @if (u.uses.length > 0) {
                  <ul
                    class="border-border m-0 flex max-h-48 list-none flex-col gap-1.5 overflow-y-auto rounded-md border p-2.5"
                    data-slot="delete-module-uses"
                  >
                    @for (use of u.uses; track use.kind + ':' + use.id) {
                      <li class="flex items-start gap-2 text-sm">
                        <ng-icon
                          [name]="
                            use.kind === 'manual'
                              ? 'lucideBookOpen'
                              : 'lucideFileText'
                          "
                          class="text-muted-foreground mt-0.5 shrink-0"
                          size="16"
                          aria-hidden="true"
                        />
                        <span class="flex min-w-0 flex-col">
                          <span class="break-words">{{ use.title }}</span>
                          <span class="text-muted-foreground text-xs">{{
                            (use.kind === 'manual'
                              ? 'editor.content.delete.manual'
                              : 'editor.content.delete.module'
                            ) | transloco
                          }}</span>
                        </span>
                      </li>
                    }
                  </ul>
                  <p
                    class="text-muted-foreground m-0 mt-2 flex items-start gap-2 text-xs break-words"
                  >
                    <ng-icon
                      name="lucideTriangleAlert"
                      class="mt-px shrink-0"
                      size="14"
                      aria-hidden="true"
                    />
                    {{ 'editor.content.delete.checksNote' | transloco }}
                  </p>
                } @else {
                  <p class="text-muted-foreground m-0 text-sm">
                    {{ 'editor.content.delete.unused' | transloco }}
                  </p>
                }
                @if (!u.complete) {
                  <p class="text-muted-foreground m-0 mt-1 text-xs">
                    {{ 'editor.content.delete.incomplete' | transloco }}
                  </p>
                }
              } @else if (usageState() === 'failed') {
                <p
                  class="text-muted-foreground m-0 flex flex-wrap items-center gap-2 text-sm"
                >
                  {{ 'editor.content.delete.usageFailed' | transloco }}
                  <button
                    z-button
                    zType="link"
                    zSize="xs"
                    type="button"
                    (click)="loadUsage()"
                  >
                    {{ 'ui.states.error.retry' | transloco }}
                  </button>
                </p>
              }
            </of-collapse>
          </section>

          @if (lockedBy()) {
            <p
              ofFadeIn
              class="border-border bg-muted m-0 flex items-start gap-2 rounded-md border p-3 text-sm break-words"
              role="status"
              id="delete-module-locked"
            >
              <ng-icon
                name="lucideLock"
                class="mt-0.5 shrink-0"
                size="16"
                aria-hidden="true"
              />
              {{ 'editor.content.delete.lockedElsewhere' | transloco }}
            </p>
          }
        </div>
        <z-dialog-footer>
          <button z-button zType="ghost" type="button" (click)="cancel()">
            {{ 'editor.content.delete.cancel' | transloco }}
          </button>
          <button
            z-button
            zType="destructive"
            type="button"
            data-slot="delete-module-confirm"
            [zLoading]="usageState() === 'loading'"
            [zDisabled]="lockedBy()"
            [attr.aria-describedby]="lockedBy() ? 'delete-module-locked' : null"
            (click)="submit()"
          >
            {{
              (choice() === all
                ? 'editor.content.delete.confirmAll'
                : 'editor.content.delete.confirmLanguage'
              ) | transloco: { language: name(choice()) }
            }}
          </button>
        </z-dialog-footer>
      }
    </z-dialog>
  `,
})
export class DeleteModuleDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);

  /** The module to ask about; null: closed. */
  readonly target = input<DeleteTarget | null>(null);
  readonly confirm = output<DeleteRequest>();
  readonly closed = output<void>();

  protected readonly all = ALL;
  protected readonly choice = signal<Choice>(ALL);
  protected readonly usage = signal<ModuleUsage | null>(null);
  protected readonly usageState = signal<'loading' | 'ready' | 'failed'>(
    'loading',
  );
  /** A language of it is locked by another change set. */
  protected readonly lockedBy = signal(false);
  private runs = 0;

  /** What the lock check reads: the module and the languages chosen. */
  private readonly lockKey = computed(() => {
    const t = this.target();
    return t
      ? `${t.changeSetId}\n${t.moduleId}\n${this.langs().join(',')}`
      : null;
  });

  /** Delete waits for where it is used, and a lock elsewhere blocks it. */
  protected readonly blocked = computed(
    () => this.usageState() === 'loading' || this.lockedBy(),
  );

  constructor() {
    // Every opening starts afresh: the editor's language (or every one), then the reads.
    effect(() => {
      const t = this.target();
      untracked(() => {
        this.runs++;
        if (!t) return;
        this.choice.set(
          t.lang && t.languages.length > 1 && t.languages.includes(t.lang)
            ? t.lang
            : ALL,
        );
        this.lockedBy.set(false);
        void this.loadUsage();
      });
    });
    // "Every language" checks the locks of every language; one language only its own.
    effect(() => {
      if (this.lockKey() === null) return;
      untracked(() => void this.loadLocks());
    });
  }

  protected name(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected names(langs: readonly string[]): string {
    return langs.map((l) => this.name(l)).join(', ');
  }

  /** The languages the choice deletes. */
  private langs(): readonly string[] {
    const t = this.target();
    if (!t) return [];
    return this.choice() === ALL
      ? [...new Set([...t.languages, ...t.configured])]
      : [this.choice()];
  }

  protected async loadUsage(): Promise<void> {
    const t = this.target();
    if (!t) return;
    const run = this.runs;
    this.usage.set(null);
    this.usageState.set('loading');
    try {
      // Any language it exists in gives the same uses; the source language first.
      const lang = t.languages.includes(t.source)
        ? t.source
        : (t.languages[0] ?? t.source);
      const usage = await loadModuleUsage(this.api, t.moduleId, lang);
      if (run !== this.runs) return;
      this.usage.set(usage);
      this.usageState.set('ready');
    } catch {
      if (run === this.runs) this.usageState.set('failed');
    }
  }

  /** Whether another change set holds a lock on a language the choice deletes. */
  private locksRun = 0;
  private async loadLocks(): Promise<void> {
    const t = this.target();
    if (!t) return;
    const run = ++this.locksRun;
    const langs = this.langs();
    try {
      const found = await Promise.all(
        langs.map((lang) =>
          firstValueFrom(
            this.api.get('/locks', {
              query: {
                'filter[subject]': `module/${lang}/${t.moduleId}`,
                'page[size]': 1,
              },
            }),
          ),
        ),
      );
      if (run !== this.locksRun || this.target() !== t) return;
      this.lockedBy.set(
        found.some((page) =>
          page.data.some(
            (lock) => lock.relationships.changeSet.data.id !== t.changeSetId,
          ),
        ),
      );
    } catch {
      // Not known: the delete itself says so if a lock is in the way.
      if (run === this.locksRun) this.lockedBy.set(false);
    }
  }

  protected submit(): void {
    const t = this.target();
    if (!t || this.blocked()) return;
    const langs = this.langs();
    this.confirm.emit({
      moduleId: t.moduleId,
      title: t.title,
      langs,
      all: this.choice() === ALL,
    });
  }

  protected cancel(): void {
    this.closed.emit();
  }
}
