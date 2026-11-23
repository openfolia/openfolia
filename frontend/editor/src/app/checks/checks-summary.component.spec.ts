import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { ChecksSummaryComponent } from './checks-summary.component';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const doc = (blocking: number, warning: number) => ({
  data: [],
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 1, total: 0 },
    counts: { blocking, warning },
    modules: { checked: 1, withoutIssues: 1 },
    commit: 'c1',
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const fixture = TestBed.createComponent(ChecksSummaryComponent);
  fixture.componentRef.setInput('changeSetId', CS);
  await fixture.whenStable();
  const http = TestBed.inject(HttpTestingController);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  return { fixture, http, el, settle };
}

describe('ChecksSummaryComponent', () => {
  it('counts what blocks and warns, and runs the checks on this change set', async () => {
    const { fixture, http, el, settle } = await render();
    const req = http.expectOne(
      (r) => r.url === `/api/change-sets/${CS}/checks`,
    );
    expect(req.request.params.get('page[size]')).toBe('1');
    req.flush(doc(2, 1));
    await settle();
    expect(el.textContent).toContain('2 blocking');
    expect(el.textContent).toContain('1 warning');
    const link = el.querySelector('a');
    expect(link?.textContent?.trim()).toBe('Run checks');
    expect(link?.getAttribute('href')).toBe(`/checks?changeSet=${CS}`);
  });

  it('says when nothing was found, and when the read failed', async () => {
    const { fixture, http, el, settle } = await render();
    http
      .expectOne((r) => r.url === `/api/change-sets/${CS}/checks`)
      .flush(doc(0, 0));
    await settle();
    expect(el.textContent).toContain('No issues found');

    fixture.componentRef.setInput('changeSetId', 'other');
    await settle();
    http
      .expectOne((r) => r.url === '/api/change-sets/other/checks')
      .flush(
        { errors: [{ status: '503', code: 'unavailable', title: 'Busy' }] },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await settle();
    expect(el.textContent).toContain('The checks could not be read.');
    expect(el.querySelector('a')?.getAttribute('href')).toBe(
      '/checks?changeSet=other',
    );
  });
});
