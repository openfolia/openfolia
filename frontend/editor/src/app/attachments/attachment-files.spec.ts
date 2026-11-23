import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { AttachmentFiles, servedName } from './attachment-files';

const HASH = 'a'.repeat(64);

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      AttachmentFiles,
    ],
  });
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return 'blob:saved';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const clicks: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this);
  });
  return {
    files: TestBed.inject(AttachmentFiles),
    http: TestBed.inject(HttpTestingController),
    blobs,
    clicks,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('AttachmentFiles', () => {
  it('saves the bytes as a file under the name the API serves, typed so the browser never renders them', async () => {
    const t = setup();
    const saved = t.files.save(`sha256:${HASH}`, 'other.html', 'cs1');
    await flush();
    t.http
      .expectOne((r) => r.url === `/api/assets/${HASH}`)
      .flush(new Blob(['<script>x</script>'], { type: 'text/html' }), {
        headers: {
          'Content-Disposition': `attachment; filename="page.html"; filename*=UTF-8''page.html`,
        },
      });
    expect(await saved).toBe(true);
    expect(t.blobs).toHaveLength(1);
    expect(t.blobs[0]!.type).toBe('application/octet-stream');
    expect(t.clicks).toHaveLength(1);
    expect(t.clicks[0]!.download).toBe('page.html');
    expect(t.clicks[0]!.href).toBe('blob:saved');
    // The link is gone again.
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('never saves harmless bytes under a name of another kind the block gives', async () => {
    const t = setup();
    const saved = t.files.save(`sha256:${HASH}`, 'notes.vbs', null);
    await flush();
    t.http
      .expectOne((r) => r.url === `/api/assets/${HASH}`)
      // The API serves it under the hash: no block name fits text as `.vbs`.
      .flush(new Blob(['MsgBox 1'], { type: 'text/plain' }), {
        headers: {
          'Content-Disposition': `attachment; filename="${HASH}"; filename*=UTF-8''${HASH}`,
        },
      });
    expect(await saved).toBe(true);
    expect(t.clicks[0]!.download).toBe(HASH);
  });

  it('keeps a picture’s own name when the API shows it in place', async () => {
    const t = setup();
    const saved = t.files.save(`sha256:${HASH}`, 'Photo.PNG', null);
    await flush();
    t.http
      .expectOne((r) => r.url === `/api/assets/${HASH}`)
      .flush(new Blob(['png'], { type: 'image/png' }));
    expect(await saved).toBe(true);
    expect(t.clicks[0]!.download).toBe('Photo.PNG');
  });

  it('reads a fresh upload from the change set, and says when there is no file', async () => {
    const t = setup();
    const saved = t.files.save(`sha256:${HASH}`, 'data.json', 'cs1');
    await flush();
    t.http
      .expectOne((r) => r.url === `/api/assets/${HASH}`)
      .flush(null, { status: 404, statusText: 'Not Found' });
    await flush();
    t.http
      .expectOne((r) => r.url === `/api/change-sets/cs1/assets/${HASH}`)
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(await saved).toBe(false);
    expect(t.clicks).toHaveLength(0);
  });

  it('rejects when the file could not be read', async () => {
    const t = setup();
    const saved = t.files.save(`sha256:${HASH}`, 'data.json', null);
    await flush();
    t.http
      .expectOne((r) => r.url === `/api/assets/${HASH}`)
      .flush(null, { status: 500, statusText: 'Server Error' });
    await expect(saved).rejects.toBeTruthy();
  });
});

describe('servedName', () => {
  it('reads filename* first, then filename, and never keeps a path', () => {
    expect(
      servedName(`attachment; filename="_.zip"; filename*=UTF-8''%C3%A4.zip`),
    ).toBe('ä.zip');
    expect(servedName('attachment; filename="plain.zip"')).toBe('plain.zip');
    expect(servedName(`attachment; filename*=UTF-8''..%2Fevil.sh`)).toBe(
      '.._evil.sh',
    );
    expect(servedName(`attachment; filename*=UTF-8''%E0%A4`)).toBeNull();
    expect(servedName(null)).toBeNull();
  });
});
