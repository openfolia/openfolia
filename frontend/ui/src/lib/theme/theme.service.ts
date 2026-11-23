import { DOCUMENT } from '@angular/common';
import {
  ApplicationRef,
  computed,
  inject,
  Injectable,
  signal,
} from '@angular/core';

import { withThemeFade } from './theme-fade';

/** What the person chose: a fixed look, or whatever the device is set to. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** Where the choice is remembered in the browser. */
export const THEME_STORAGE_KEY = 'of-theme';

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

function isPreference(value: unknown): value is ThemePreference {
  return PREFERENCES.includes(value as ThemePreference);
}

/**
 * Light, dark or the device's setting. The default is the device's setting; a choice is
 * remembered in `localStorage` (when the browser allows it: a blocked or full storage just means
 * the choice lasts for this page) and applied as the `.dark` class on `<html>`, which switches
 * every token in `theme.css`. `index.html` applies the remembered choice before the app starts,
 * so a reload never flashes the other theme.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly darkQuery = this.document.defaultView?.matchMedia?.(
    '(prefers-color-scheme: dark)',
  );

  private readonly systemDark = signal(this.darkQuery?.matches ?? false);
  private readonly chosen = signal<ThemePreference>(this.read());
  /** The latest choice asked for: `chosen` follows it inside the crossfade, a moment later. */
  private requested = this.chosen();
  private readonly appRef = inject(ApplicationRef);

  /** The choice: `light`, `dark` or `system`. */
  readonly preference = this.chosen.asReadonly();
  /** The look on screen. */
  readonly resolved = computed<'light' | 'dark'>(() => {
    const preference = this.chosen();
    if (preference !== 'system') return preference;
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    // The device switching (at sunset, say) while the choice is `system`: no fade, as the
    // person did not ask for it at this moment.
    this.darkQuery?.addEventListener?.('change', (event) => {
      this.systemDark.set(event.matches);
      this.apply();
    });
    this.apply();
  }

  /** Shows `preference` at once, with the crossfade, and remembers it. */
  choose(preference: ThemePreference): void {
    if (preference === this.requested) return;
    this.requested = preference;
    withThemeFade((inFade) => {
      this.chosen.set(preference);
      this.apply();
      // Inside the fade, render now so its new picture already has the new sun or moon. Outside
      // it, the caller may be in change detection, and the next render shows it anyway.
      if (inFade) this.appRef.tick();
    }, this.document);
    this.write(preference);
  }

  /** Puts the resolved look on `<html>`: the class for the tokens, `color-scheme` for native parts. */
  private apply(): void {
    const root = this.document.documentElement;
    const dark = this.resolved() === 'dark';
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }

  private read(): ThemePreference {
    try {
      const stored =
        this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY);
      return isPreference(stored) ? stored : 'system';
    } catch {
      return 'system';
    }
  }

  private write(preference: ThemePreference): void {
    try {
      this.document.defaultView?.localStorage.setItem(
        THEME_STORAGE_KEY,
        preference,
      );
    } catch {
      // Storage blocked (private mode, a policy): the choice lasts for this page only.
    }
  }
}
