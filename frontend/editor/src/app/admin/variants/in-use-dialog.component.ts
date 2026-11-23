import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookOpen,
  lucideFileText,
  lucideTags,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { TextPipe, type TranslatedText } from '@openfolia/ui/i18n';

import { ChangeSetUrl } from '../../session/change-set-url';
import {
  ISSUE_TEXTS,
  type UsageCount,
  type UsagePlace,
} from '../settings/config-model';

/**
 * What the in-use decision asks about: a value someone wants to remove (or a change the API
 * refused) and where content uses it.
 */
export interface InUseRequest {
  /** The heading: what was asked for ("Remove the audience “Service”"). */
  readonly what: TranslatedText;
  /** How much content names it, as the person reads it (`GET /config/usages`); null when unknown. */
  readonly count: UsageCount | null;
  /** The content list filtered by the value (query parameters of `/content`); null when it has none. */
  readonly filter: Record<string, string> | null;
  /** The places the API named when it refused the change (`config-in-use`); empty before that. */
  readonly places: readonly UsagePlace[];
  /** How many places the API counted (it lists at most 100). */
  readonly total: number;
  /** Archiving is offered: the value stays valid for content and pickers hide it. */
  readonly canArchive: boolean;
  /** The builds a variant value appears in (`GET /variants/matches`); absent for other values. */
  readonly builds?: {
    readonly total: number;
    readonly items: readonly InUseBuild[];
  };
}

/** A manual in one variant combination, as the in-use decision links it. */
export interface InUseBuild {
  readonly manualId: string;
  readonly manualTitle: string;
  /** The variant's slug, as the manual builder's address takes it. */
  readonly slug: string;
  readonly label: string;
}

/** The most places listed; the rest are counted. */
const SHOWN = 50;

/**
 * The decision for a value content still uses (#91, reused by the project settings, #259): it says
 * where the value is used (the counts, with a link to the content list filtered by it, the builds
 * a variant value appears in, and the modules and manuals the API named, each a link to it) and offers Archive where the value can be
 * archived, or Cancel. Removing is not offered while the value is used: content would no longer
 * be valid. Replacing a value across the content is a follow-up.
 */
@Component({
  selector: 'of-in-use-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    TranslocoPipe,
    TextPipe,
    NgIcon,
    RouterLink,
  ],
  viewProviders: [
    provideIcons({
      lucideBookOpen,
      lucideFileText,
      lucideTags,
      lucideTriangleAlert,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="!!request()"
      (zVisibleChange)="$event || closed.emit()"
      class="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[34rem]"
    >
      @if (request(); as r) {
        <z-dialog-header>
          <z-dialog-title class="break-words">{{
            r.what | ofText
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            (r.canArchive
              ? 'editor.admin.settings.inUse.descriptionArchive'
              : 'editor.admin.settings.inUse.description'
            ) | transloco
          }}</z-dialog-description>
        </z-dialog-header>
        <div class="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
          @if (r.count; as c) {
            <p
              class="border-border bg-muted/50 m-0 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-3 text-sm"
              data-slot="in-use-count"
            >
              <ng-icon
                name="lucideTriangleAlert"
                class="text-muted-foreground shrink-0"
                size="16"
                aria-hidden="true"
              />
              <span class="min-w-0 break-words">{{
                'editor.admin.settings.usage.summary'
                  | transloco: { modules: c.modules, manuals: c.manuals }
              }}</span>
              @if (r.filter && c.modules > 0) {
                <a
                  z-button
                  zType="link"
                  zSize="xs"
                  class="ms-auto"
                  routerLink="/content"
                  [queryParams]="linkParams(r.filter)"
                  (click)="closed.emit()"
                  >{{
                    'editor.admin.settings.usage.showModules' | transloco
                  }}</a
                >
              }
            </p>
          }
          @if (r.builds && r.builds.total > 0) {
            <section
              class="flex flex-col gap-2"
              aria-labelledby="in-use-builds"
              data-slot="in-use-builds"
            >
              <h3 id="in-use-builds" class="m-0 text-sm font-medium">
                {{
                  'editor.admin.settings.inUse.builds'
                    | transloco: { count: r.builds.total }
                }}
              </h3>
              <ul
                class="border-border m-0 flex max-h-40 list-none flex-col gap-1 overflow-y-auto rounded-md border p-2"
              >
                @for (b of r.builds.items; track b.manualId + '/' + b.slug) {
                  <li class="flex min-w-0 items-start gap-2 text-sm">
                    <ng-icon
                      name="lucideBookOpen"
                      class="text-muted-foreground mt-0.5 shrink-0"
                      size="16"
                      aria-hidden="true"
                    />
                    <a
                      class="text-foreground min-w-0 break-words underline-offset-2 hover:underline"
                      routerLink="/manuals"
                      [queryParams]="
                        linkParams({ manual: b.manualId, variant: b.slug })
                      "
                      (click)="closed.emit()"
                      >{{ b.manualTitle }} · {{ b.label }}</a
                    >
                  </li>
                }
              </ul>
              @if (r.builds.total > r.builds.items.length) {
                <p class="text-muted-foreground m-0 text-xs">
                  {{
                    'editor.admin.settings.inUse.moreBuilds'
                      | transloco
                        : { count: r.builds.total - r.builds.items.length }
                  }}
                </p>
              }
            </section>
          }
          @if (r.places.length > 0) {
            <section
              class="flex flex-col gap-2"
              aria-labelledby="in-use-places"
            >
              <h3 id="in-use-places" class="m-0 text-sm font-medium">
                {{
                  'editor.admin.settings.inUse.places'
                    | transloco: { count: r.total }
                }}
              </h3>
              <ul
                class="border-border m-0 flex max-h-56 list-none flex-col gap-1 overflow-y-auto rounded-md border p-2"
                data-slot="in-use-places"
              >
                @for (p of shown(); track $index) {
                  <li class="flex min-w-0 items-start gap-2 text-sm">
                    <ng-icon
                      [name]="
                        p.subject.type === 'manual'
                          ? 'lucideBookOpen'
                          : p.subject.type === 'term'
                            ? 'lucideTags'
                            : 'lucideFileText'
                      "
                      class="text-muted-foreground mt-0.5 shrink-0"
                      size="16"
                      aria-hidden="true"
                    />
                    <span class="flex min-w-0 flex-col">
                      @if (linkOf(p); as l) {
                        <a
                          class="text-foreground break-words underline-offset-2 hover:underline"
                          [routerLink]="l.commands"
                          [queryParams]="linkParams(l.query)"
                          (click)="closed.emit()"
                          >{{ nameOf(p) }}</a
                        >
                      } @else {
                        <span class="break-words">{{ nameOf(p) }}</span>
                      }
                      <span class="text-muted-foreground text-xs break-words">{{
                        issueText(p.issue) | transloco
                      }}</span>
                    </span>
                  </li>
                }
              </ul>
              @if (r.total > shown().length) {
                <p class="text-muted-foreground m-0 text-xs">
                  {{
                    'editor.admin.settings.inUse.more'
                      | transloco: { count: r.total - shown().length }
                  }}
                </p>
              }
            </section>
          }
        </div>
        <z-dialog-footer>
          <button z-button zType="ghost" type="button" (click)="closed.emit()">
            {{ 'editor.admin.settings.inUse.cancel' | transloco }}
          </button>
          @if (r.canArchive) {
            <button
              z-button
              type="button"
              data-slot="in-use-archive"
              (click)="archive.emit()"
            >
              {{ 'editor.admin.settings.inUse.archive' | transloco }}
            </button>
          }
        </z-dialog-footer>
      }
    </z-dialog>
  `,
})
export class InUseDialogComponent {
  private readonly csLink = inject(ChangeSetUrl);

  /** What to ask about; null: closed. */
  readonly request = input<InUseRequest | null>(null);
  /** Archive the value instead (only when `canArchive`). */
  readonly archive = output<void>();
  /** Cancel, Escape, the backdrop, or a link followed. */
  readonly closed = output<void>();

  protected readonly shown = computed(
    () => this.request()?.places.slice(0, SHOWN) ?? [],
  );

  protected linkParams(query: Record<string, string>): Record<string, string> {
    return { ...this.csLink.params(), ...query };
  }

  protected nameOf(place: UsagePlace): string {
    const s = place.subject;
    if (place.title) {
      return s.type === 'module' ? `${place.title} (${s.lang})` : place.title;
    }
    if (s.type === 'module') return `${s.moduleId} (${s.lang})`;
    return s.type === 'manual' ? s.manualId : s.termId;
  }

  protected linkOf(
    place: UsagePlace,
  ): { commands: string[]; query: Record<string, string> } | null {
    const s = place.subject;
    if (s.type === 'module') {
      return {
        commands: ['/content', s.lang, s.moduleId],
        query: place.at ? { block: place.at } : {},
      };
    }
    if (s.type === 'manual')
      return { commands: ['/manuals'], query: { manual: s.manualId } };
    return null;
  }

  protected issueText(code: string): string {
    return ISSUE_TEXTS[code] ?? 'editor.admin.settings.inUse.issues.other';
  }
}
