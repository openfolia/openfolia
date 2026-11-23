import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import type { ProjectConfig } from '../content/browser-model';
import type { NewManual } from './manual-creation';
import {
  NewManualDialogComponent,
  type KnownManual,
  type NewManualPrefill,
} from './new-manual-dialog.component';

const CONFIG = {
  languages: { source: 'en', targets: [] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [],
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'hazard', label: 'Hazard', safety: true },
  ],
} as unknown as ProjectConfig;

@Component({
  imports: [NewManualDialogComponent],
  template: `
    <of-new-manual-dialog
      [(open)]="open"
      [config]="config"
      [manuals]="manuals()"
      changeSetTitle="Edits"
      [blocked]="blocked()"
      [prefill]="prefill()"
      (create)="created.push($event)"
    />
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly config = CONFIG;
  readonly manuals = signal<readonly KnownManual[]>([
    { id: 'guide', title: 'Guide', audience: 'public' },
    { id: 'old', title: 'Old', state: 'deleted' },
    { id: 'service', title: 'Service', audience: 'internal' },
    { id: 'leaflet', title: 'Leaflet', kind: 'derived' },
  ]);
  readonly blocked = signal<string | null>(null);
  readonly prefill = signal<NewManualPrefill | null>(null);
  readonly created: NewManual[] = [];
}

async function setup() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(HostComponent);
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  const host = fixture.componentInstance;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  const open = async () => {
    host.open.set(true);
    await settle();
  };
  const type = async (title: string) => {
    const field = document.querySelector<HTMLInputElement>(
      '#new-manual-title',
    ) as HTMLInputElement;
    field.value = title;
    field.dispatchEvent(new Event('input'));
    await settle();
  };
  const submit = async () => {
    document
      .querySelector<HTMLFormElement>('#new-manual-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const hint = () =>
    document.querySelector('#new-manual-id')?.textContent?.trim() ?? '';
  return { fixture, host, settle, open, type, submit, hint };
}

describe('NewManualDialogComponent', () => {
  it('makes the ID from the title and hands the manual over', async () => {
    const t = await setup();
    await t.open();
    expect(document.body.textContent).toContain('“Edits”');
    expect(t.hint()).toContain('made from its title');
    await t.type('  Quick   start guide ');
    expect(t.hint()).toBe('Saved as quick-start-guide');
    await t.submit();
    expect(t.host.created).toEqual([
      {
        id: 'quick-start-guide',
        title: 'Quick start guide',
        audience: undefined,
        copyFrom: undefined,
      },
    ]);
    expect(t.host.open()).toBe(false);
  });

  it('refuses an empty title and a taken ID, deleted manuals included', async () => {
    const t = await setup();
    await t.open();
    await t.submit();
    expect(t.hint()).toBe('Give the manual a title.');
    await t.type('Guide');
    expect(t.hint()).toBe(
      'A manual with the ID guide exists already. Choose another title.',
    );
    await t.type('OLD');
    expect(t.hint()).toContain('ID old exists already');
    await t.type('!!!');
    expect(t.hint()).toContain('needs a letter or digit');
    await t.submit();
    expect(t.host.created).toEqual([]);
    expect(t.host.open()).toBe(true);
  });

  it('refuses without a draft change set, saying why', async () => {
    const t = await setup();
    t.host.blocked.set('editor.manuals.new.needsChangeSet');
    await t.open();
    expect(
      document.querySelector('[data-testid=new-manual-blocked]')?.textContent,
    ).toContain('Choose or start a draft revision first');
    await t.type('Quick start guide');
    await t.submit();
    expect(t.host.created).toEqual([]);
  });

  it('starts as a duplicate: "Copy of" title and the copy chosen', async () => {
    const t = await setup();
    t.host.prefill.set({ title: 'Copy of Guide', copyFrom: 'guide' });
    await t.open();
    expect(
      document.querySelector<HTMLInputElement>('#new-manual-title')?.value,
    ).toBe('Copy of Guide');
    expect(
      document
        .querySelector('[data-slot=checkbox]')
        ?.getAttribute('data-state'),
    ).toBe('checked');
    await t.submit();
    expect(t.host.created).toEqual([
      {
        id: 'copy-of-guide',
        title: 'Copy of Guide',
        audience: undefined,
        copyFrom: 'guide',
      },
    ]);
  });

  it('asks for the manual to copy once copying is chosen', async () => {
    const t = await setup();
    await t.open();
    await t.type('Field guide');
    document
      .querySelector<HTMLInputElement>('[data-slot=checkbox] input')
      ?.click();
    await t.settle();
    await t.submit();
    expect(document.body.textContent).toContain('Choose the manual to copy.');
    expect(t.host.created).toEqual([]);
  });

  it('makes a derived manual: its source among the manuals it may gather from, and its types (#669)', async () => {
    const t = await setup();
    await t.open();
    await t.type('Safety leaflet');
    // For the public: a manual for internal readers is no source of it.
    const pick = async (select: string, label: string) => {
      document
        .querySelector<HTMLElement>(`[data-testid=${select}] button`)
        ?.click();
      await t.settle();
      Array.from(document.querySelectorAll<HTMLElement>('z-select-item'))
        .find((o) => o.textContent?.trim() === label)
        ?.click();
      await t.settle();
    };
    await pick('new-manual-audience', 'Public');
    document
      .querySelector<HTMLElement>(
        '[data-kind=derived] [role=radio], [data-kind=derived] input',
      )
      ?.click();
    await t.settle();
    // None chosen: the configured safety types.
    expect(
      document.querySelector('[data-testid=new-manual-derived]')?.textContent,
    ).toContain('the safety types the settings mark (Hazard)');
    await t.submit();
    expect(document.body.textContent).toContain(
      'Choose the manual it gathers from.',
    );
    expect(t.host.created).toEqual([]);
    document
      .querySelector<HTMLElement>('[data-testid=new-manual-source] button')
      ?.click();
    await t.settle();
    const offered = Array.from(
      document.querySelectorAll<HTMLElement>('z-select-item'),
    ).map((o) => o.textContent?.trim());
    // A derived manual and one for a narrower audience are no source; a deleted one neither.
    expect(offered).toContain('Guide');
    expect(offered).not.toContain('Service');
    expect(offered).not.toContain('Leaflet');
    expect(offered).not.toContain('Old');
    Array.from(document.querySelectorAll<HTMLElement>('z-select-item'))
      .find((o) => o.textContent?.trim() === 'Guide')
      ?.click();
    await t.settle();
    await t.submit();
    expect(t.host.created).toEqual([
      {
        id: 'safety-leaflet',
        title: 'Safety leaflet',
        audience: 'public',
        copyFrom: undefined,
        derivedFrom: 'guide',
        moduleTypes: undefined,
      },
    ]);
  });
});
