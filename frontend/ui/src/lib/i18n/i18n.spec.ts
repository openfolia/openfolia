import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';

import de from '../../i18n/de.json';
import en from '../../i18n/en.json';
import { ToasterComponent } from '../toast/toaster.component';
import { ToastService } from '../toast/toast.service';
import { DatePipe, NumberPipe, relativeTime } from './format.pipes';
import { LanguageService } from './language.service';
import {
  LANGUAGE_STORAGE_KEY,
  preferredLanguage,
  UI_LANGUAGES,
} from './languages';
import { provideI18nTesting } from './provide-i18n';
import { pseudoMessage } from './pseudo-locale';
import { translated } from './text.pipe';

@Component({
  selector: 'of-i18n-host',
  imports: [TranslocoPipe, NumberPipe, DatePipe, ToasterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p id="next">{{ 'ui.listFrame.next' | transloco }}</p>
    <p id="page">
      {{ 'ui.listFrame.pageOf' | transloco: { page: 1, last: 2, total: 1200 } }}
    </p>
    <p id="results">
      {{ 'ui.command.results' | transloco: { count: 1, term: 'x' } }}
    </p>
    <p id="number">{{ 1234.5 | ofNumber }}</p>
    <p id="date">
      {{ day | ofDate: { dateStyle: 'long', timeZone: 'UTC' } }}
    </p>
    <of-toaster />
  `,
})
class HostComponent {
  protected readonly day = new Date(Date.UTC(2026, 2, 5));
}

async function setup() {
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  TestBed.configureTestingModule({
    providers: [provideI18nTesting({ en: { ui: en }, de: { ui: de } })],
  });
  const fixture = TestBed.createComponent(HostComponent);
  await fixture.whenStable();
  const text = (id: string) =>
    fixture.nativeElement.querySelector(`#${id}`)?.textContent?.trim();
  return { fixture, text, language: TestBed.inject(LanguageService) };
}

describe('the UI language', () => {
  it('switches every text at once, without a reload, and sets <html lang>', async () => {
    const { fixture, text, language } = await setup();
    await language.choose('en');
    await fixture.whenStable();
    expect(text('next')).toBe('Next');
    expect(text('page')).toBe('Page 1 of 2 (1,200 in total)');
    expect(text('results')).toBe('1 result found for “x”');
    expect(text('number')).toBe('1,234.5');
    expect(text('date')).toBe('March 5, 2026');

    await language.choose('de');
    await fixture.whenStable();
    expect(text('next')).toBe('Weiter');
    expect(text('page')).toBe('Seite 1 von 2 (1.200 insgesamt)');
    expect(text('results')).toBe('1 Ergebnis für „x“');
    expect(text('number')).toBe('1.234,5');
    expect(text('date')).toBe('5. März 2026');
    expect(document.documentElement.lang).toBe('de');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('de');
  });

  it('translates a toast where it shows, so an open toast follows a switch', async () => {
    const { fixture, language } = await setup();
    await language.choose('en');
    TestBed.inject(ToastService).error(translated('ui.states.error.network'), {
      actionLabel: translated('ui.toast.undo'),
    });
    await fixture.whenStable();
    const toast = () =>
      (fixture.nativeElement.querySelector('of-toast') as HTMLElement)
        .textContent;
    expect(toast()).toContain('No connection');
    expect(toast()).toContain('Undo');
    await language.choose('de');
    await fixture.whenStable();
    expect(toast()).toContain('Keine Verbindung');
    expect(toast()).toContain('Rückgängig');
  });

  it('keeps the current language when the files of another do not load, and lets it retry', async () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    // German is offered but its files are missing.
    TestBed.configureTestingModule({
      providers: [provideI18nTesting({ en: { ui: en } })],
    });
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.whenStable();
    const language = TestBed.inject(LanguageService);
    await language.choose('en');
    await language.choose('de');
    await fixture.whenStable();
    expect(language.active()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).not.toBe('de');
    expect(
      fixture.nativeElement.querySelector('#next')?.textContent?.trim(),
    ).toBe('Next');
    // Choosing it again tries again rather than being ignored.
    const load = vi.spyOn(TestBed.inject(TranslocoService), 'load');
    await language.choose('de');
    expect(load).toHaveBeenCalledWith('de');
  });

  it('applies the last of two quick choices', async () => {
    const { fixture, text, language } = await setup();
    await language.choose('en');
    const first = language.choose('de');
    const second = language.choose('en');
    await Promise.all([first, second]);
    await fixture.whenStable();
    expect(language.active()).toBe('en');
    expect(text('next')).toBe('Next');
  });

  it('ignores a language it does not offer', async () => {
    const { language } = await setup();
    await language.choose('xx');
    expect(language.languages.map((l) => l.id)).not.toContain('xx');
    expect(language.active()).not.toBe('xx');
  });
});

describe('preferredLanguage', () => {
  it('takes the first shipped browser language, by primary subtag, else English', () => {
    expect(preferredLanguage(['de-AT', 'en'], UI_LANGUAGES)).toBe('de');
    expect(preferredLanguage(['fr', 'en-GB'], UI_LANGUAGES)).toBe('en');
    expect(preferredLanguage(['fr'], UI_LANGUAGES)).toBe('en');
    expect(preferredLanguage([], UI_LANGUAGES)).toBe('en');
  });
});

describe('the pseudo-locale', () => {
  it('accents and pads the text but keeps ICU syntax intact', () => {
    const out = pseudoMessage(
      'Page {page} of {n, plural, one {# item} other {# items}} ({total, number})',
    );
    expect(out.startsWith('⟦')).toBe(true);
    expect(out.endsWith('⟧')).toBe(true);
    expect(out).toContain('{page}');
    expect(out).toContain('{n, plural, one {# íţéɱ} other {# íţéɱš}}');
    expect(out).toContain('{total, number}');
    expect(out).toContain('Ƥáğé');
    expect(out).toContain('·');
  });
});

describe('relativeTime', () => {
  it('names the largest whole unit in the language', () => {
    const now = new Date(Date.UTC(2026, 0, 10));
    const before = new Date(Date.UTC(2026, 0, 7));
    expect(relativeTime(before, now, 'en')).toBe('3 days ago');
    expect(relativeTime(before, now, 'de')).toBe('vor 3 Tagen');
  });
});
