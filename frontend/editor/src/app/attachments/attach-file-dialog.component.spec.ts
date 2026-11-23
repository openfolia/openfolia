import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import type { AttachmentChoice } from '../doc-editor/blocks/doc-blocks-context';
import { AttachFileDialogComponent } from './attach-file-dialog.component';
import { advance, settled } from '../testing/fake-time';

const SETTINGS = 'a'.repeat(64);
const FRESH = 'f'.repeat(64);

const asset = (
  hash: string,
  fileName: string,
  contentType: string,
  used = 0,
) => ({
  type: 'Asset',
  id: hash,
  attributes: {
    reference: `sha256:${hash}`,
    contentType,
    size: 48_213,
    fileName,
  },
  meta: {
    usedIn: [],
    usedInCount: used,
    languages: [],
    uploaded: false,
    missing: false,
  },
});

const page = (data: unknown[], currentPage = 1, lastPage = 1) => ({
  data,
  meta: { page: { currentPage, lastPage, perPage: 10, total: data.length } },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

@Component({
  imports: [AttachFileDialogComponent],
  template: `<of-attach-file-dialog changeSetId="cs1" lang="en" />`,
})
class Host {
  readonly dialog = viewChild.required(AttachFileDialogComponent);
}

/** Runs the timers due now on the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

async function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideZard()],
  });
  const created = vi.spyOn(URL, 'createObjectURL');
  // Fake time: the search's debounce is waited out on the fake clock, which runs every timer
  // due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Host);
  await advance();
  const http = TestBed.inject(HttpTestingController);
  const stable = async () => {
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  const list = () => {
    const request = http
      .match((r) => r.url === '/api/assets')
      .find((r) => !r.cancelled);
    if (!request) throw new Error('no list request');
    return request;
  };
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
  const rows = () => [
    ...panel().querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ];
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
  const pick = (file: File) => {
    const el = panel().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(el, 'files', { value: [file], configurable: true });
    el.dispatchEvent(new Event('change'));
  };
  return {
    dialog: fixture.componentInstance.dialog(),
    http,
    stable,
    list,
    panel,
    button,
    input,
    type,
    rows,
    closed,
    pick,
    created,
  };
}

describe('the attach-file dialog', () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('lists the change set’s attachments, searches them, and inserts the chosen one with its name', async () => {
    const t = await setup();
    const answer = t.dialog.open(null);
    await t.stable();
    const first = t.list();
    expect(first.request.params.get('filter[type]')).toBe('attachment');
    expect(first.request.params.get('filter[changeSet]')).toBe('cs1');
    expect(first.request.params.get('page[size]')).toBe('10');
    expect(first.request.params.has('filter[q]')).toBe(false);
    first.flush(
      page([
        asset(SETTINGS, 'sample_settings.zip', 'application/zip', 2),
        asset(FRESH, 'sample.json', 'application/json'),
      ]),
    );
    await t.stable();
    expect(t.panel().textContent).toContain('Attach file');
    const [zip, json] = t.rows();
    expect(zip!.textContent).toContain('sample_settings.zip');
    expect(zip!.textContent).toContain('ZIP · 48.2 kB · Used in 2 modules');
    expect(json!.textContent).toContain('JSON');
    // Nothing chosen: Insert is disabled, and the footer says why.
    expect(t.button('Insert').disabled).toBe(true);
    expect(t.panel().textContent).toContain('Choose a file, or upload one.');

    // Files are only named, never opened or shown.
    expect(t.panel().querySelector('img, iframe, object, embed')).toBeNull();

    t.type(t.panel().querySelector('input[type="search"]')!, 'settings');
    await vi.advanceTimersByTimeAsync(300);
    await t.stable();
    const searched = t.list();
    expect(searched.request.params.get('filter[q]')).toBe('settings');
    searched.flush(
      page([asset(SETTINGS, 'sample_settings.zip', 'application/zip', 2)]),
    );
    await t.stable();

    t.rows()[0]!.click();
    await t.stable();
    expect(t.rows()[0]!.getAttribute('aria-checked')).toBe('true');
    // The name starts from the file name.
    expect(t.input('attachment-name').value).toBe('sample settings');
    t.type(t.input('attachment-description'), '  Import  them. ');
    t.button('Insert').click();
    expect(await t.closed(answer)).toEqual({
      asset: `sha256:${SETTINGS}`,
      name: 'sample settings',
      description: 'Import them.',
      fileName: 'sample_settings.zip',
      mediaType: 'application/zip',
      size: 48_213,
    });
    expect(t.created).not.toHaveBeenCalled();
  });

  it('requires a name', async () => {
    const t = await setup();
    let answer: AttachmentChoice | null | undefined;
    void t.dialog.open(null).then((a) => (answer = a));
    await t.stable();
    t.list().flush(page([asset(SETTINGS, 'x.zip', 'application/zip')]));
    await t.stable();
    t.rows()[0]!.click();
    await t.stable();
    t.type(t.input('attachment-name'), '   ');
    t.button('Insert').click();
    await t.stable();
    expect(answer).toBeUndefined();
    expect(t.panel().textContent).toContain('A name is required');
    expect(t.input('attachment-name').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('edits the current attachment, keeping its name, and cancels with nothing', async () => {
    const t = await setup();
    const current: AttachmentChoice = {
      asset: `sha256:${SETTINGS}`,
      name: 'Sample settings',
      description: 'Import them.',
      fileName: 'sample_settings.zip',
      mediaType: 'application/zip',
      size: 48_213,
    };
    const applied = t.dialog.open(current);
    await t.stable();
    t.list().flush(
      page([
        asset(SETTINGS, 'sample_settings.zip', 'application/zip'),
        asset(FRESH, 'other.json', 'application/json'),
      ]),
    );
    await t.stable();
    expect(t.panel().textContent).toContain('Edit attachment');
    expect(t.rows()[0]!.getAttribute('aria-checked')).toBe('true');
    expect(t.input('attachment-name').value).toBe('Sample settings');
    // Another file: the name stays the one it had.
    t.rows()[1]!.click();
    await t.stable();
    expect(t.input('attachment-name').value).toBe('Sample settings');
    t.button('Apply').click();
    expect(await t.closed(applied)).toMatchObject({
      asset: `sha256:${FRESH}`,
      name: 'Sample settings',
      fileName: 'other.json',
      mediaType: 'application/json',
    });

    const cancelled = t.dialog.open(current);
    await t.stable();
    t.button('Cancel').click();
    expect(await t.closed(cancelled)).toBeNull();
  });

  it('uploads a file of any type as an attachment, listed first and chosen at once', async () => {
    const t = await setup();
    const answer = t.dialog.open(null);
    await t.stable();
    t.list().flush(page([]));
    await t.stable();
    expect(
      t.panel().querySelector('input[type="file"]')!.getAttribute('accept'),
    ).toBeNull();
    t.pick(new File(['{"a":1}'], 'sample-data.json'));
    await t.stable();
    expect(t.rows()[0]!.textContent).toContain('Uploading');
    expect(t.button('Insert').disabled).toBe(true);
    const upload = t.http.expectOne(
      (r) => r.url === '/api/change-sets/cs1/assets',
    );
    expect(upload.request.params.get('kind')).toBe('attachment');
    upload.flush({
      data: asset(FRESH, 'sample-data.json', 'application/json'),
    });
    await t.stable();
    expect(t.rows()[0]!.getAttribute('aria-checked')).toBe('true');
    expect(t.input('attachment-name').value).toBe('sample data');
    t.button('Insert').click();
    expect(await t.closed(answer)).toMatchObject({
      asset: `sha256:${FRESH}`,
      name: 'sample data',
      fileName: 'sample-data.json',
      mediaType: 'application/json',
    });
  });

  it('counts an upload in the list’s total, and its size in bytes (#690)', async () => {
    const t = await setup();
    void t.dialog.open(null);
    await t.stable();
    t.list().flush(page([]));
    await t.stable();
    const pagination = () =>
      t
        .panel()
        .querySelector('[data-slot="list-pagination"]')
        ?.textContent?.replace(/\s+/g, ' ') ?? '';
    t.pick(new File(['x'.repeat(68)], 'notes.txt'));
    await t.stable();
    // On its way: its row is in the list, and in its total.
    expect(t.rows()).toHaveLength(1);
    expect(pagination()).toContain('(1 in total)');
    t.http
      .expectOne((r) => r.url === '/api/change-sets/cs1/assets')
      .flush({
        data: {
          ...asset(FRESH, 'notes.txt', 'text/plain'),
          attributes: {
            reference: `sha256:${FRESH}`,
            contentType: 'text/plain',
            size: 68,
            fileName: 'notes.txt',
          },
        },
      });
    await t.stable();
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]!.textContent).toContain('68 bytes');
    expect(pagination()).toContain('(1 in total)');
    // Read again: the API lists the upload now, and counts it.
    const fresh = asset(FRESH, 'notes.txt', 'text/plain');
    t.list().flush({
      ...page([
        {
          ...fresh,
          attributes: { ...fresh.attributes, size: 68 },
          meta: { ...fresh.meta, uploaded: true },
        },
      ]),
    });
    await t.stable();
    expect(t.rows()).toHaveLength(1);
    expect(pagination()).toContain('(1 in total)');
  });

  it('takes a refused upload back with a toast that says why and offers Retry', async () => {
    const t = await setup();
    const toasts: unknown[] = [];
    vi.spyOn(TestBed.inject(ToastService), 'error').mockImplementation(
      (text, options) => {
        toasts.push([text, options?.actionLabel]);
        return undefined as never;
      },
    );
    void t.dialog.open(null);
    await t.stable();
    t.list().flush(page([]));
    await t.stable();
    t.pick(new File(['MZ'], 'setup.exe'));
    await t.stable();
    t.http
      .expectOne((r) => r.url === '/api/change-sets/cs1/assets')
      .flush(
        {
          errors: [
            {
              status: '422',
              title: 'Unsupported attachment type',
              detail: 'refused',
              code: 'unsupported-attachment-type',
              meta: { reason: 'dangerous' },
            },
          ],
        },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    await t.stable();
    expect(t.rows()).toHaveLength(0);
    expect(toasts).toEqual([
      [
        {
          key: 'editor.apiErrors.codes.unsupported-attachment-type',
          params: expect.objectContaining({ reason: 'dangerous' }),
        },
        { key: 'editor.attachments.retry' },
      ],
    ]);
  });

  it('reads the list again when opened while open, and answers the earlier call with nothing', async () => {
    const t = await setup();
    let first: AttachmentChoice | null | undefined;
    void t.dialog.open(null).then((a) => (first = a));
    await t.stable();
    const stale = t.list();
    void t.dialog.open(null);
    await t.stable();
    expect(first).toBeNull();
    const fresh = t.http
      .match((r) => r.url === '/api/assets')
      .filter((r) => !r.cancelled && r !== stale);
    expect(fresh).toHaveLength(1);
    fresh[0]!.flush(page([asset(SETTINGS, 'x.zip', 'application/zip')]));
    await t.stable();
    expect(t.rows()).toHaveLength(1);
  });
});
