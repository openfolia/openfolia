import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { ApiClient, pageQuery } from './api-client';
import { ReadRef } from './read-ref';
import { API_DEMO_USER } from './api-config';
import { ApiError } from './api-error';
import type { Item, Response } from './api-types';
import { provideApi } from './provide-api';

const setup = (user?: string | null) => {
  TestBed.configureTestingModule({
    providers: [
      provideApi(),
      provideHttpClientTesting(),
      ...(user === undefined
        ? []
        : [{ provide: API_DEMO_USER, useValue: signal(user) }]),
    ],
  });
  return {
    api: TestBed.inject(ApiClient),
    http: TestBed.inject(HttpTestingController),
  };
};

describe('ApiClient', () => {
  it('reads a paged route with ref and page parameters', async () => {
    const { api, http } = setup();
    const result = firstValueFrom(
      api.get('/modules', {
        query: { ref: 'draft', ...pageQuery({ number: 2, size: 10 }) },
      }),
    );
    const req = http.expectOne(
      (r) => r.url === '/api/modules' && r.params.get('ref') === 'draft',
    );
    expect(req.request.params.get('page[number]')).toBe('2');
    expect(req.request.params.get('page[size]')).toBe('10');
    expect(req.request.headers.get('Accept')).toBe('application/vnd.api+json');
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(req.request.headers.has('X-Ccms-User')).toBe(false);
    req.flush({ data: [], meta: {}, links: {} });
    expect((await result).data).toEqual([]);
  });

  it('repeats a parameter given as a list', () => {
    const { api, http } = setup();
    void firstValueFrom(
      api.get('/module-summaries', {
        query: { 'filter[keyword]': ['a b', 'c'] },
      }),
    );
    const req = http.expectOne((r) => r.url === '/api/module-summaries');
    expect(req.request.params.getAll('filter[keyword]')).toEqual(['a b', 'c']);
    expect(req.request.urlWithParams).toContain(
      'filter%5Bkeyword%5D=a%20b&filter%5Bkeyword%5D=c',
    );
    req.flush({ data: [], meta: {}, links: {} });
  });

  it('posts and puts JSON:API documents to routes with path parameters', async () => {
    const { api, http } = setup();
    const subject = { type: 'module' as const, lang: 'en', moduleId: 'a' };
    api
      .post(
        '/change-sets/{changeSetId}/locks',
        { data: { type: 'Lock', attributes: { subject } } },
        { path: { changeSetId: 'c 1' } },
      )
      .subscribe();
    const post = http.expectOne('/api/change-sets/c%201/locks');
    expect(post.request.method).toBe('POST');
    expect(post.request.headers.get('Content-Type')).toBe(
      'application/vnd.api+json',
    );
    post.flush({ data: {} });
    api
      .put(
        '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
        { path: { changeSetId: 'c', lang: 'en', moduleId: 'a' } },
        {
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                id: 'a',
                meta: { title: 'A', type: 'concept', lang: 'en', facets: {} },
                blocks: [],
              },
            },
          },
          meta: { version: 0, baseCommit: 'b' },
        },
      )
      .subscribe();
    const put = http.expectOne('/api/change-sets/c/modules/en/a/working-copy');
    expect(put.request.method).toBe('PUT');
    // A request that must follow it waits for it.
    let settled = false;
    void api.putsSettled().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve));
    expect(settled).toBe(false);
    put.flush({ data: {} });
    await new Promise((resolve) => setTimeout(resolve));
    expect(settled).toBe(true);
  });

  it('says JSON:API on every state-changing call, with or without a body', () => {
    const { api, http } = setup();
    api
      .act('/change-sets/{changeSetId}/submit', {
        path: { changeSetId: 'c' },
      })
      .subscribe();
    const act = http.expectOne('/api/change-sets/c/submit');
    expect(act.request.headers.get('Content-Type')).toBe(
      'application/vnd.api+json',
    );
    act.flush({ data: {} });
    api.delete('/locks/{lockId}', { path: { lockId: 'l' } }).subscribe();
    const del = http.expectOne('/api/locks/l');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.body).toBeNull();
    expect(del.request.headers.get('Content-Type')).toBe(
      'application/vnd.api+json',
    );
    del.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('adds the headers to calls made past ApiClient too: JSON:API, or X-Ccms-Request on an upload', () => {
    const { http } = setup();
    const client = TestBed.inject(HttpClient);
    client.post('/api/locks/break', null).subscribe();
    const bare = http.expectOne('/api/locks/break');
    expect(bare.request.headers.get('Content-Type')).toBe(
      'application/vnd.api+json',
    );
    expect(bare.request.headers.has('X-Ccms-Request')).toBe(false);
    bare.flush({});
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.png');
    client.post('/api/change-sets/c/assets', form).subscribe();
    const upload = http.expectOne('/api/change-sets/c/assets');
    expect(upload.request.headers.get('X-Ccms-Request')).toBe('1');
    // The browser sets multipart/form-data with its boundary.
    expect(upload.request.headers.has('Content-Type')).toBe(false);
    upload.flush({});
    client.get('/api/refs').subscribe();
    const read = http.expectOne('/api/refs');
    expect(read.request.headers.has('Content-Type')).toBe(false);
    read.flush({});
    client.post('/elsewhere', null).subscribe();
    const other = http.expectOne('/elsewhere');
    expect(other.request.headers.has('Content-Type')).toBe(false);
    other.flush({});
  });

  it('uploads a file as a form with its one part, and reads an image at the chosen branch', () => {
    const { api, http } = setup('sample-author');
    TestBed.inject(ReadRef).ref.set('change-sets/c1');
    const file = new Blob(['png'], { type: 'image/png' });
    let answer: unknown = null;
    api
      .upload(
        '/change-sets/{changeSetId}/assets',
        { path: { changeSetId: 'c 1' } },
        file,
      )
      .subscribe((doc) => (answer = doc));
    const upload = http.expectOne('/api/change-sets/c%201/assets');
    const body = upload.request.body as FormData;
    expect([...body.keys()]).toEqual(['file']);
    expect(upload.request.headers.get('X-Ccms-Request')).toBe('1');
    expect(upload.request.headers.get('X-Ccms-User')).toBe('sample-author');
    upload.flush({ data: { id: 'x' } });
    expect(answer).toEqual({ data: { id: 'x' } });

    // An attachment says so: `?kind=attachment`.
    api
      .upload(
        '/change-sets/{changeSetId}/assets',
        { path: { changeSetId: 'c1' }, kind: 'attachment' },
        new Blob(['zip']),
      )
      .subscribe();
    http
      .expectOne('/api/change-sets/c1/assets?kind=attachment')
      .flush({ data: { id: 'y' } });

    api.image('/assets/{hash}', { path: { hash: 'abc' } }).subscribe();
    const read = http.expectOne('/api/assets/abc?ref=change-sets/c1');
    expect(read.request.responseType).toBe('blob');
    expect(read.request.headers.get('X-Ccms-User')).toBe('sample-author');
    read.flush(new Blob(['x']));
    // The change set's preview takes no ref.
    api
      .image('/change-sets/{changeSetId}/assets/{hash}', {
        path: { changeSetId: 'c1', hash: 'abc' },
      })
      .subscribe();
    http.expectOne('/api/change-sets/c1/assets/abc').flush(new Blob(['x']));
  });

  it('encodes path parameters', () => {
    const { api, http } = setup();
    api
      .get('/modules/{lang}/{id}', { path: { lang: 'en', id: 'a b/c' } })
      .subscribe();
    http.expectOne('/api/modules/en/a%20b%2Fc').flush({ data: {} });
  });

  it('sends the demo identity header only while a user is set', () => {
    const { api, http } = setup('demo-editor');
    api.get('/refs').subscribe();
    const req = http.expectOne((r) => r.url === '/api/refs');
    expect(req.request.headers.get('X-Ccms-User')).toBe('demo-editor');
    req.flush({});
  });

  it('maps a JSON:API error document to an ApiError', async () => {
    const { api, http } = setup();
    const result = firstValueFrom(
      api.get('/modules', { query: { ref: 'nope' } }),
    ).catch((e: unknown) => e);
    http
      .expectOne((r) => r.url === '/api/modules')
      .flush(
        {
          errors: [
            {
              status: '503',
              title: 'Service Unavailable',
              detail: 'Busy.',
              code: 'renderer-busy',
              source: { parameter: 'ref' },
              meta: { retryAfter: 7 },
            },
          ],
        },
        { status: 503, statusText: 'Service Unavailable' },
      );
    const error = (await result) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: 'unavailable',
      status: 503,
      code: 'renderer-busy',
      message: 'Busy.',
      parameter: 'ref',
      retryAfter: 7,
    });
  });

  it('maps an unreadable error body and a missing answer', async () => {
    const { api, http } = setup();
    const a = firstValueFrom(api.get('/refs')).catch((e: unknown) => e);
    http
      .expectOne('/api/refs')
      .flush('<html>', { status: 401, statusText: 'Unauthorized' });
    expect(await a).toMatchObject({ kind: 'unauthorized', status: 401 });
    const b = firstValueFrom(api.get('/refs')).catch((e: unknown) => e);
    http.expectOne('/api/refs').error(new ProgressEvent('error'));
    expect(await b).toMatchObject({ kind: 'network', code: 'network' });
  });

  it('follows the chosen branch on routes that read content, unless the call names a ref', () => {
    const { api, http } = setup();
    TestBed.inject(ReadRef).ref.set('change-sets/abc');
    api.get('/modules').subscribe();
    expect(
      http.expectOne((r) => r.url === '/api/modules').request.params.get('ref'),
    ).toBe('change-sets/abc');
    api.get('/modules', { query: { ref: 'main' } }).subscribe();
    expect(
      http.expectOne((r) => r.url === '/api/modules').request.params.get('ref'),
    ).toBe('main');
    // A route that takes no `ref` never gets one (the API answers 400).
    api.get('/me').subscribe();
    expect(http.expectOne('/api/me').request.params.has('ref')).toBe(false);
  });
});

// Compile-time contract: these lines fail `typecheck` when the generated types change shape.
export const contract = (r: Response<'/manuals'>) => {
  const manual: Item<'/manuals'> | undefined = r.data[0];
  return [r.meta.page.currentPage, r.links.next, manual?.type];
};
