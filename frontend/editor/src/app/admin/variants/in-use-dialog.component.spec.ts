import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { translated } from '@openfolia/ui/i18n';

import {
  InUseDialogComponent,
  type InUseRequest,
} from './in-use-dialog.component';

@Component({
  imports: [InUseDialogComponent],
  template: `<of-in-use-dialog
    [request]="request()"
    (archive)="archived = archived + 1"
    (closed)="closed = closed + 1"
  />`,
})
class Host {
  readonly request = signal<InUseRequest | null>(null);
  archived = 0;
  closed = 0;
}

const REQUEST: InUseRequest = {
  what: translated('editor.admin.settings.changes.remove', { label: 'Small' }),
  count: { modules: 2, manuals: 1 },
  filter: { audience: 'public' },
  places: [
    {
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      issue: 'unknown-variant-value',
      at: 'b3',
    },
    {
      subject: { type: 'manual', manualId: 'service' },
      issue: 'unknown-variant-value',
    },
  ],
  total: 3,
  canArchive: true,
};

async function render(request: InUseRequest) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideZard()],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.request.set(request);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, doc: document.body };
}

describe('InUseDialogComponent', () => {
  it('names how much uses the value and where, each place a link, and offers archiving', async () => {
    const { doc, host } = await render(REQUEST);
    expect(doc.textContent).toContain('Remove “Small”');
    expect(doc.textContent).toContain(
      'Used by 2 modules and 1 manual you can see.',
    );
    const places = doc.querySelector('[data-slot=in-use-places]');
    const links = [...(places?.querySelectorAll('a') ?? [])].map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toEqual([
      '/content/en/charging?block=b3',
      '/manuals?manual=service',
    ]);
    expect(doc.textContent).toContain('Used in 3 places');
    expect(doc.textContent).toContain('And 1 more place.');
    doc.querySelector<HTMLButtonElement>('[data-slot=in-use-archive]')?.click();
    expect(host.archived).toBe(1);
  });

  it('lists the builds a variant value appears in, each a link', async () => {
    const { doc } = await render({
      ...REQUEST,
      builds: {
        total: 3,
        items: [
          {
            manualId: 'operating',
            manualTitle: 'Operating manual',
            slug: 'model=small',
            label: 'Small',
          },
        ],
      },
    });
    const builds = doc.querySelector('[data-slot=in-use-builds]');
    expect(builds?.textContent).toContain('In 3 builds');
    expect(builds?.textContent).toContain('Operating manual · Small');
    expect(builds?.querySelector('a')?.getAttribute('href')).toBe(
      '/manuals?manual=operating&variant=model%3Dsmall',
    );
    expect(builds?.textContent).toContain('And 2 more builds.');
  });

  it('offers only Cancel for a value that cannot be archived', async () => {
    const { doc, host } = await render({
      ...REQUEST,
      places: [],
      total: 0,
      canArchive: false,
    });
    expect(doc.querySelector('[data-slot=in-use-archive]')).toBeNull();
    expect(doc.textContent).toContain('Change the content first.');
    const cancel = [...doc.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    );
    cancel?.click();
    expect(host.closed).toBeGreaterThan(0);
  });
});
