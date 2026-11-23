import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { NewTermDialogComponent } from './new-term-dialog.component';
import type { TermContent } from './terms-model';

@Component({
  imports: [NewTermDialogComponent],
  template: `<of-new-term-dialog
    [(open)]="open"
    [languages]="['en', 'de']"
    changeSetTitle="Spring"
    [takenIds]="taken"
    [failure]="failure()"
    (created)="created.push($event)"
  />`,
})
class Host {
  readonly open = signal(false);
  readonly taken = new Set(['charger']);
  readonly failure = signal<string | null>(null);
  readonly created: TermContent[] = [];
}

async function render() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
      await fixture.whenStable();
    }
  };
  host.open.set(true);
  await settle();
  return { host, settle };
}

const dialog = () => document.querySelector('z-dialog-panel') as HTMLElement;
const field = (id: string) =>
  dialog().querySelector(`#${id}`) as HTMLInputElement;
const submit = () =>
  dialog().querySelector('[data-slot="new-term-submit"]') as HTMLButtonElement;

function enter(id: string, value: string) {
  field(id).value = value;
  field(id).dispatchEvent(new Event('input'));
}

describe('NewTermDialogComponent', () => {
  afterEach(() => {
    document.querySelectorAll('z-dialog-panel').forEach((e) => e.remove());
    document.querySelector('.cdk-overlay-container')?.remove();
  });

  it('derives the ID from the preferred term and hands on a proposed term', async () => {
    const { host, settle } = await render();
    expect(dialog().textContent).toContain(
      'The term is added to the revision “Spring”',
    );
    enter('new-term-preferred', 'Charging Station');
    await settle();
    expect(field('new-term-id').value).toBe('charging-station');
    enter('new-term-domain', ' charging ');
    await settle();
    submit().click();
    await settle();
    expect(host.created).toEqual([
      {
        schemaVersion: 1,
        id: 'charging-station',
        status: 'proposed',
        domain: 'charging',
        languages: {
          en: { preferred: 'Charging Station', allowed: [], forbidden: [] },
        },
      },
    ]);
  });

  it('keeps an ID once typed, and refuses an invalid or taken one', async () => {
    const { host, settle } = await render();
    enter('new-term-preferred', 'Charger');
    await settle();
    expect(field('new-term-id').value).toBe('charger');
    submit().click();
    await settle();
    expect(host.created).toEqual([]);
    expect(dialog().textContent).toContain(
      'A term with this ID exists already.',
    );
    expect(field('new-term-id').getAttribute('aria-invalid')).toBe('true');

    enter('new-term-id', 'Bad--id');
    await settle();
    expect(dialog().textContent).toContain(
      'Use lowercase letters, digits and single hyphens between them.',
    );
    enter('new-term-id', 'wall-charger');
    enter('new-term-preferred', 'Wallbox');
    await settle();
    // Typed by hand: the preferred term no longer changes it.
    expect(field('new-term-id').value).toBe('wall-charger');
    submit().click();
    await settle();
    expect(host.created.map((t) => t.id)).toEqual(['wall-charger']);
  });

  it('asks for the preferred term, and shows why adding failed', async () => {
    const { host, settle } = await render();
    submit().click();
    await settle();
    expect(host.created).toEqual([]);
    expect(dialog().textContent).toContain('Give the preferred term.');
    host.failure.set('editor.terminology.new.locked');
    await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Another revision is adding a term with this ID.',
    );
  });

  it('starts afresh each time it opens', async () => {
    const { host, settle } = await render();
    enter('new-term-preferred', 'Pump');
    await settle();
    host.open.set(false);
    await settle();
    host.open.set(true);
    await settle();
    expect(field('new-term-preferred').value).toBe('');
    expect(field('new-term-id').value).toBe('');
  });
});
