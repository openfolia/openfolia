import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { I18N_CONFIG } from './i18n-config';
import {
  LANGUAGE_STORAGE_KEY,
  preferredLanguage,
  PSEUDO_LANGUAGE,
  SOURCE_LANGUAGE,
  type UiLanguage,
} from './languages';

/**
 * The interface language. The default is the browser's language when we ship it, else English;
 * a choice is remembered in `localStorage` (storage that throws is ignored: the choice then
 * lasts for this page) and, once there is a user profile, belongs there. Switching loads the
 * language's files first, then changes every text at once, without a reload, and sets
 * `<html lang>`.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly transloco = inject(TranslocoService);
  private readonly config = inject(I18N_CONFIG);
  private readonly document = inject(DOCUMENT);

  /** The languages a person can choose, the pseudo-locale last (development builds only). */
  readonly languages: readonly UiLanguage[] = this.config.pseudo
    ? [...this.config.languages, PSEUDO_LANGUAGE]
    : this.config.languages;

  private readonly current = signal(this.initial());
  /** The latest language asked for: `current` follows it once its files are loaded. */
  private requested = this.current();

  /** The active language's id (`en`, `de`, …). */
  readonly active = this.current.asReadonly();
  /** The locale for `Intl` formatting: the pseudo-locale formats as English. */
  readonly locale = computed(() =>
    this.current() === PSEUDO_LANGUAGE.id ? SOURCE_LANGUAGE : this.current(),
  );

  /**
   * Loads the starting language and applies it; the app waits for it before the first render.
   * When its files do not load, the source language takes its place.
   */
  async init(): Promise<void> {
    const language = this.current();
    if (await this.load(language)) {
      this.apply(language);
      return;
    }
    await this.load(SOURCE_LANGUAGE);
    this.requested = SOURCE_LANGUAGE;
    this.apply(SOURCE_LANGUAGE);
  }

  /**
   * Switches to `language` once its files are loaded, and remembers the choice. When they do not
   * load, nothing changes and nothing is remembered, so choosing it again retries.
   */
  async choose(language: string): Promise<void> {
    if (!this.isOffered(language) || language === this.requested) return;
    this.requested = language;
    const loaded = await this.load(language);
    // A later choice made while this one was loading wins.
    if (this.requested !== language) return;
    if (!loaded) {
      // Transloco may have switched to its fallback on the failure: back to what is shown.
      this.requested = this.current();
      this.transloco.setActiveLang(this.current());
      return;
    }
    this.apply(language);
    this.write(language);
  }

  /** Whether every scope of `language` is loaded (Transloco reports a failed load as a success). */
  private async load(language: string): Promise<boolean> {
    try {
      await firstValueFrom(this.transloco.load(language), {
        defaultValue: undefined,
      });
    } catch {
      // Offline, a deployment in progress: reported below as not loaded.
    }
    const keys = Object.keys(this.transloco.getTranslation(language));
    return this.config.scopes.every((scope) =>
      keys.some((key) => key.startsWith(`${scope}.`)),
    );
  }

  private apply(language: string): void {
    this.transloco.setActiveLang(language);
    this.current.set(language);
    this.document.documentElement.lang = language;
  }

  private isOffered(language: string): boolean {
    return this.languages.some((l) => l.id === language);
  }

  private initial(): string {
    const stored = this.read();
    if (stored && this.isOffered(stored)) return stored;
    const browser = this.document.defaultView?.navigator?.languages ?? [];
    return preferredLanguage(browser, this.config.languages);
  }

  private read(): string | null {
    try {
      return (
        this.document.defaultView?.localStorage.getItem(LANGUAGE_STORAGE_KEY) ??
        null
      );
    } catch {
      return null;
    }
  }

  private write(language: string): void {
    try {
      this.document.defaultView?.localStorage.setItem(
        LANGUAGE_STORAGE_KEY,
        language,
      );
    } catch {
      // Storage blocked (private mode, a policy): the choice lasts for this page only.
    }
  }
}
