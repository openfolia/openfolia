import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { MeService } from '../permissions/me';
import { TermExists, TermWrites } from './term-writes';
import type { TermContent } from './terms-model';

const pump: TermContent = {
  schemaVersion: 1,
  id: 'pump',
  status: 'proposed',
  languages: { en: { preferred: 'pump', allowed: [], forbidden: [] } },
};

const copy = (saved: boolean) => ({
  data: {
    type: 'WorkingCopy',
    id: 'cs1/term/pump',
    attributes: {
      subject: { type: 'term', termId: 'pump' },
      content: pump,
      version: 1,
      baseCommit: 'a'.repeat(40),
    },
    meta: { saved, issues: [] },
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve));

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideZard()],
  });
  TestBed.inject(MeService).set({
    id: 'u1',
    kind: 'user',
    name: 'U',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
    editsEverything: true,
  });
  const http = TestBed.inject(HttpTestingController);
  /** Answers the one open request to `url` (and `method`) with `body`, or a 404 when null. */
  const answer = async (method: string, url: string, body: object | null) => {
    await flush();
    const req = http.expectOne((r) => r.method === method && r.url === url);
    if (body === null) {
      req.flush(
        { errors: [{ status: '404', code: 'not-found', title: 'Not found' }] },
        { status: 404, statusText: 'Not Found' },
      );
    } else {
      req.flush(body);
    }
  };
  return { writes: TestBed.inject(TermWrites), http, answer };
}

describe('TermWrites', () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('discards a term only in the working copy, and shows it again once added anew', async () => {
    const { writes, answer, http } = setup();
    const copyUrl = '/api/change-sets/cs1/terms/pump/working-copy';

    const deleting = writes.delete('pump', 'pump', 'cs1');
    await answer('GET', copyUrl, copy(true));
    // Saved, but not on the branch: never committed, so the copy just goes.
    await answer('GET', '/api/terms/pump', null);
    await answer('POST', '/api/change-sets/cs1/locks', { data: {} });
    await answer('DELETE', copyUrl, { meta: {} });
    expect(await deleting).toBe(true);
    expect(writes.isHidden('cs1', 'pump')).toBe(true);
    expect(writes.isHidden('cs2', 'pump')).toBe(false);

    const creating = writes.create(pump, 'cs1');
    await answer('GET', copyUrl, null);
    await answer('GET', '/api/change-sets/cs1', {
      data: { attributes: { baseCommit: 'a'.repeat(40) } },
    });
    await answer('POST', '/api/change-sets/cs1/locks', { data: {} });
    await answer('PUT', copyUrl, copy(true));
    await answer('POST', '/api/change-sets/cs1/commits', {
      data: { id: 'b'.repeat(40) },
    });
    await creating;
    expect(writes.isHidden('cs1', 'pump')).toBe(false);
    http.verify();
  });

  it('refuses to add a term the change set has already', async () => {
    const { writes, answer } = setup();
    const creating = writes.create(pump, 'cs1');
    const refused = expect(creating).rejects.toBeInstanceOf(TermExists);
    await answer(
      'GET',
      '/api/change-sets/cs1/terms/pump/working-copy',
      copy(false),
    );
    await refused;
  });
});
