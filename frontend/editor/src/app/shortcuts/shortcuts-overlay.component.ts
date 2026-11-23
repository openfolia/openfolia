import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardDialogImports } from '@openfolia/ui/dialog';
import { injectTranslate } from '@openfolia/ui/i18n';
import { KbdComponent } from '@openfolia/ui/kbd';
import { isPageShortcut } from '@openfolia/ui/search-shortcut';
import { isApplePlatform } from '@openfolia/ui/sidebar';

import { HelpService } from '../help/help.service';
import { keyCaps, type KeyPlatform } from './key-caps';
import {
  SHORTCUT_AREAS,
  SHORTCUTS,
  type Shortcut,
  type ShortcutArea,
} from './shortcuts';

/** The shortcut reference's article ID in the user guide (generated from the same catalogue). */
const SHORTCUTS_ARTICLE = 'guide.reference.shortcuts';

/**
 * Whether a key press opens the shortcut overlay: `?` with no Ctrl, Cmd or Alt (Shift is how
 * most layouts type it; AltGr, which Windows reports as Ctrl+Alt, is fine too).
 */
export function isShortcutsOverlayKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'> &
    Partial<Pick<KeyboardEvent, 'getModifierState'>>,
): boolean {
  if (event.key !== '?' || event.metaKey) return false;
  if (event.getModifierState?.('AltGraph')) return true;
  return !event.ctrlKey && !event.altKey;
}

/** Whether the shortcut overlay is open: `?`, and the account menu's entry, open it; the shell holds it. */
@Injectable({ providedIn: 'root' })
export class ShortcutsOverlay {
  private readonly openState = signal(false);
  readonly isOpen = this.openState.asReadonly();

  open(): void {
    this.openState.set(true);
  }

  close(): void {
    this.openState.set(false);
  }
}

/** One area of the overlay: its title and its shortcuts, each as its alternatives' key caps. */
interface AreaRows {
  readonly id: ShortcutArea;
  readonly title: string;
  readonly rows: readonly {
    readonly id: string;
    readonly label: string;
    readonly alternatives: readonly (readonly string[])[];
  }[];
}

/**
 * The keyboard shortcut overlay (#221): `?` anywhere outside a field, or "Keyboard shortcuts"
 * in the account menu. It lists the shortcut catalogue (`shortcuts.ts`), the same one the user
 * guide's reference is generated from, by area, with each shortcut's keys as this platform writes
 * them (`keyCaps`, which the reference uses too) in the interface language. A link opens that
 * reference when help links are on. Escape closes it and focus goes back where it was.
 */
@Component({
  selector: 'of-shortcuts-overlay',
  imports: [ZardDialogImports, KbdComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <z-dialog
      [zVisible]="overlay.isOpen()"
      (zVisibleChange)="$event ? overlay.open() : overlay.close()"
      zWidth="40rem"
      class="gap-3 sm:max-w-[min(40rem,calc(100%-2rem))]"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.shortcutsOverlay.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.shortcutsOverlay.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (overlay.isOpen()) {
        <div
          data-slot="shortcuts-list"
          class="-mx-4 max-h-[min(34rem,65dvh)] overflow-y-auto overscroll-contain px-4"
          tabindex="0"
          [attr.aria-label]="'editor.shortcutsOverlay.title' | transloco"
        >
          @for (area of areas(); track area.id) {
            <section
              class="pb-3"
              [attr.aria-labelledby]="'shortcuts-' + area.id"
            >
              <h3
                [id]="'shortcuts-' + area.id"
                class="text-muted-foreground m-0 pt-2 pb-1 text-xs font-medium"
              >
                {{ area.title }}
              </h3>
              <dl class="divide-border m-0 divide-y">
                @for (row of area.rows; track row.id) {
                  <div
                    class="flex items-start justify-between gap-4 py-2"
                    [attr.data-shortcut]="row.id"
                  >
                    <dt class="min-w-0 break-words">{{ row.label }}</dt>
                    <dd
                      class="m-0 flex shrink-0 flex-wrap items-center justify-end gap-1"
                    >
                      @for (caps of row.alternatives; track $index) {
                        @if (!$first) {
                          <span class="text-muted-foreground text-xs">{{
                            'editor.shortcutsOverlay.or' | transloco
                          }}</span>
                        }
                        <span class="inline-flex items-center gap-0.5">
                          @for (cap of caps; track $index) {
                            <kbd of-kbd>{{ cap }}</kbd>
                          }
                        </span>
                      }
                    </dd>
                  </div>
                }
              </dl>
            </section>
          }
        </div>
        @if (guide(); as href) {
          <a
            class="text-muted-foreground hover:text-foreground focus-visible:ring-ring justify-self-start rounded-sm text-xs underline underline-offset-4 outline-none focus-visible:ring-2"
            data-slot="shortcuts-guide"
            [href]="href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ 'editor.shortcutsOverlay.inGuide' | transloco }}</a
          >
        }
      }
    </z-dialog>
  `,
})
export class ShortcutsOverlayComponent {
  protected readonly overlay = inject(ShortcutsOverlay);
  private readonly help = inject(HelpService);
  private readonly t = injectTranslate();
  private readonly platform: KeyPlatform = isApplePlatform() ? 'mac' : 'pc';

  /** The guide's shortcut reference, when help links are on. */
  protected readonly guide = computed(() => this.help.href(SHORTCUTS_ARTICLE));

  /** The catalogue by area, in the areas' order; an area without shortcuts is left out. */
  protected readonly areas = computed<readonly AreaRows[]>(() => {
    const translate = (key: string) => this.t(key);
    const shortcuts = Object.entries(SHORTCUTS) as [string, Shortcut][];
    return (Object.keys(SHORTCUT_AREAS) as ShortcutArea[])
      .map((area) => ({
        id: area,
        title: this.t(SHORTCUT_AREAS[area]),
        rows: shortcuts
          .filter(([, shortcut]) => shortcut.area === area)
          .map(([id, shortcut]) => ({
            id,
            label: this.t(shortcut.label),
            alternatives: shortcut.keys.map(
              (keys) => keyCaps(keys, this.platform, translate) ?? [keys],
            ),
          })),
      }))
      .filter((area) => area.rows.length > 0);
  });

  protected onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || !isShortcutsOverlayKey(event))
      return;
    if (this.overlay.isOpen() || !isPageShortcut(event)) return;
    event.preventDefault();
    this.overlay.open();
  }
}
