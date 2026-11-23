import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { ModuleRenamePanelComponent } from './module-rename-panel.component';

const REFERENCES = '/api/change-sets/cs1/module-references/charging';

const plan = (workingCopies: unknown[] = []) => ({
  data: {
    type: 'ModuleReferences',
    id: 'charging',
    attributes: {
      languages: ['de', 'en'],
      references: [
        { type: 'manual', manualId: 'operating' },
        { type: 'module', lang: 'en', moduleId: 'safety-note' },
      ],
      translations: [],
    },
    meta: { head: 'h1', workingCopies },
  },
});

@Component({
  imports: [ModuleRenamePanelComponent],
  template: `<of-module-rename-panel
    moduleId="charging"
    changeSetId="cs1"
    [title]="title()"
    [busy]="busy()"
    (rename)="renamed.push($event)"
    (closed)="cancelled = cancelled + 1"
  />`,
})
class Host {
  readonly title = signal('Battery charging');
  readonly busy = signal(false);
  readonly renamed: string[] = [];
  cancelled = 0;
}

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  await settle();
  const input = () => el.querySelector<HTMLInputElement>('#module-new-id')!;
  const submit = () =>
    el.querySelector<HTMLButtonElement>('button[data-rename-submit]')!;
  const type = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    await settle();
  };
  return { fixture, http, el, settle, input, submit, type };
}

describe('ModuleRenamePanelComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('prefills the title’s slug, lists what the rename rewrites, and hands on the new ID', async () => {
    const { fixture, http, el, settle, input, submit } = await render();
    expect(input().value).toBe('battery-charging');
    // Nothing to rename until what it touches is read.
    expect(submit().disabled).toBe(true);
    http.expectOne(REFERENCES).flush(plan());
    await settle();
    expect(el.querySelector('[data-rename-summary]')?.textContent?.trim()).toBe(
      'Moves the module in German, English and rewrites the 2 files naming it:',
    );
    expect(
      Array.from(el.querySelectorAll('[data-reference]')).map((li) =>
        li.textContent?.trim(),
      ),
    ).toEqual(['operating', 'safety-note (en)']);
    expect(submit().disabled).toBe(false);
    submit().click();
    await settle();
    expect(fixture.componentInstance.renamed).toEqual(['battery-charging']);
  });

  it('refuses an ID that is no module ID, or the same, before asking the server', async () => {
    const { fixture, http, el, settle, submit, type, input } = await render();
    http
      .expectOne(REFERENCES)
      .flush(plan([{ type: 'module', lang: 'en', moduleId: 'charging' }]));
    await settle();
    expect(el.textContent).toContain(
      'One of them has unsaved edits: a save point commits them first.',
    );
    await type('Not An ID');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('Use lowercase letters, digits');
    expect(submit().disabled).toBe(true);
    await type('charging');
    expect(el.textContent).toContain("This is the module's ID already.");
    expect(submit().disabled).toBe(true);
    await type('charging-the-battery');
    expect(input().getAttribute('aria-invalid')).toBeNull();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(fixture.componentInstance.renamed).toEqual(['charging-the-battery']);
  });

  it('says so when what it touches cannot be read, and cancels', async () => {
    const { fixture, http, el, settle, submit } = await render();
    http
      .expectOne(REFERENCES)
      .flush(
        { errors: [{ status: '403', code: 'forbidden' }] },
        { status: 403, statusText: 'Forbidden' },
      );
    await settle();
    expect(el.textContent).toContain(
      'What the rename would change could not be read.',
    );
    expect(submit().disabled).toBe(true);
    const cancel = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    )!;
    cancel.click();
    await settle();
    expect(fixture.componentInstance.cancelled).toBe(1);
  });
});
