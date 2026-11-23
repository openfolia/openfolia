import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import {
  ReviewRuleTopicPage,
  type SelfApproval,
} from './review-rule-topic.component';

const doc = (selfApproval: SelfApproval) => ({
  data: {
    type: 'InstallationSettings',
    id: 'installation',
    attributes: { selfApproval, updatedAt: null },
  },
});

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'review', component: ReviewRuleTopicPage }]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl('/review');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  return {
    http,
    settle,
    root: harness.routeNativeElement as HTMLElement,
    toasts: TestBed.inject(ToastService),
  };
}

const radio = (root: HTMLElement, value: string) =>
  root.querySelector<HTMLElement>(`[data-option="${value}"] [role="radio"]`);

const checked = (root: HTMLElement) =>
  root
    .querySelector('[data-option] [aria-checked="true"]')
    ?.closest('[data-option]')
    ?.getAttribute('data-option');

describe('ReviewRuleTopicPage', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the three rules with the saved one chosen', async () => {
    const { http, settle, root } = await render();
    http.expectOne('/api/settings').flush(doc('never'));
    await settle();
    expect(
      [...root.querySelectorAll('[data-option]')].map((o) =>
        o.getAttribute('data-option'),
      ),
    ).toEqual(['never', 'review', 'review-and-sign-off']);
    expect(checked(root)).toBe('never');
  });

  it('saves a choice at once', async () => {
    const { http, settle, root } = await render();
    http.expectOne('/api/settings').flush(doc('never'));
    await settle();
    radio(root, 'review')?.click();
    await settle();
    const req = http.expectOne('/api/settings');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      data: {
        type: 'InstallationSettings',
        id: 'installation',
        attributes: { selfApproval: 'review' },
      },
    });
    req.flush(doc('review'));
    await settle();
    expect(checked(root)).toBe('review');
    expect(
      root.querySelector('of-save-status')?.getAttribute('data-status'),
    ).toBe('saved');
  });

  it('puts the saved rule back and says why when the API refuses', async () => {
    const { http, settle, root, toasts } = await render();
    const error = vi.spyOn(toasts, 'error');
    http.expectOne('/api/settings').flush(doc('never'));
    await settle();
    radio(root, 'review-and-sign-off')?.click();
    await settle();
    http.expectOne('/api/settings').flush(
      {
        errors: [
          {
            status: '403',
            code: 'forbidden',
            title: 'Forbidden',
            detail: 'No.',
          },
        ],
      },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    expect(checked(root)).toBe('never');
    expect(error).toHaveBeenCalled();
    expect(
      root.querySelector('of-save-status')?.getAttribute('data-status'),
    ).toBe('not-saved');
  });

  it('offers a retry when the rule cannot be read', async () => {
    const { http, settle, root } = await render();
    http
      .expectOne('/api/settings')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await settle();
    expect(root.querySelector('of-error-state')).not.toBeNull();
  });
});
