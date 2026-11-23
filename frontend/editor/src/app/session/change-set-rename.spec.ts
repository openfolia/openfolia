import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetControlComponent } from './change-set-control.component';
import {
  ChangeSetRenameComponent,
  type ChangeSetRename,
} from './change-set-rename.component';
import { ChangeSetSession } from './change-set-session';

const tick = () => new Promise((resolve) => setTimeout(resolve));

const csItem = (id: string, author = 'a', title = `T ${id}`) => ({
  type: 'ChangeSet',
  id,
  attributes: {
    title,
    description: null as string | null,
    state: 'draft',
    author: { kind: 'user', id: author },
    baseRef: 'main',
    baseCommit: 'c',
    branch: `change-sets/${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});
const csPage = (...items: ReturnType<typeof csItem>[]) => ({
  data: items,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: items.length },
  },
  links: {},
});
const isList = (r: { url: string; method: string }) =>
  r.method === 'GET' && r.url === '/api/change-sets';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'a',
    kind: 'user',
    name: 'A',
    role: '',
    permissions: new Set(['content.edit', 'content.read.draft']),
  });
  return TestBed.inject(HttpTestingController);
}

@Component({
  imports: [ChangeSetRenameComponent],
  template: `<of-change-set-rename
    [title]="title"
    [description]="description"
    (save)="saved.set($event)"
    (dismissed)="dismissed.set(true)"
  />`,
})
class Host {
  title = 'Charging';
  description: string | null = 'First pass.';
  readonly saved = signal<ChangeSetRename | null>(null);
  readonly dismissed = signal(false);
}

describe('ChangeSetRenameComponent', () => {
  it('starts from what is there, saves once something differs, and Escape leaves it', async () => {
    setup();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const title = el.querySelector('input') as HTMLInputElement;
    const description = el.querySelector('textarea') as HTMLTextAreaElement;
    const save = el.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(title.value).toBe('Charging');
    expect(description.value).toBe('First pass.');
    expect(save.getAttribute('aria-disabled')).toBe('true');

    title.value = '  Charging, reworded ';
    title.dispatchEvent(new Event('input'));
    description.value = '   ';
    description.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(save.getAttribute('aria-disabled')).toBeNull();
    save.click();
    expect(fixture.componentInstance.saved()).toEqual({
      title: 'Charging, reworded',
      description: null,
    });

    title.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(fixture.componentInstance.dismissed()).toBe(true);
  });

  it('never saves a blank title', async () => {
    setup();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const title = el.querySelector('input') as HTMLInputElement;
    title.value = '  ';
    title.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    (el.querySelector('button[type=submit]') as HTMLButtonElement).click();
    expect(fixture.componentInstance.saved()).toBeNull();
  });
});

describe('ChangeSetSession.rename', () => {
  it('shows the new title at once and keeps what the API answers', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c1')));
    await refresh;
    session.choose('c1');

    const renaming = session.rename('c1', {
      title: 'Renamed',
      description: 'Why.',
    });
    expect(session.options()[0]?.title).toBe('Renamed');
    expect(session.selected()?.title).toBe('Renamed');
    const req = http.expectOne('/api/change-sets/c1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      data: {
        type: 'ChangeSet',
        id: 'c1',
        attributes: { title: 'Renamed', description: 'Why.' },
      },
    });
    const answered = csItem('c1', 'a', 'Renamed');
    answered.attributes.description = 'Why.';
    req.flush({ data: answered });
    expect((await renaming)?.attributes.title).toBe('Renamed');
    expect(session.options()[0]).toMatchObject({
      title: 'Renamed',
      description: 'Why.',
    });
  });

  it('puts the old title back when the API refuses, with no retry for a refusal', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c1')));
    await refresh;

    const renaming = session.rename('c1', {
      title: 'Renamed',
      description: null,
    });
    http.expectOne('/api/change-sets/c1').flush(
      {
        errors: [
          {
            status: '409',
            title: 'Conflict',
            code: 'invalid-state',
            detail: '',
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(await renaming).toBeNull();
    expect(session.options()[0]?.title).toBe('T c1');
    const toasts = TestBed.inject(ToastService).toasts();
    expect(toasts).toHaveLength(1);
    // A refusal: trying again would only be refused again.
    expect(toasts[0]?.actionLabel).toBeFalsy();
  });

  it('offers a retry when the API could not answer, and tells the caller when it lands', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c1')));
    await refresh;
    const told: string[] = [];

    const renaming = session.rename(
      'c1',
      { title: 'Renamed', description: null },
      (done) => told.push(done.attributes.title),
    );
    http
      .expectOne('/api/change-sets/c1')
      .flush(null, { status: 503, statusText: 'Service Unavailable' });
    expect(await renaming).toBeNull();
    const toast = TestBed.inject(ToastService).toasts()[0];
    expect(toast?.actionLabel).toBeTruthy();

    toast?.onAction?.();
    const retried = http.expectOne('/api/change-sets/c1');
    retried.flush({ data: csItem('c1', 'a', 'Renamed') });
    await Promise.resolve();
    await Promise.resolve();
    expect(told).toEqual(['Renamed']);
    expect(session.options()[0]?.title).toBe('Renamed');
  });
});

describe('ChangeSetControlComponent rename', () => {
  it('offers Rename for the person’s own open change set only', async () => {
    const http = setup();
    const fixture = TestBed.createComponent(ChangeSetControlComponent);
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http
      .expectOne(isList)
      .flush(csPage(csItem('mine'), csItem('theirs', 'someone-else')));
    await refresh;
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    // The list's "Rename change set" entry, with the menu open.
    const rename = async () => {
      el.querySelector<HTMLElement>(
        '[data-testid=change-set-trigger]',
      )?.click();
      await fixture.whenStable();
      const found = document.querySelector('[data-testid=change-set-rename]');
      // A second click closes it again.
      el.querySelector<HTMLElement>(
        '[data-testid=change-set-trigger]',
      )?.click();
      await fixture.whenStable();
      return found;
    };
    await fixture.whenStable();
    expect(await rename()).toBeNull();

    session.choose('mine');
    await fixture.whenStable();
    expect(await rename()).toBeTruthy();

    session.choose('theirs');
    await fixture.whenStable();
    expect(await rename()).toBeNull();
    document.body.replaceChildren();
    await tick();
  });

  it('turns the menu into the rename form, the title field taking the focus', async () => {
    const http = setup();
    const fixture = TestBed.createComponent(ChangeSetControlComponent);
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('mine', 'a', 'Edits')));
    await refresh;
    session.choose('mine');
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await fixture.whenStable();
    el.querySelector<HTMLElement>('[data-testid=change-set-trigger]')?.click();
    await fixture.whenStable();
    await tick();
    // Opened, the search field has the focus.
    expect(document.activeElement?.closest('z-command-input')).not.toBeNull();
    document
      .querySelector('[data-testid=change-set-rename] [role=option]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    await tick();
    const field = document.activeElement as HTMLInputElement | null;
    expect(field?.tagName).toBe('INPUT');
    expect(field?.value).toBe('Edits');
    document.body.replaceChildren();
    await tick();
  });
});
