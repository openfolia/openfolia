import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { ImageSources } from './image-sources';
import { InsertImageDialogComponent } from './insert-image-dialog.component';
import { advance, settled } from '../testing/fake-time';

const PUMP = 'a'.repeat(64);
const FRESH = 'f'.repeat(64);

const asset = (hash: string, title: string, uploaded = false) => ({
  type: 'Asset',
  id: hash,
  attributes: {
    reference: `sha256:${hash}`,
    contentType: 'image/png',
    size: 2048,
    width: 640,
    height: 400,
  },
  meta: {
    usedIn: title ? [{ moduleId: 'pump', lang: 'en', title }] : [],
    usedInCount: title ? 1 : 0,
    languages: [],
    uploaded,
    missing: false,
  },
});

const page = (data: unknown[], currentPage = 1, lastPage = 1) => ({
  data,
  meta: { page: { currentPage, lastPage, perPage: 12, total: data.length } },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

@Component({
  imports: [InsertImageDialogComponent],
  providers: [ImageSources],
  template: `<of-insert-image-dialog changeSetId="cs1" lang="en" />`,
})
class Host {
  readonly dialog = viewChild.required(InsertImageDialogComponent);
}

/** Runs the timers due now on the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

async function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideZard()],
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:local');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  // Fake time: the search's debounce is waited out on the fake clock, which runs every timer
  // due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Host);
  await advance();
  const http = TestBed.inject(HttpTestingController);
  // Not `whenStable`: the thumbnails' reads are pending tasks until answered (`images`).
  const stable = async () => {
    await flush();
    fixture.detectChanges();
    await flush();
    images();
    fixture.detectChanges();
  };
  /** The list request, answered; thumbnails' image reads are answered with nothing. */
  const list = (match: (r: TestRequest) => boolean = () => true) => {
    const found = http
      .match((r) => r.url === '/api/assets')
      .filter((r) => !r.cancelled);
    const request = found.find(match);
    if (!request) throw new Error('no list request');
    return request;
  };
  const images = () =>
    http
      .match((r) => r.url.startsWith('/api/assets/'))
      .forEach((r) => r.flush(null, { status: 404, statusText: 'Not Found' }));
  const panel = () => document.querySelector<HTMLElement>('z-dialog-panel')!;
  const button = (text: string) =>
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const input = (id: string) =>
    panel().querySelector<HTMLInputElement>(`#${id}`)!;
  const type = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input'));
  };
  /**
   * The dialog's answer to `open()`, once it has closed: it answers only after its leave
   * transition (a timer started by the change detection after the click). Waits for the answer
   * itself, not for a fixed time, which a loaded machine can overrun (#355).
   */
  const closed = async <T>(answer: Promise<T>): Promise<T> => {
    const value = await settled(answer);
    await stable();
    return value;
  };
  return {
    fixture,
    dialog: fixture.componentInstance.dialog(),
    http,
    stable,
    list,
    images,
    panel,
    button,
    input,
    type,
    closed,
  };
}

describe('the insert-image dialog', () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('lists the change set’s images, searches them, and inserts the chosen one with its alt text', async () => {
    const t = await setup();
    const answer = t.dialog.open(null);
    let answered = false;
    void answer.then(() => (answered = true));
    await t.stable();
    const first = t.list();
    expect(first.request.params.get('filter[changeSet]')).toBe('cs1');
    expect(first.request.params.get('filter[type]')).toBe('image');
    expect(first.request.params.get('page[size]')).toBe('12');
    expect(first.request.params.has('filter[q]')).toBe(false);
    first.flush(page([asset(PUMP, 'Pump')]));
    await t.stable();
    t.images();
    expect(t.panel().textContent).toContain('Insert image');
    const tile = t.panel().querySelector<HTMLButtonElement>('[role="radio"]')!;
    expect(tile.textContent).toContain('Pump');
    // Nothing chosen yet: Insert is disabled, and the footer says why.
    expect(t.button('Insert').disabled).toBe(true);
    expect(t.panel().textContent).toContain('Choose an image, or upload one.');

    t.type(
      t.panel().querySelector<HTMLInputElement>('input[type="search"]')!,
      '  pump ',
    );
    await vi.advanceTimersByTimeAsync(300);
    await t.stable();
    const searched = t.list(
      (r) => r.request.params.get('filter[q]') === 'pump',
    );
    searched.flush(page([asset(PUMP, 'Pump')]));
    await t.stable();
    t.images();

    t.panel().querySelector<HTMLButtonElement>('[role="radio"]')!.click();
    await t.stable();
    expect(
      t.panel().querySelector('[role="radio"]')!.getAttribute('aria-checked'),
    ).toBe('true');
    expect(t.panel().textContent).toContain('PNG · 640 × 400 px');
    // Alt text is required.
    t.button('Insert').click();
    await t.stable();
    expect(t.panel().querySelector('#image-alt-error')).not.toBeNull();
    expect(t.input('image-alt').getAttribute('aria-invalid')).toBe('true');
    expect(answered).toBe(false);

    t.type(t.input('image-alt'), ' A pump ');
    t.type(t.input('image-caption'), 'The pump');
    t.panel()
      .querySelector<HTMLInputElement>('input[type="radio"][value="75"]')!
      .click();
    await t.stable();
    t.button('Insert').click();
    expect(await t.closed(answer)).toEqual({
      asset: `sha256:${PUMP}`,
      alt: 'A pump',
      caption: 'The pump',
      width: 75,
    });
  });

  it('opens on the block being edited, and answers null when cancelled', async () => {
    const t = await setup();
    const answer = t.dialog.open({
      asset: `sha256:${PUMP}`,
      alt: 'A pump',
      caption: 'Pump',
      width: 40,
    });
    await t.stable();
    t.list().flush(page([]));
    await t.stable();
    expect(t.panel().textContent).toContain('Edit image');
    expect(t.input('image-alt').value).toBe('A pump');
    expect(t.input('image-caption').value).toBe('Pump');
    expect(t.panel().textContent).toContain('40 % of the text width');
    expect(t.panel().textContent).toContain('No images yet');
    t.button('Cancel').click();
    expect(await t.closed(answer)).toBeNull();
  });

  it('starts uploading a file it is opened with (dropped or pasted into the document), chosen', async () => {
    const t = await setup();
    const file = new File(['png'], 'dropped.png', { type: 'image/png' });
    void t.dialog.open(null, file);
    await t.stable();
    t.list().flush(page([asset(PUMP, 'Pump')]));
    await t.stable();
    const tiles = [
      ...t.panel().querySelectorAll<HTMLElement>('[role="radio"]'),
    ];
    expect(tiles[0]?.textContent).toContain('Uploading');
    expect(tiles[0]?.getAttribute('aria-checked')).toBe('true');
    const upload = t.http.expectOne('/api/change-sets/cs1/assets');
    expect((upload.request.body as FormData).get('file')).toBe(file);
  });

  it('counts an upload in the list’s total (#690)', async () => {
    const t = await setup();
    void t.dialog.open(null);
    await t.stable();
    t.list().flush(page([asset(PUMP, 'Pump')]));
    await t.stable();
    const pagination = () =>
      t
        .panel()
        .querySelector('[data-slot="list-pagination"]')
        ?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(pagination()).toContain('(1 in total)');
    const fileInput = t
      .panel()
      .querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, 'files', {
      value: [new File(['png'], 'photo.png', { type: 'image/png' })],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    await t.stable();
    expect(pagination()).toContain('(2 in total)');
    t.http.expectOne('/api/change-sets/cs1/assets').flush({
      data: {
        type: 'ChangeSetAsset',
        id: `cs1/${FRESH}`,
        attributes: {
          reference: `sha256:${FRESH}`,
          contentType: 'image/png',
          size: 3,
          uploadedBy: { kind: 'user', id: 'u' },
          uploadedAt: '2026-11-18T10:00:00Z',
        },
        relationships: {},
      },
    });
    await t.stable();
    expect(pagination()).toContain('(2 in total)');
    // Read again: the API lists and counts the upload itself now.
    t.list().flush(page([asset(FRESH, '', true), asset(PUMP, 'Pump')]));
    await t.stable();
    expect(
      t.panel().querySelectorAll<HTMLElement>('[role="radio"]'),
    ).toHaveLength(2);
    expect(pagination()).toContain('(2 in total)');
  });

  it('shows an upload at once and chosen, and takes it back with a Retry toast when refused', async () => {
    const t = await setup();
    const answer = t.dialog.open(null);
    await t.stable();
    t.list().flush(page([asset(PUMP, 'Pump')]));
    await t.stable();
    t.images();
    const fileInput = t
      .panel()
      .querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = (chosen: File) => {
      Object.defineProperty(fileInput, 'files', {
        value: [chosen],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event('change'));
    };
    // `accept` is only a hint: an SVG is refused before it is shown or sent.
    choose(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    await t.stable();
    t.http.expectNone('/api/change-sets/cs1/assets');
    expect(TestBed.inject(ToastService).toasts().at(-1)?.kind).toBe('error');
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    const file = new File(['png'], 'photo.png', { type: 'image/png' });
    choose(file);
    await t.stable();
    const tiles = () => [
      ...t.panel().querySelectorAll<HTMLElement>('[role="radio"]'),
    ];
    expect(tiles()[0]?.textContent).toContain('Uploading');
    expect(tiles()[0]?.getAttribute('aria-checked')).toBe('true');
    expect(t.panel().textContent).toContain('Waiting for the upload');
    const refused = t.http.expectOne('/api/change-sets/cs1/assets');
    expect((refused.request.body as FormData).get('file')).toBe(file);
    refused.flush(
      {
        errors: [
          {
            status: '422',
            title: 'x',
            detail: 'x',
            code: 'too-large',
            meta: { max: 10 },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await t.stable();
    expect(tiles()).toHaveLength(1);
    expect(tiles()[0]?.textContent).toContain('Pump');
    const toast = TestBed.inject(ToastService).toasts().at(-1)!;
    expect(toast.kind).toBe('error');
    toast.onAction?.();
    await t.stable();
    t.http.expectOne('/api/change-sets/cs1/assets').flush({
      data: {
        type: 'ChangeSetAsset',
        id: `cs1/${FRESH}`,
        attributes: {
          reference: `sha256:${FRESH}`,
          contentType: 'image/png',
          size: 3,
          uploadedBy: { kind: 'user', id: 'u' },
          uploadedAt: '2026-11-18T10:00:00Z',
        },
        relationships: {},
      },
    });
    await t.stable();
    expect(tiles()[0]?.textContent).toContain('Uploaded');
    expect(tiles()[0]?.getAttribute('aria-checked')).toBe('true');
    t.type(t.input('image-alt'), 'A photo');
    await t.stable();
    t.button('Insert').click();
    expect(await t.closed(answer)).toEqual({
      asset: `sha256:${FRESH}`,
      alt: 'A photo',
      caption: '',
      width: 50,
    });
  });
});
