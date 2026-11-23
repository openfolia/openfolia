import {
  computed,
  Injector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { describe, expect, it } from 'vitest';

import { LanguageService } from '@openfolia/ui/i18n';

import { labelLanguage, labelsInUi, UiTexts } from './ui-texts';

const LANGUAGES = { source: 'en', targets: ['de', 'fr'] };

function setUp() {
  const locale = signal('en');
  // An injector of its own: the language is a signal the test sets.
  const injector = Injector.create({
    providers: [
      { provide: LanguageService, useValue: { locale } },
      { provide: UiTexts, useClass: UiTexts },
    ],
  });
  return { locale, injector, texts: injector.get(UiTexts) };
}

describe('labelLanguage (#731)', () => {
  it('takes the interface language, else a project language of the same base', () => {
    expect(labelLanguage(LANGUAGES, 'de')).toBe('de');
    expect(labelLanguage({ source: 'en', targets: ['de-AT'] }, 'de')).toBe(
      'de-AT',
    );
    expect(labelLanguage(LANGUAGES, 'it')).toBe('it');
    expect(labelLanguage(null, 'de')).toBe('de');
  });
});

describe('UiTexts (#731)', () => {
  it('shows a text in the interface language, falling back to the source language', () => {
    const { locale, texts } = setUp();
    const title = { en: 'Operating manual', de: 'Betriebsanleitung' };
    expect(texts.text(title, LANGUAGES)).toBe('Operating manual');
    locale.set('de');
    expect(texts.text(title, LANGUAGES)).toBe('Betriebsanleitung');
    expect(texts.text({ en: 'Only English' }, LANGUAGES)).toBe('Only English');
    expect(texts.text('One text', LANGUAGES)).toBe('One text');
    expect(texts.text(undefined)).toBe('');
  });

  it('follows a language switch in a computed, and remembers the last configuration’s source', () => {
    const { locale, injector, texts } = setUp();
    runInInjectionContext(injector, () => {
      const raw = signal<{
        languages: typeof LANGUAGES;
        moduleTypes: { id: string; label: { en: string; de: string } }[];
      } | null>({
        languages: LANGUAGES,
        moduleTypes: [
          { id: 'concept', label: { en: 'Concept', de: 'Konzept' } },
        ],
      });
      const shown = labelsInUi(raw);
      const label = computed(() => shown()?.moduleTypes[0]?.label);
      expect(label()).toBe('Concept');
      locale.set('de');
      expect(label()).toBe('Konzept');
    });
    // Without languages given: the last configuration's (its source language is `en`).
    locale.set('fr');
    expect(texts.text({ de: 'Nur Deutsch', en: 'English' })).toBe('English');
  });
});
