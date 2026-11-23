import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import type { ProjectConfig } from './browser-model';
import type { NewModule } from './module-creation';
import { NewModuleDialogComponent } from './new-module-dialog.component';

const type = (id: string, label: string) => ({
  id,
  label,
  restricted: false,
  snippet: false,
});

const configWith = (
  moduleTypes: ReturnType<typeof type>[],
  audiences: { id: string; label: string }[] = [],
) =>
  ({
    languages: { source: 'en', targets: ['de'] },
    moduleTypes,
    audiences,
    facets: [],
    variantAttributes: [],
    textAttributes: [],
    safetySymbols: [],
    outputLabels: {},
  }) as unknown as ProjectConfig;

@Component({
  imports: [NewModuleDialogComponent],
  template: `<of-new-module-dialog
    [(open)]="open"
    [config]="config()"
    changeSetTitle="Spring"
    (create)="created.push($event)"
  />`,
})
class Host {
  readonly open = signal(false);
  readonly config = signal(configWith([]));
  readonly created: NewModule[] = [];
}

async function render(
  moduleTypes: ReturnType<typeof type>[],
  audiences: { id: string; label: string }[] = [],
) {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideZard()],
  });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.config.set(configWith(moduleTypes, audiences));
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  host.open.set(true);
  await settle();
  TestBed.inject(HttpTestingController)
    .match(() => true)
    .forEach((r) =>
      r.flush({
        data: [],
        meta: {
          page: { currentPage: 1, lastPage: 1, perPage: 200, total: 0 },
        },
        links: { self: '', first: '', last: '', prev: null, next: null },
      }),
    );
  await settle();
  return { host, settle };
}

const dialog = () => document.querySelector('z-dialog-panel') as HTMLElement;
const typeTrigger = () =>
  dialog().querySelector(
    '[data-slot="new-module-type"] [role="combobox"]',
  ) as HTMLButtonElement;
const create = () =>
  Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === 'Create and open',
  ) as HTMLButtonElement;

function enterTitle(value: string) {
  const input = dialog().querySelector('#new-module-title') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('NewModuleDialogComponent', () => {
  afterEach(() =>
    document.querySelectorAll('z-dialog-panel').forEach((e) => e.remove()),
  );

  it('offers the configured module types in a select, none chosen until one is picked', async () => {
    const { host, settle } = await render([
      type('concept', 'Concept'),
      type('task', 'Task'),
    ]);
    expect(typeTrigger().getAttribute('aria-label')).toContain('Module type');
    expect(typeTrigger().textContent).toContain('Choose a type');
    // No choice made: the dialog asks for one instead of creating.
    enterTitle('Charging');
    await settle();
    create().click();
    await settle();
    expect(host.created).toEqual([]);
    expect(dialog().textContent).toContain('Choose a module type.');
    expect(typeTrigger().getAttribute('aria-invalid')).toBe('true');

    typeTrigger().click();
    await settle();
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('z-select-item'),
    );
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      'Concept',
      'Task',
    ]);
    options[1]?.click();
    await settle();
    expect(typeTrigger().textContent).toContain('Task');
    expect(dialog().textContent).not.toContain('Choose a module type.');
    create().click();
    await settle();
    expect(host.created).toEqual([
      expect.objectContaining({ id: 'charging', type: 'task' }),
    ]);
  });

  it('preselects the type when exactly one is configured', async () => {
    const { host, settle } = await render([type('concept', 'Concept')]);
    expect(typeTrigger().textContent).toContain('Concept');
    enterTitle('Charging');
    await settle();
    create().click();
    await settle();
    expect(host.created).toEqual([
      expect.objectContaining({ id: 'charging', type: 'concept' }),
    ]);
  });

  it('leaves the select empty and says the type is missing when none is configured', async () => {
    const { host, settle } = await render([]);
    expect(typeTrigger().textContent).toContain('Choose a type');
    enterTitle('Charging');
    await settle();
    create().click();
    await settle();
    expect(host.created).toEqual([]);
    expect(dialog().textContent).toContain('Choose a module type.');
  });

  it('names the level a module created without an audience counts as (#693)', async () => {
    await render(
      [type('concept', 'Concept')],
      [
        { id: 'operator', label: 'Operator' },
        { id: 'service', label: 'Service' },
      ],
    );
    const trigger = [
      ...dialog().querySelectorAll<HTMLButtonElement>('[role="combobox"]'),
    ].find((b) => b.getAttribute('aria-label')?.startsWith('Audience'));
    expect(trigger?.textContent).toContain('Not set: counts as Service');
  });
});
