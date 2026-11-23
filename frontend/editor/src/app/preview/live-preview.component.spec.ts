import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { ReadRef } from '../api';
import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { provideChangeSetUrl } from '../session/change-set-url';
import {
  LIVE_DEBOUNCE_MS,
  LivePreviewComponent,
} from './live-preview.component';
import { advance } from '../testing/fake-time';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;

const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 100, total: data.length },
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const manuals = page([
  {
    type: 'Manual',
    id: 'operating',
    attributes: {
      schemaVersion: 1,
      title: 'Operating manual',
      variants: [{ model: 'small' }, { model: 'large' }],
      textAttributes: {},
      entries: [{ module: 'charging' }],
    },
    meta: {
      variants: [
        { slug: 'model=small', label: 'Small', values: { model: 'small' } },
        { slug: 'model=large', label: 'Large', values: { model: 'large' } },
      ],
      issues: [],
    },
  },
]);

const hidden = {
  ...page([]),
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 25, total: 0 },
    commit: 'c1',
  },
};

const html = (text: string) =>
  `<!doctype html><html lang="en"><head><title>Charging</title></head>
<body><article class="of-content of-module"><h1>Charging</h1><p id="of-intro">${text}</p></article></body></html>`;

@Component({
  imports: [LivePreviewComponent],
  template: `
    <of-live-preview
      style="height: 600px"
      moduleId="charging"
      title="Charging"
      editorLang="en"
      [languages]="['en', 'de']"
      [variant]="variant()"
      [live]="live()"
      [unsaved]="unsaved()"
      [revision]="revision()"
      (variantChange)="variant.set($event)"
      (blockClick)="clicked.push($event)"
    />
  `,
})
class Host {
  readonly variant = signal<string | undefined>(undefined);
  readonly live = signal(true);
  readonly unsaved = signal(true);
  readonly revision = signal<unknown>('r1');
  readonly clicked: string[] = [];
}

interface Frame {
  readonly frame: HTMLElement;
  readonly iframe: HTMLIFrameElement;
  readonly shown: boolean;
}

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideChangeSetUrl(),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(ReadRef).ref.set(BRANCH);
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
  });
  // Fake time: the autosave's debounce is waited out on the fake clock. The fake clock runs every
  // timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await advance();
    }
  };
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  /** The frames in the order they are in the page, and which one is in view. */
  const frames = (): Frame[] =>
    [...el.querySelectorAll('of-preview-frame')].map((frame) => ({
      frame: frame as HTMLElement,
      iframe: frame.querySelector('iframe') as HTMLIFrameElement,
      shown: !frame.classList.contains('opacity-0'),
    }));
  /** Lets a frame's document load (as the browser would after `srcdoc` was set). */
  const loaded = async (iframe: HTMLIFrameElement) => {
    iframe.dispatchEvent(new Event('load'));
    await settle();
  };
  return { fixture, http, settle, el, frames, loaded };
}

const previewReq = (http: HttpTestingController): TestRequest =>
  http.expectOne((r) => r.url.endsWith('/api/modules/en/charging/preview'));
const hiddenReq = (http: HttpTestingController): TestRequest =>
  http.expectOne((r) =>
    r.url.endsWith('/api/modules/en/charging/hidden-content'),
  );

describe('LivePreviewComponent', () => {
  it('renders the working copy for the first variant, and again after an autosave, without a flash', async () => {
    const { fixture, http, settle, el, frames, loaded } = await render();
    http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
    await settle();
    await vi.advanceTimersByTimeAsync(0);

    const first = previewReq(http);
    expect(first.request.params.get('ref')).toBe(BRANCH);
    expect(first.request.params.get('workingCopy')).toBe('true');
    expect(first.request.params.get('variant')).toBe('model=small');
    const firstHidden = hiddenReq(http);
    expect(firstHidden.request.params.get('workingCopy')).toBe('true');
    expect(firstHidden.request.params.get('variant')).toBe('model=small');
    firstHidden.flush(hidden);
    first.flush(html('It charges.'));
    await settle();
    expect(el.textContent).toContain('with unsaved changes');
    expect(el.textContent).toContain('Draft preview, with unsaved changes.');
    // A working copy with nothing a save point lacks: read the same, named a draft (#694).
    fixture.componentInstance.unsaved.set(false);
    await settle();
    expect(el.textContent).not.toContain('with unsaved changes');
    fixture.componentInstance.unsaved.set(true);
    await settle();
    http.expectNone((r) => r.url.endsWith('/preview'));
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.iframe.srcdoc).toContain('It charges.');
    // Shown only once its document has loaded.
    expect(frames()[0]!.shown).toBe(false);
    await loaded(frames()[0]!.iframe);
    expect(frames()[0]!.shown).toBe(true);

    // An autosave landed: after a moment, the page is read again.
    fixture.componentInstance.revision.set('r2');
    await settle();
    http.expectNone((r) => r.url.endsWith('/preview'));
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS + 20);
    await settle();
    hiddenReq(http).flush(hidden);
    previewReq(http).flush(html('It charges fast.'));
    await settle();
    // The new page loads in the other frame while the old one stays in view, dimmed.
    expect(frames()).toHaveLength(2);
    const [a, b] = frames() as [Frame, Frame];
    expect(a.shown).toBe(true);
    expect(a.frame.classList.contains('opacity-60')).toBe(true);
    expect(a.frame.getAttribute('aria-busy')).toBe('true');
    expect(b.shown).toBe(false);
    expect(b.iframe.srcdoc).toContain('It charges fast.');
    expect(b.frame.hasAttribute('inert')).toBe(true);
    await loaded(b.iframe);
    expect(frames()[0]!.shown).toBe(false);
    expect(frames()[1]!.shown).toBe(true);
    expect(frames()[1]!.frame.hasAttribute('inert')).toBe(false);
    http.verify();
  });

  it('renders again at once, and reads the manuals again keeping their variants, when the branch gets a new head (#491)', async () => {
    const { http, settle, el, frames, loaded } = await render();
    http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    hiddenReq(http).flush(hidden);
    previewReq(http).flush(html('It charges.'));
    await settle();
    await loaded(frames()[0]!.iframe);

    // An update from main moved the branch: no autosave pause, the new head is read now.
    TestBed.inject(ReadRef).moved(BRANCH);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    const manualsAgain = http.expectOne((r) => r.url === '/api/manuals');
    const again = previewReq(http);
    expect(again.request.params.get('ref')).toBe(BRANCH);
    // The variants stay chosen meanwhile.
    expect(again.request.params.get('variant')).toBe('model=small');
    hiddenReq(http).flush(hidden);
    again.flush(html('It charges at the new head.'));
    manualsAgain.flush(manuals);
    await settle();
    const fresh = frames().find((f) => f.iframe.srcdoc.includes('new head'));
    expect(fresh).toBeTruthy();
    await loaded(fresh!.iframe);
    expect(el.textContent).not.toContain('could not');
    // Another branch's move reads nothing.
    TestBed.inject(ReadRef).moved('change-sets/other');
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    http.verify();
  });

  it('keeps the page in view, not dimmed, when an autosave renders the same page', async () => {
    const { fixture, http, settle, el, frames, loaded } = await render();
    http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    hiddenReq(http).flush(hidden);
    previewReq(http).flush(html('It charges.'));
    await settle();
    await loaded(frames()[0]!.iframe);
    for (const revision of ['r2', 'r3']) {
      fixture.componentInstance.revision.set(revision);
      await settle();
      await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS + 20);
      await settle();
      hiddenReq(http).flush(hidden);
      previewReq(http).flush(html('It charges.'));
      await settle();
    }
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.shown).toBe(true);
    expect(frames()[0]!.frame.getAttribute('aria-busy')).toBeNull();
    expect(el.querySelector('.opacity-60')).toBeNull();
  });

  it('reads the branch as committed when not live, and a chosen variant at once', async () => {
    const { fixture, http, settle } = await render();
    fixture.componentInstance.live.set(false);
    http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    const first = previewReq(http);
    expect(first.request.params.has('workingCopy')).toBe(false);
    expect(first.request.params.get('ref')).toBe(BRANCH);
    expect(hiddenReq(http).request.params.has('workingCopy')).toBe(false);

    fixture.componentInstance.variant.set('model=large');
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    const next = previewReq(http);
    expect(next.request.params.get('variant')).toBe('model=large');
    hiddenReq(http);
  });

  it('says when the person may not read it, and offers no frame', async () => {
    const { http, settle, el, frames } = await render();
    http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    hiddenReq(http).flush(hidden);
    previewReq(http).flush(
      { errors: [{ status: '403', code: 'forbidden', title: 'Forbidden' }] },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    expect(el.textContent).toContain('You may not read this content.');
    expect(frames()).toHaveLength(0);
  });
});
