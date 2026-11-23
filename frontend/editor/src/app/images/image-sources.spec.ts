import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { ReadRef } from '../api';
import { MeService } from '../permissions/me';
import { ImageSources } from './image-sources';

const HASH = 'c'.repeat(64);
const ASSET = `sha256:${HASH}`;

@Component({ template: '', providers: [ImageSources] })
class Page {
  readonly sources = inject(ImageSources);
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  TestBed.inject(ReadRef).ref.set('change-sets/cs1');
  const fixture = TestBed.createComponent(Page);
  const made: string[] = [];
  const revoked: string[] = [];
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:${made.length}`;
    made.push(url);
    return url;
  });
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation((url) => void revoked.push(url));
  onTestFinished(() => {
    create.mockRestore();
    revoke.mockRestore();
  });
  return {
    fixture,
    sources: fixture.componentInstance.sources,
    http: TestBed.inject(HttpTestingController),
    revoked,
  };
}

describe('ImageSources', () => {
  it('reads an image at the branch once, and falls back to the change set preview for a fresh upload', async () => {
    const { sources, http } = setup();
    const first = sources.source(ASSET, 'cs1');
    const again = sources.source(ASSET, 'cs1');
    await flush();
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1`)
      .flush(new Blob(['x']), { status: 404, statusText: 'Not Found' });
    await flush();
    http
      .expectOne(`/api/change-sets/cs1/assets/${HASH}`)
      .flush(new Blob(['png'], { type: 'image/png' }));
    expect(await first).toBe('blob:0');
    expect(await again).toBe('blob:0');
    http.verify();
  });

  it('reads a known fresh upload from the change set preview first, never asking at the ref for a 404 (#468)', async () => {
    const { sources, http } = setup();
    const shown = sources.source(ASSET, 'cs1', undefined, 320, {
      upload: true,
    });
    await flush();
    http
      .expectOne(`/api/change-sets/cs1/assets/${HASH}?width=320`)
      .flush(new Blob(['webp'], { type: 'image/webp' }));
    expect(await shown).toBe('blob:0');
    http.verify();

    // The list was older than the content: a module shows it now, the preview has none.
    const other = `sha256:${'e'.repeat(64)}`;
    const used = sources.source(other, 'cs1', undefined, undefined, {
      upload: true,
    });
    await flush();
    http
      .expectOne(`/api/change-sets/cs1/assets/${'e'.repeat(64)}`)
      .flush(null, { status: 404, statusText: 'Not Found' });
    await flush();
    http
      .expectOne(`/api/assets/${'e'.repeat(64)}?ref=change-sets/cs1`)
      .flush(new Blob(['png'], { type: 'image/png' }));
    expect(await used).toBe('blob:1');
    http.verify();
  });

  it('keeps a rendition pending while the API is busy making renditions, and asks again after Retry-After', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const { sources, http } = setup();
    let settled = false;
    const shown = sources.source(ASSET, null, undefined, 320);
    void shown.finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1&width=320`)
      .flush(null, {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Retry-After': '2' },
      });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    http.verify();
    await vi.advanceTimersByTimeAsync(1);
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1&width=320`)
      .flush(new Blob(['webp'], { type: 'image/webp' }));
    expect(await shown).toBe('blob:0');
  });

  it('gives up on a busy API after a few tries, and on a 503 without Retry-After at once', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const { sources, http } = setup();
    const busy = () => ({
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Retry-After': '60' },
    });
    const shown = sources.source(ASSET, null, undefined, 320);
    const failed = expect(shown).rejects.toBeTruthy();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(attempt === 0 ? 0 : 5000);
      http
        .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1&width=320`)
        .flush(null, busy());
    }
    await failed;

    const other = `sha256:${'f'.repeat(64)}`;
    const down = sources.source(other, null);
    const refused = expect(down).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(0);
    http
      .expectOne(`/api/assets/${'f'.repeat(64)}?ref=change-sets/cs1`)
      .flush(null, { status: 503, statusText: 'Service Unavailable' });
    await refused;
    http.verify();
  });

  it('is null for an image nobody shows the person, and asks again after a failure', async () => {
    const { sources, http } = setup();
    const missing = sources.source(ASSET, null);
    await flush();
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1`)
      .flush(null, { status: 403, statusText: 'Forbidden' });
    expect(await missing).toBeNull();
    expect(await sources.source('sha256:../x', null)).toBeNull();

    const other = `sha256:${'d'.repeat(64)}`;
    const failing = sources.source(other, null);
    await flush();
    http
      .expectOne(`/api/assets/${'d'.repeat(64)}?ref=change-sets/cs1`)
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await expect(failing).rejects.toBeTruthy();
    const retried = sources.source(other, null);
    await flush();
    http
      .expectOne(`/api/assets/${'d'.repeat(64)}?ref=change-sets/cs1`)
      .flush(new Blob(['x'], { type: 'image/jpeg' }));
    expect(await retried).toBe('blob:0');
  });

  it('never shows an SVG from an object URL: it would run as a page of the editor', async () => {
    const { sources, http } = setup();
    const svg = sources.source(ASSET, null);
    await flush();
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1`)
      .flush(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    expect(await svg).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(sources.objectUrl(new Blob(['<svg/>']))).toBeNull();
  });

  it('shows an upload from its own bytes, and lets go of every URL with the page', async () => {
    const { fixture, sources, http, revoked } = setup();
    sources.remember(ASSET, new Blob(['png']), 'image/png', 'cs1', '');
    expect(await sources.source(ASSET, 'cs1')).toBe('blob:0');
    http.verify();
    fixture.destroy();
    expect(revoked).toEqual(['blob:0']);
  });

  it('never hands an image read for one person to the next (#706)', async () => {
    const { sources, http } = setup();
    const person = (id: string) =>
      TestBed.inject(MeService).set({
        id,
        kind: 'user',
        name: id,
        role: '',
        permissions: new Set(),
      });
    person('u1');
    const first = sources.source(ASSET, null);
    await flush();
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1`)
      .flush(new Blob(['x'], { type: 'image/png' }));
    expect(await first).toBe('blob:0');

    // Another person may not see it: they are asked anew, and get nothing.
    person('u2');
    const next = sources.source(ASSET, null);
    await flush();
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1`)
      .flush(null, { status: 403, statusText: 'Forbidden' });
    expect(await next).toBeNull();
  });

  it('reads for the person acting now what was asked for the one before, and keeps it for them only (#706)', async () => {
    const { sources, http } = setup();
    const person = (id: string) =>
      TestBed.inject(MeService).set({
        id,
        kind: 'user',
        name: id,
        role: '',
        permissions: new Set(),
      });
    const at = (c: string) => `/api/assets/${c.repeat(64)}?ref=change-sets/cs1`;
    person('u1');
    // Every read slot taken, so the next read waits for its turn.
    const busy = ['1', '2', '3', '4'].map((c) =>
      sources.source(`sha256:${c.repeat(64)}`, null),
    );
    const queued = sources.source(ASSET, null);
    await flush();
    // The person changes: the four reads sent for u1 answer afterwards, and are not handed on.
    person('u2');
    for (const c of ['1', '2', '3', '4']) {
      http.expectOne(at(c)).flush(new Blob(['u1'], { type: 'image/png' }));
    }
    // Each is asked again for u2, and so is the one that waited: once each, in whatever order
    // their turns come.
    const asked: string[] = [];
    for (let round = 0; round < 4; round++) {
      await flush();
      for (const req of http.match(() => true)) {
        asked.push(req.request.urlWithParams);
        if (req.request.url.endsWith('c'.repeat(64))) {
          req.flush(new Blob(['u2'], { type: 'image/png' }));
        } else req.flush(null, { status: 403, statusText: 'Forbidden' });
      }
    }
    expect(asked.sort()).toEqual(['1', '2', '3', '4', 'c'].map(at).sort());
    expect(await Promise.all(busy)).toEqual([null, null, null, null]);
    expect(await queued).toBe('blob:0');

    // u1 again: nothing read for u2 is theirs.
    person('u1');
    const again = sources.source(ASSET, null);
    await flush();
    http
      .expectOne(at('c'))
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(await again).toBeNull();
    http.verify();
  });

  it('never shows the next person an upload the one before made (#716)', async () => {
    const { sources, http } = setup();
    const person = (id: string) =>
      TestBed.inject(MeService).set({
        id,
        kind: 'user',
        name: id,
        role: '',
        permissions: new Set(),
      });
    // u1 uploads; the upload answers after u2 acts: it is not kept for them.
    person('u2');
    sources.remember(ASSET, new Blob(['png']), 'image/png', 'cs1', 'u1');
    const shown = sources.source(ASSET, 'cs1');
    await flush();
    http
      .expectOne(`/api/assets/${HASH}?ref=change-sets/cs1`)
      .flush(null, { status: 403, statusText: 'Forbidden' });
    await flush();
    http
      .expectOne(`/api/change-sets/cs1/assets/${HASH}`)
      .flush(null, { status: 403, statusText: 'Forbidden' });
    expect(await shown).toBeNull();
  });
});
