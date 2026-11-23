import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ToastService } from '@openfolia/ui/toast';

import { MeService } from '../permissions/me';
import { MediaDeletion } from './media-deletion';

const HASH = 'c'.repeat(64);
const flush = () => new Promise((resolve) => setTimeout(resolve));

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  TestBed.inject(MeService).set({
    id: 'u1',
    kind: 'user',
    name: 'U',
    role: '',
    permissions: new Set(['content.edit']),
    editsEverything: true,
  });
  const deletion = TestBed.inject(MediaDeletion);
  const toast = TestBed.inject(ToastService);
  const http = TestBed.inject(HttpTestingController);
  const last = () => toast.toasts().at(-1)!;
  const text = (t: ReturnType<typeof last>) =>
    typeof t.message === 'string' ? t.message : t.message.key;
  return { deletion, toast, http, last, text };
}

describe('MediaDeletion', () => {
  it('hides the file at once and sends the delete only when the Undo toast ends', async () => {
    const { deletion, toast, http, last } = setup();
    deletion.delete(HASH, 'pump.png');
    expect(deletion.hidden().has(HASH)).toBe(true);
    http.expectNone(`/api/assets/${HASH}`);
    toast.dismiss(last().id);
    await flush();
    const request = http.expectOne(`/api/assets/${HASH}`);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('Content-Type')).toBe(
      'application/vnd.api+json',
    );
    request.flush(null, { status: 204, statusText: 'No Content' });
    await flush();
    // Still left out while a list read from before may name it; listed again once uploaded.
    expect(deletion.hidden().has(HASH)).toBe(true);
    expect(deletion.changed()).toBe(1);
    deletion.uploaded(HASH);
    expect(deletion.hidden().has(HASH)).toBe(false);
  });

  it('keeps the file on Undo and sends nothing', async () => {
    const { deletion, toast, http, last } = setup();
    deletion.delete(HASH, 'pump.png');
    toast.runAction(last().id);
    await flush();
    http.expectNone(`/api/assets/${HASH}`);
    expect(deletion.hidden().has(HASH)).toBe(false);
    expect(toast.toasts()).toHaveLength(0);
  });

  it('brings a file used meanwhile back, naming where it is used', async () => {
    const { deletion, toast, http, last, text } = setup();
    deletion.delete(HASH, 'pump.png');
    toast.dismiss(last().id);
    await flush();
    http.expectOne(`/api/assets/${HASH}`).flush(
      {
        errors: [
          {
            status: '409',
            title: 'Conflict',
            detail: 'In use.',
            code: 'asset-in-use',
            meta: { usedIn: [{ in: 'working-copy' }] },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await flush();
    expect(deletion.hidden().has(HASH)).toBe(false);
    const error = last();
    expect(error.kind).toBe('error');
    expect(text(error)).toBe('editor.media.delete.inUse');
    expect(
      typeof error.message === 'string' ? null : error.message.params,
    ).toMatchObject({ name: 'pump.png', places: 'unsaved work in a module' });
  });

  it('names a release’s archived PDF as the place that keeps a file (#429)', async () => {
    const { deletion, toast, http, last } = setup();
    deletion.delete(HASH, 'manual.pdf');
    toast.dismiss(last().id);
    await flush();
    http.expectOne(`/api/assets/${HASH}`).flush(
      {
        errors: [
          {
            status: '409',
            title: 'Conflict',
            detail: 'In use.',
            code: 'asset-in-use',
            meta: { usedIn: [{ in: 'release-output' }] },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await flush();
    const error = last();
    expect(
      typeof error.message === 'string' ? null : error.message.params,
    ).toMatchObject({ name: 'manual.pdf', places: 'a release’s archived PDF' });
  });

  it('sends nothing once someone else is acting', async () => {
    const { deletion, toast, http, last } = setup();
    deletion.delete(HASH, 'pump.png');
    TestBed.inject(MeService).set({
      id: 'u2',
      kind: 'user',
      name: 'V',
      role: '',
      permissions: new Set(),
    });
    toast.dismiss(last().id);
    await flush();
    http.expectNone(`/api/assets/${HASH}`);
    expect(deletion.hidden().has(HASH)).toBe(false);
  });
});
