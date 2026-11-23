import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { MeService } from '../permissions/me';
import type { TermMode } from './term-draft';
import type { IndexedTerm } from './term-index';
import { TermPanelComponent } from './term-panel.component';
import type { TermContent, TermUse } from './terms-model';

const charger: TermContent = {
  schemaVersion: 1,
  id: 'charger',
  status: 'approved',
  domain: 'charging',
  languages: {
    en: {
      preferred: 'charger',
      allowed: [{ term: 'charging unit', note: 'In short texts.' }],
      forbidden: [{ term: 'loader' }],
    },
  },
};

const indexed = (id: string, preferred: string, status = 'approved') =>
  ({
    id,
    preferred: { en: preferred },
    domain: undefined,
    status,
    replacedBy: undefined,
  }) satisfies IndexedTerm;

@Component({
  imports: [TermPanelComponent],
  template: `<of-term-panel
    [term]="term()"
    [mode]="mode()"
    [languages]="['en', 'de']"
    changeSetTitle="Spring"
    changeSetId="cs1"
    saveState="saved"
    [terms]="terms()"
    [linkedBy]="linkedBy()"
    [usedIn]="usedIn()"
    [usedInCount]="usedInCount()"
    (changed)="changes.push($event); term.set($event)"
    (deleteRequested)="deletes = deletes + 1"
  />`,
})
class Host {
  readonly term = signal<TermContent>(charger);
  readonly mode = signal<TermMode>({ kind: 'edit' });
  readonly terms = signal<readonly IndexedTerm[]>([]);
  readonly linkedBy = signal<readonly IndexedTerm[]>([]);
  readonly usedIn = signal<readonly TermUse[]>([]);
  readonly usedInCount = signal(0);
  readonly changes: TermContent[] = [];
  deletes = 0;
}

async function render(
  setup: (host: Host) => void = () => undefined,
  permissions = ['content.read', 'content.edit'],
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'u1',
    kind: 'user',
    name: 'U',
    role: '',
    permissions: new Set(permissions),
    editsEverything: true,
  });
  const fixture = TestBed.createComponent(Host);
  setup(fixture.componentInstance);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
      await fixture.whenStable();
    }
  };
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const section = (lang: string) =>
    el.querySelector(`section[data-lang="${lang}"]`) as HTMLElement;
  return { host: fixture.componentInstance, el, settle, section };
}

const key = (target: HTMLElement, k: string) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
  );

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('TermPanelComponent', () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('shows each configured language, the variants as chips, and where edits are saved', async () => {
    const { el, section } = await render();
    expect(el.textContent).toContain('Saved to revision “Spring”');
    expect(
      el.querySelector('[data-slot="term-open-review"]')?.getAttribute('href'),
    ).toBe('/review?cs=cs1');
    const en = section('en');
    expect(
      (en.querySelector('#term-preferred-en') as HTMLInputElement).value,
    ).toBe('charger');
    const chips = (slot: string) =>
      Array.from(
        en.querySelectorAll(
          `[data-slot="${slot}"] [data-slot="variant-chips"] li`,
        ),
      ).map((li) => li.textContent?.trim());
    expect(chips('term-allowed')).toEqual(['charging unit']);
    expect(chips('term-forbidden')).toEqual(['loader']);
    // Forbidden in words (its label), struck through besides: never by colour alone.
    expect(
      en.querySelector('[data-slot="term-forbidden"]')?.textContent,
    ).toContain('Forbidden variants');
    expect(
      en.querySelector('[data-slot="term-forbidden"] z-badge')?.className,
    ).toContain('line-through');
    // German has no entry yet: a preferred field to start it, nothing else.
    const de = section('de');
    expect(
      (de.querySelector('#term-preferred-de') as HTMLInputElement).placeholder,
    ).toBe('Not in this language yet');
    expect(de.querySelector('[data-slot="term-allowed"]')).toBeNull();
  });

  it('adds a variant with Enter and removes the last with Backspace, keeping the notes', async () => {
    const { host, section, settle } = await render();
    const input = section('en').querySelector(
      '#term-allowed-en',
    ) as HTMLInputElement;
    type(input, ' power  unit ');
    key(input, 'Enter');
    await settle();
    expect(host.changes.at(-1)?.languages['en']?.allowed).toEqual([
      { term: 'charging unit', note: 'In short texts.' },
      { term: 'power unit' },
    ]);
    // The same variant again (case aside) is not added twice.
    type(input, 'Power Unit');
    key(input, 'Enter');
    await settle();
    expect(host.changes).toHaveLength(1);
    type(input, '');
    key(input, 'Backspace');
    await settle();
    expect(host.changes.at(-1)?.languages['en']?.allowed).toEqual([
      { term: 'charging unit', note: 'In short texts.' },
    ]);
  });

  it('removes a chip by its own button and refuses the preferred variant as a forbidden one', async () => {
    const { host, section, settle } = await render();
    const forbidden = section('en').querySelector(
      '[data-slot="term-forbidden"]',
    ) as HTMLElement;
    const remove = forbidden.querySelector(
      '[data-slot="variant-remove"]',
    ) as HTMLButtonElement;
    expect(remove.getAttribute('aria-label')).toBe('Remove loader');
    remove.click();
    await settle();
    expect(host.changes.at(-1)?.languages['en']?.forbidden).toEqual([]);

    const input = forbidden.querySelector('input') as HTMLInputElement;
    type(input, 'Charger');
    key(input, 'Enter');
    await settle();
    expect(host.changes).toHaveLength(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('starts a language from its preferred variant and never removes the last one', async () => {
    const { host, section, settle } = await render();
    const de = section('de').querySelector(
      '#term-preferred-de',
    ) as HTMLInputElement;
    de.value = 'Ladegerät';
    de.dispatchEvent(new Event('blur'));
    await settle();
    expect(Object.keys(host.changes.at(-1)!.languages)).toEqual(['en', 'de']);

    host.term.set(charger);
    host.changes.length = 0;
    await settle();
    const en = section('en').querySelector(
      '#term-preferred-en',
    ) as HTMLInputElement;
    en.value = '';
    en.dispatchEvent(new Event('blur'));
    await settle();
    expect(host.changes).toEqual([]);
    expect(en.value).toBe('charger');
    expect(section('en').textContent).toContain(
      'A language with variants or a definition needs its preferred term.',
    );
  });

  it('asks a deprecated term for an optional replacement among the other terms', async () => {
    const { el, host, settle } = await render((h) => {
      h.term.set({ ...charger, status: 'deprecated' });
      h.terms.set([
        indexed('charger', 'charger'),
        indexed('station', 'charging station'),
        indexed('old', 'old thing', 'deprecated'),
      ]);
    });
    const trigger = el.querySelector(
      '[data-slot="term-replaced-by"] [role="combobox"]',
    ) as HTMLButtonElement;
    expect(trigger.textContent).toContain('No replacement');
    trigger.click();
    await settle();
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('z-select-item'),
    );
    // Neither itself nor another deprecated term.
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      'No replacement',
      'charging station (station)',
    ]);
    options[1]!.click();
    await settle();
    expect(host.changes.at(-1)).toMatchObject({
      status: 'deprecated',
      replacedBy: 'station',
    });
  });

  it('offers Delete, blocked with the reason while another term names it as its replacement', async () => {
    const free = await render();
    const button = () =>
      free.el.querySelector('[data-slot="term-delete"]') as HTMLButtonElement;
    button().click();
    await free.settle();
    expect(free.host.deletes).toBe(1);

    free.host.linkedBy.set([indexed('power-pack', 'power pack', 'deprecated')]);
    await free.settle();
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(
      free.el.querySelector('[data-slot="term-linked"]')?.textContent,
    ).toContain('power pack (power-pack)');
    button().click();
    await free.settle();
    expect(free.host.deletes).toBe(1);

    // Modules linking it (#245): kept too, the first few named, the rest counted.
    free.host.linkedBy.set([]);
    free.host.usedIn.set(
      Array.from({ length: 6 }, (_, i) => ({
        moduleId: `m${i}`,
        lang: 'en',
        title: `Module ${i}`,
      })),
    );
    free.host.usedInCount.set(7);
    await free.settle();
    expect(button().getAttribute('aria-disabled')).toBe('true');
    const used =
      free.el.querySelector('[data-slot="term-used-in"]')?.textContent ?? '';
    expect(used).toContain('7');
    expect(used).toContain('Module 0 (en), Module 1 (en)');
    expect(used).toContain('Module 4 (en), …');
    expect(used).not.toContain('Module 5');
    button().click();
    await free.settle();
    expect(free.host.deletes).toBe(1);
  });

  it('is read-only with the reason when the term cannot be changed now', async () => {
    const { el } = await render((h) =>
      h.mode.set({
        kind: 'read',
        reason: 'editor.terminology.blocked.needsChangeSet',
      }),
    );
    expect(el.querySelector('input')).toBeNull();
    expect(el.querySelector('[data-slot="term-state"]')?.textContent).toContain(
      'Choose or start a revision',
    );
    expect(
      el.querySelector('[data-slot="term-status"]')?.textContent?.trim(),
    ).toBe('Approved');
  });

  it('offers no Delete to a role that never edits', async () => {
    const { el } = await render(
      (h) => h.mode.set({ kind: 'read', reason: null }),
      ['content.read'],
    );
    expect(el.querySelector('[data-slot="term-delete"]')).toBeNull();
    expect(el.querySelector('[data-slot="term-state"]')).toBeNull();
  });
});
