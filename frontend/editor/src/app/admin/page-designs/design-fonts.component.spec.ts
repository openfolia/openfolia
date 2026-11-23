import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { DesignFontsComponent } from './design-fonts.component';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const UPLOAD = `/api/change-sets/${CS}/assets`;
const OTHER = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const links = { self: '', first: '', last: '', prev: null, next: null };
const none = {
  data: [],
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 100, total: 0 } },
  links,
};
const uploaded = (n: string) => ({
  data: {
    type: 'Asset',
    id: n.repeat(64),
    attributes: { reference: `sha256:${n.repeat(64)}` },
  },
});

/** A file input as the component reads it. */
const chosen = (...names: string[]) =>
  ({
    files: names.map((name) => new File(['x'], name, { type: 'font/ttf' })),
    value: 'C:\\fakepath\\x',
  }) as unknown as HTMLInputElement;

describe('DesignFontsComponent (#555)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('uploads fonts chosen while others upload after them, none dropped', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        provideZard(),
      ],
    });
    const fixture = TestBed.createComponent(DesignFontsComponent);
    fixture.componentRef.setInput('fonts', {});
    fixture.componentRef.setInput('editable', true);
    fixture.componentRef.setInput('changeSetId', CS);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const settle = () => new Promise((done) => setTimeout(done));
    http.expectOne((r) => r.url === '/api/assets').flush(none);
    await settle();

    const component = fixture.componentInstance as unknown as {
      upload(input: HTMLInputElement): Promise<void>;
    };
    const first = component.upload(chosen('a.ttf'));
    await settle();
    // Chosen while the first one is on its way.
    const second = component.upload(chosen('b.ttf'));
    http.expectOne((r) => r.url === UPLOAD).flush(uploaded('a'));
    await settle();
    http.expectOne((r) => r.url === UPLOAD).flush(uploaded('b'));
    await settle();
    // Chosen while the list is read again: uploaded after it, then read again.
    const third = component.upload(chosen('c.ttf'));
    http.expectOne((r) => r.url === '/api/assets').flush(none);
    await settle();
    http.expectOne((r) => r.url === UPLOAD).flush(uploaded('c'));
    await settle();
    http.expectOne((r) => r.url === '/api/assets').flush(none);
    await Promise.all([first, second, third]);
  });

  it('uploads a font into the change set it was chosen in, another opened meanwhile', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        provideZard(),
      ],
    });
    const fixture = TestBed.createComponent(DesignFontsComponent);
    fixture.componentRef.setInput('fonts', {});
    fixture.componentRef.setInput('editable', true);
    fixture.componentRef.setInput('changeSetId', CS);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const settle = () => new Promise((done) => setTimeout(done));
    http.expectOne((r) => r.url === '/api/assets').flush(none);
    await settle();
    const component = fixture.componentInstance as unknown as {
      upload(input: HTMLInputElement): Promise<void>;
    };

    const first = component.upload(chosen('a.ttf'));
    await settle();
    // Another change set opened while the first upload runs, and a font chosen there.
    fixture.componentRef.setInput('changeSetId', OTHER);
    fixture.detectChanges();
    http
      .expectOne(
        (r) =>
          r.url === '/api/assets' &&
          r.params.get('filter[changeSet]') === OTHER,
      )
      .flush(none);
    const second = component.upload(chosen('b.ttf'));
    http.expectOne((r) => r.url === UPLOAD).flush(uploaded('a'));
    await settle();
    http
      .expectOne((r) => r.url === `/api/change-sets/${OTHER}/assets`)
      .flush(uploaded('b'));
    await settle();
    http.expectOne((r) => r.url === '/api/assets').flush(none);
    await Promise.all([first, second]);
  });
});
