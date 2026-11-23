import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpToLine,
  lucideEllipsis,
  lucideTrash2,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { LanguageService, translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import {
  SortableListComponent,
  SortableRowDirective,
  type SortableItem,
} from '@openfolia/ui/sortable-list';

import { languageDirection } from '@openfolia/content-model/core';

import { languageName } from '../../content/browser-model';
import {
  languageProblem,
  setSource,
  setTargets,
  type UsageCount,
} from './config-model';
import { SettingsContext } from './settings-context';
import type { SettingsTopicPage } from './settings-topics';

/**
 * Settings › Languages: the source language content is written in, then the translation
 * languages in order (reordered by their grip). A translation language's ⋯ menu makes it the
 * source (the old source becomes a translation language, so nothing is taken away) or deletes it
 * (with Undo; modules in that language open the in-use decision). The Add button asks for a
 * BCP 47 tag. Each language shows its text direction (#458): its script's, or the one
 * `languages.direction` in `openfolia.yaml` sets.
 */
@Component({
  selector: 'of-settings-languages',
  imports: [
    TranslocoPipe,
    NgIcon,
    NgTemplateOutlet,
    RouterLink,
    SortableListComponent,
    SortableRowDirective,
    ZardButtonComponent,
    ZardDialogImports,
    ZardDropdownImports,
    ZardInputComponent,
  ],
  viewProviders: [
    provideIcons({ lucideArrowUpToLine, lucideEllipsis, lucideTrash2 }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex max-w-4xl min-w-0 flex-col gap-6' },
  template: `
    @if (ctx.config(); as c) {
      <div class="flex min-w-0 flex-col gap-1">
        <h3 class="text-muted-foreground m-0 text-xs font-medium">
          {{ 'editor.admin.settings.languages.source' | transloco }}
        </h3>
        <div
          class="border-border bg-card flex min-h-12 min-w-0 items-center gap-3 rounded-xl border py-1.5 pe-2"
          [class.ps-10]="ctx.editable()"
          [class.ps-3]="!ctx.editable()"
          [attr.data-language]="c.languages.source"
          data-slot="source-language"
        >
          <span
            class="min-w-0 flex-1 text-sm break-words"
            [attr.lang]="c.languages.source"
            >{{ name(c.languages.source) }}</span
          >
          <ng-container
            [ngTemplateOutlet]="meta"
            [ngTemplateOutletContext]="{ $implicit: c.languages.source }"
          />
          @if (ctx.editable()) {
            <span class="w-7 shrink-0" aria-hidden="true"></span>
          }
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-1">
        <h3 class="text-muted-foreground m-0 text-xs font-medium">
          {{ 'editor.admin.settings.languages.targets' | transloco }}
        </h3>
        @if (targets().length > 0) {
          <div
            class="border-border bg-card min-w-0 overflow-y-auto rounded-xl border px-2 py-1.5"
            style="max-height: calc(100dvh - 26rem)"
          >
            <of-sortable-list
              [items]="targets()"
              [label]="'editor.admin.settings.languages.targets' | transloco"
              [readonly]="!ctx.editable()"
              (itemsChange)="reorder($event)"
            >
              <ng-template ofSortableRow let-item>
                <div
                  class="flex min-h-9 min-w-0 items-center gap-3"
                  [attr.data-language]="item.id"
                >
                  <span
                    class="min-w-0 flex-1 text-sm break-words"
                    [attr.lang]="item.id"
                    >{{ item.label }}</span
                  >
                  <ng-container
                    [ngTemplateOutlet]="meta"
                    [ngTemplateOutletContext]="{ $implicit: item.id }"
                  />
                  @if (ctx.editable()) {
                    <button
                      z-button
                      zType="ghost"
                      zSize="icon-sm"
                      type="button"
                      class="shrink-0"
                      data-slot="language-menu"
                      z-dropdown
                      [zDropdownMenu]="menu"
                      [attr.aria-label]="
                        'editor.admin.settings.option.actionsOf'
                          | transloco: { label: item.label }
                      "
                    >
                      <ng-icon name="lucideEllipsis" aria-hidden="true" />
                    </button>
                    <z-dropdown-menu-content #menu class="w-60">
                      <z-dropdown-menu-item
                        data-action="language-make-source"
                        (click)="makeSource(item.id)"
                      >
                        <ng-icon
                          name="lucideArrowUpToLine"
                          aria-hidden="true"
                        />
                        {{
                          'editor.admin.settings.languages.makeSource'
                            | transloco
                        }}
                      </z-dropdown-menu-item>
                      <z-dropdown-menu-separator />
                      <z-dropdown-menu-item
                        zType="destructive"
                        data-action="language-delete"
                        (click)="remove(item.id)"
                      >
                        <ng-icon name="lucideTrash2" aria-hidden="true" />
                        {{ 'editor.admin.settings.option.delete' | transloco }}
                      </z-dropdown-menu-item>
                    </z-dropdown-menu-content>
                  }
                </div>
              </ng-template>
            </of-sortable-list>
          </div>
        } @else {
          <p class="text-muted-foreground m-0 py-2 text-sm">
            {{ 'editor.admin.settings.languages.none' | transloco }}
          </p>
        }
      </div>
    }

    <ng-template #meta let-tag>
      <!-- Its text direction (issue 458): from its script, or as the configuration sets it. -->
      <span
        class="text-muted-foreground hidden w-28 shrink-0 text-xs sm:block"
        data-slot="direction"
        [attr.data-direction]="dirOf(tag)"
        [title]="
          (configuredDir(tag)
            ? 'editor.admin.settings.languages.directionConfigured'
            : 'editor.admin.settings.languages.directionFromScript'
          ) | transloco
        "
        >{{
          (dirOf(tag) === 'rtl'
            ? 'editor.admin.settings.languages.rtl'
            : 'editor.admin.settings.languages.ltr'
          ) | transloco
        }}</span
      >
      <code
        class="text-muted-foreground w-16 shrink-0 font-mono text-xs break-all"
        >{{ tag }}</code
      >
      @if (countOf(tag); as n) {
        @if (n.modules > 0) {
          <a
            class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 hidden w-36 shrink-0 rounded-sm text-end text-xs underline-offset-4 outline-none hover:underline focus-visible:ring-2 sm:block"
            data-slot="usage"
            routerLink="/content"
            [queryParams]="linkParams(tag)"
            >{{ 'editor.admin.settings.usage.short' | transloco: n }}</a
          >
        } @else {
          <span
            class="text-muted-foreground hidden w-36 shrink-0 text-end text-xs sm:block"
            data-slot="usage"
            >{{ 'editor.admin.settings.usage.short' | transloco: n }}</span
          >
        }
      } @else {
        <span class="hidden w-36 shrink-0 sm:block"></span>
      }
    </ng-template>

    <z-dialog
      [zVisible]="adding()"
      (zVisibleChange)="$event || adding.set(false)"
      class="sm:max-w-[28rem]"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.admin.settings.languages.add' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.settings.languages.addDescription' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (adding()) {
        <form
          id="language-new-form"
          class="flex flex-col gap-1.5"
          novalidate
          (submit)="add($event)"
        >
          <label class="text-sm" for="language-new">{{
            'editor.admin.settings.languages.tag' | transloco
          }}</label>
          <input
            id="language-new"
            z-input
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            data-field="language-new"
            cdkFocusInitial
            aria-describedby="language-new-hint"
            [placeholder]="'editor.admin.settings.languages.newTag' | transloco"
            [attr.aria-invalid]="shownProblem() ? 'true' : null"
            [value]="newTag()"
            (input)="newTag.set($any($event.target).value.trim())"
          />
          <p
            id="language-new-hint"
            class="text-muted-foreground m-0 min-h-4 text-xs break-words"
            [class.text-destructive]="!!shownProblem()"
          >
            @if (shownProblem(); as p) {
              {{ p | transloco }}
            } @else if (newTag() !== '' && !problem()) {
              {{ name(newTag()) }}
            }
          </p>
        </form>
      }
      <z-dialog-footer>
        <button
          z-button
          zType="ghost"
          type="button"
          (click)="adding.set(false)"
        >
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="language-new-form"
          data-slot="language-new-add"
        >
          {{ 'editor.admin.settings.option.add' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class LanguagesTopicPage implements SettingsTopicPage {
  protected readonly ctx = inject(SettingsContext);
  private readonly language = inject(LanguageService);

  protected readonly targets = computed((): SortableItem[] =>
    (this.ctx.config()?.languages.targets ?? []).map((t) => ({
      id: t,
      label: this.name(t),
    })),
  );

  protected readonly adding = signal(false);
  protected readonly newTag = signal('');
  private readonly tried = signal(false);
  protected readonly problem = computed(() => {
    const c = this.ctx.config();
    return c ? languageProblem(this.newTag(), c) : null;
  });
  protected readonly shownProblem = computed(() =>
    this.tried() ||
    (this.newTag() !== '' &&
      this.problem() !== 'editor.admin.settings.problems.languageTag')
      ? this.problem()
      : null,
  );

  constructor() {
    effect(() => {
      if (!this.adding()) return;
      untracked(() => {
        this.newTag.set('');
        this.tried.set(false);
      });
    });
  }

  openAdd(): void {
    this.adding.set(true);
  }

  protected name(tag: string): string {
    return languageName(this.language.locale(), tag);
  }

  /** The language's text direction: as the configuration sets it, else its script's. */
  protected dirOf(tag: string): 'ltr' | 'rtl' {
    return languageDirection(tag, this.ctx.config());
  }

  /** Whether the configuration sets the language's direction itself (`languages.direction`). */
  protected configuredDir(tag: string): boolean {
    const direction = this.ctx.config()?.languages.direction;
    return !!direction && Object.hasOwn(direction, tag);
  }

  protected countOf(tag: string): UsageCount | null {
    return this.ctx.countOf({ kind: 'language', valueId: tag });
  }

  protected linkParams(tag: string): Record<string, string> {
    return { ...this.ctx.linkQuery(), lang: tag };
  }

  protected makeSource(tag: string): void {
    const c = this.ctx.config();
    if (!c) return;
    const next = setSource(c, tag);
    if (next === c) return;
    const language = this.name(tag);
    this.ctx.save(
      next,
      translated('editor.admin.settings.changes.source', { language }),
      {
        part: 'languages',
        done: translated('editor.admin.settings.done.source', { language }),
      },
    );
  }

  protected reorder(items: readonly SortableItem[]): void {
    const c = this.ctx.config();
    if (!c) return;
    this.ctx.save(
      setTargets(
        c,
        items.map((i) => i.id),
      ),
      translated('editor.admin.settings.changes.reorder'),
    );
  }

  protected remove(tag: string): void {
    this.ctx.remove(
      { kind: 'language', valueId: tag },
      this.name(tag),
      'languages',
      (c) =>
        setTargets(
          c,
          c.languages.targets.filter((t) => t !== tag),
        ),
    );
  }

  protected add(event: Event): void {
    event.preventDefault();
    this.tried.set(true);
    const c = this.ctx.config();
    if (!c || this.problem()) return;
    const tag = this.newTag();
    const label = this.name(tag);
    this.adding.set(false);
    this.ctx.save(
      setTargets(c, [...c.languages.targets, tag]),
      translated('editor.admin.settings.changes.add', { label }),
      {
        part: 'languages',
        done: translated('editor.admin.settings.done.add', { label }),
      },
    );
  }
}
