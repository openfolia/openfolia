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
import { SecondFactorDialogState } from '../../second-factor/second-factor-dialog-state';
import { SecondFactorTopicPage } from './second-factor-topic.component';

const doc = (secondFactor: string) => ({
  data: {
    type: 'InstallationSettings',
    id: 'installation',
    attributes: { selfApproval: 'never', secondFactor, updatedAt: null },
  },
});

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'x', component: SecondFactorTopicPage }]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl('/x');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  http.expectOne('/api/settings').flush(doc('optional'));
  await settle();
  return { http, settle, root: harness.routeNativeElement as HTMLElement };
}

const option = (root: HTMLElement, value: string) =>
  root.querySelector<HTMLElement>(`[data-option="${value}"] [role="radio"]`)!;

describe('SecondFactorTopicPage (#611)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('saves who must have a second factor, and nothing else', async () => {
    const { http, settle, root } = await render();
    option(root, 'everyone').click();
    await settle();
    const req = http.expectOne('/api/settings');
    expect(req.request.body.data.attributes).toEqual({
      secondFactor: 'everyone',
    });
    req.flush(doc('everyone'));
    await settle();
    expect(option(root, 'everyone').getAttribute('aria-checked')).toBe('true');
  });

  it('says to turn one’s own on first, keeps the saved rule and offers the set-up', async () => {
    const { http, settle, root } = await render();
    const error = vi.spyOn(TestBed.inject(ToastService), 'error');
    option(root, 'admins').click();
    await settle();
    http.expectOne('/api/settings').flush(
      {
        errors: [
          {
            status: '409',
            code: 'second-factor-own-first',
            title: 'Conflict',
            detail: 'x',
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(option(root, 'optional').getAttribute('aria-checked')).toBe('true');
    const note = root.querySelector('[data-testid="second-factor-own-first"]');
    expect(note).not.toBeNull();
    // Said once, on the page.
    expect(error).not.toHaveBeenCalled();
    note!.querySelector('button')!.click();
    const dialog = TestBed.inject(SecondFactorDialogState);
    expect(dialog.open()).toBe(true);
    // Gone once that is done.
    await settle();
    dialog.open.set(false);
    await settle();
    expect(
      root.querySelector('[data-testid="second-factor-own-first"]'),
    ).toBeNull();
  });
});
