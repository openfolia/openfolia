import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { MeService } from '../permissions/me';
import { ReviewContext } from './review-context';

const flush = () => new Promise((resolve) => setTimeout(resolve));

const moduleDoc = (title: string) => ({
  data: {
    type: 'Module',
    id: 'torque',
    attributes: { title },
  },
});

function setup() {
  TestBed.configureTestingModule({
    providers: [ReviewContext, provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    review: TestBed.inject(ReviewContext),
    http: TestBed.inject(HttpTestingController),
  };
}

const person = (id: string) =>
  TestBed.inject(MeService).set({
    id,
    kind: 'user',
    name: id,
    role: '',
    permissions: new Set(['content.read']),
  });

const isModule = (r: { url: string }) => r.url === '/api/modules/en/torque';

describe('ReviewContext', () => {
  it('reads a module title once per ref', async () => {
    const { review, http } = setup();
    person('u1');
    const first = review.moduleTitle('en', 'torque', 'c1');
    const again = review.moduleTitle('en', 'torque', 'c1');
    await flush();
    http.expectOne(isModule).flush(moduleDoc('Torque'));
    expect(await first).toBe('Torque');
    expect(await again).toBe('Torque');
    http.verify();
  });

  it('never hands a title read for one person to the next (#706)', async () => {
    const { review, http } = setup();
    person('u1');
    const first = review.moduleTitle('en', 'torque', 'c1');
    await flush();
    http.expectOne(isModule).flush(moduleDoc('Only u1 reads this'));
    expect(await first).toBe('Only u1 reads this');

    person('u2');
    const next = review.moduleTitle('en', 'torque', 'c1');
    await flush();
    http
      .expectOne(isModule)
      .flush(null, { status: 403, statusText: 'Forbidden' });
    expect(await next).toBeNull();
  });

  it('reads for the person acting now a title asked for the one before (#706)', async () => {
    const { review, http } = setup();
    person('u1');
    // Every read slot taken, so the next read waits for its turn.
    const busy = ['a', 'b', 'c', 'd'].map((id) =>
      review.moduleTitle('en', id, 'c1'),
    );
    const queued = review.moduleTitle('en', 'torque', 'c1');
    await flush();
    // The person changes: the reads sent for u1 answer afterwards, and are not handed on.
    person('u2');
    for (const id of ['a', 'b', 'c', 'd']) {
      http.expectOne(`/api/modules/en/${id}?ref=c1`).flush(moduleDoc('u1'));
    }
    // Each is asked again for u2, and so is the one that waited: once each.
    const asked: string[] = [];
    for (let round = 0; round < 4; round++) {
      await flush();
      for (const req of http.match(() => true)) {
        asked.push(req.request.url);
        if (isModule(req.request)) req.flush(moduleDoc('Seen by u2'));
        else req.flush(null, { status: 403, statusText: 'Forbidden' });
      }
    }
    expect(asked.sort()).toEqual(
      ['a', 'b', 'c', 'd', 'torque'].map((id) => `/api/modules/en/${id}`),
    );
    expect(await Promise.all(busy)).toEqual([null, null, null, null]);
    expect(await queued).toBe('Seen by u2');
    http.verify();
  });

  it('sends nothing more once the page is gone, a re-read for the next person included (#716)', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    const page = createEnvironmentInjector(
      [ReviewContext],
      TestBed.inject(EnvironmentInjector),
    );
    const review = page.get(ReviewContext);
    person('u1');
    const busy = ['a', 'b', 'c', 'd'].map((id) =>
      review.moduleTitle('en', id, 'c1'),
    );
    const queued = review.moduleTitle('en', 'torque', 'c1');
    await flush();
    person('u2');
    page.destroy();
    for (const id of ['a', 'b', 'c', 'd']) {
      http.expectOne(`/api/modules/en/${id}?ref=c1`).flush(moduleDoc('u1'));
    }
    for (let round = 0; round < 3; round++) await flush();
    // Neither the stale answers nor the read that waited are asked for anyone.
    http.expectNone(() => true);
    expect(await Promise.all(busy)).toEqual([null, null, null, null]);
    expect(await queued).toBeNull();
  });
});
