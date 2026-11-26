import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Location } from '@angular/common';
import { SpyLocation } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService, NOBODY, UNCONFIRMED } from '../permissions/me';
import { SecondFactorDialogComponent } from './second-factor-dialog.component';
import { SecondFactorDialogState } from './second-factor-dialog-state';

const own = (
  enabledAt: string | null,
  meta: Partial<Record<string, unknown>> = {},
) => ({
  data: {
    type: 'SecondFactor',
    id: 'own',
    attributes: { enabledAt },
    meta: {
      recoveryCodesLeft: enabledAt === null ? 0 : 10,
      required: false,
      available: true,
      hasPassword: true,
      ...meta,
    },
  },
});
const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-000${i}`);
const refusal = (status: number, code: string) =>
  [
    { errors: [{ status: String(status), title: 'x', detail: 'x', code }] },
    { status, statusText: 'x' },
  ] as const;

async function open(answer: ReturnType<typeof own>) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
      { provide: Location, useClass: SpyLocation },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SecondFactorDialogComponent);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  const state = TestBed.inject(SecondFactorDialogState);
  state.open.set(true);
  await settle();
  http.expectOne('/api/me/second-factor').flush(answer);
  await settle();
  const get = <T extends HTMLElement>(selector: string) =>
    document.querySelector<T>(selector);
  return {
    http,
    settle,
    state,
    get,
    view: () =>
      get('[data-testid="second-factor-dialog"]')?.getAttribute('data-view'),
    type: (selector: string, value: string) => {
      const input = get<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    },
    submit: async () => {
      get<HTMLFormElement>('#second-factor-form')!.requestSubmit();
      await settle();
    },
    click: async (testid: string) => {
      get(`[data-testid="${testid}"]`)!.click();
      await settle();
    },
  };
}

describe('SecondFactorDialogComponent (#611)', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.inject(SecondFactorDialogState).open.set(false);
  });

  it('sets it up: the password, a wrong code, the right one, the codes once', async () => {
    const d = await open(own(null));
    expect(d.view()).toBe('off');
    // Nothing is sent without the password.
    await d.submit();
    expect(d.get('[role="alert"]')).not.toBeNull();
    d.type('#second-factor-password', 'my long password');
    await d.submit();
    const begin = d.http.expectOne('/api/me/second-factor/set-up');
    expect(begin.request.body.data.attributes).toEqual({
      password: 'my long password',
    });
    begin.flush({
      meta: {
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        otpauthUrl: 'otpauth://totp/x',
        qrCode: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        account: 'pat@example.org',
      },
    });
    await d.settle();
    expect(d.view()).toBe('set-up');
    expect(d.get('#second-factor-password')).toBeNull();
    // The key in two even halves, four groups each.
    expect(
      [...(d.get('[data-testid="second-factor-secret"]')?.children ?? [])].map(
        (half) => half.textContent,
      ),
    ).toEqual(['JBSW Y3DP EHPK 3PXP', 'JBSW Y3DP EHPK 3PXP']);

    d.type('#second-factor-own-code', '000000');
    await d.submit();
    d.http
      .expectOne('/api/me/second-factor/confirm')
      .flush(...refusal(403, 'wrong-code'));
    await d.settle();
    expect(d.view()).toBe('set-up');
    expect(d.get('[role="alert"]')).not.toBeNull();

    d.type('#second-factor-own-code', '123 456');
    await d.submit();
    const confirm = d.http.expectOne('/api/me/second-factor/confirm');
    expect(confirm.request.body.data.attributes).toEqual({ code: '123456' });
    confirm.flush({ meta: { recoveryCodes: codes, sessionsEnded: 2 } });
    await d.settle();
    expect(d.view()).toBe('codes');
    expect(
      d.get('[data-testid="recovery-codes"]')?.querySelectorAll('li'),
    ).toHaveLength(10);
    expect(d.get('[data-testid="second-factor-secret"]')).toBeNull();
    await d.click('second-factor-done');
    expect(d.state.open()).toBe(false);

    // Opened again, the codes are gone and it is read anew.
    d.state.open.set(true);
    await d.settle();
    expect(d.get('[data-testid="recovery-codes"]')).toBeNull();
    d.http
      .expectOne('/api/me/second-factor')
      .flush(own('2026-01-02T00:00:00Z', { recoveryCodesLeft: 2 }));
    await d.settle();
    expect(d.view()).toBe('on');
  });

  it('starts over when a set-up ran out', async () => {
    const d = await open(own(null, { hasPassword: false }));
    await d.submit();
    const begin = d.http.expectOne('/api/me/second-factor/set-up');
    expect(begin.request.body.data.attributes).toEqual({});
    begin.flush({
      meta: { secret: 'A', otpauthUrl: 'o', qrCode: '<svg/>', account: 'x' },
    });
    await d.settle();
    d.type('#second-factor-own-code', '123456');
    await d.submit();
    d.http
      .expectOne('/api/me/second-factor/confirm')
      .flush(...refusal(409, 'second-factor-not-begun'));
    await d.settle();
    expect(d.view()).toBe('off');
    expect(d.get('[role="alert"]')).not.toBeNull();
  });

  it('makes new codes with the password, and turns off with a code', async () => {
    const d = await open(own('2026-01-02T00:00:00Z', { required: true }));
    expect(d.get('[data-testid="second-factor-required"]')).not.toBeNull();
    await d.click('second-factor-new-codes');
    d.type('#second-factor-password', 'my long password');
    await d.submit();
    const made = d.http.expectOne('/api/me/second-factor/recovery-codes');
    expect(made.request.body.data.attributes).toEqual({
      password: 'my long password',
    });
    made.flush({ meta: { recoveryCodes: codes } });
    await d.settle();
    expect(d.view()).toBe('codes');
    await d.click('second-factor-done');

    d.state.open.set(true);
    await d.settle();
    // Without a password only a code proves the person.
    d.http
      .expectOne('/api/me/second-factor')
      .flush(own('2026-01-02T00:00:00Z', { hasPassword: false }));
    await d.settle();
    await d.click('second-factor-turn-off');
    expect(d.get('#second-factor-password')).toBeNull();
    d.type('#second-factor-own-code', '123456');
    await d.submit();
    const off = d.http.expectOne('/api/me/second-factor/turn-off');
    expect(off.request.body.data.attributes).toEqual({ code: '123456' });
    off.flush(null);
    await d.settle();
    expect(d.state.open()).toBe(false);
  });

  const person = (id: string) =>
    TestBed.inject(MeService).set({ ...NOBODY, id, kind: 'user' });

  /** Pat's set-up confirmed, the answer still under way. */
  async function confirming() {
    const d = await open(own(null, { hasPassword: false }));
    await d.submit();
    d.http.expectOne('/api/me/second-factor/set-up').flush({
      meta: { secret: 'A', otpauthUrl: 'o', qrCode: '<svg/>', account: 'x' },
    });
    await d.settle();
    d.type('#second-factor-own-code', '123456');
    await d.submit();
    const confirm = d.http.expectOne('/api/me/second-factor/confirm');
    const answer = async () => {
      confirm.flush({ meta: { recoveryCodes: codes, sessionsEnded: 0 } });
      await d.settle();
    };
    return { ...d, answer };
  }

  it('shows codes that come after it was closed, to the person who asked', async () => {
    const d = await confirming();
    d.state.open.set(false);
    await d.settle();
    await d.answer();
    expect(d.state.open()).toBe(true);
    expect(d.view()).toBe('codes');
    expect(
      d.get('[data-testid="recovery-codes"]')?.querySelectorAll('li'),
    ).toHaveLength(10);
    await d.click('second-factor-done');
    expect(d.state.open()).toBe(false);
  });

  it('shows codes that come just after Back, before the page has changed', async () => {
    const d = await confirming();
    (TestBed.inject(Location) as SpyLocation).simulateUrlPop('/back');
    await d.answer();
    expect(d.view()).toBe('codes');
    await new Promise((r) => setTimeout(r, 150));
    await d.settle();
    expect(d.state.open()).toBe(true);
    expect(
      d.get('[data-testid="recovery-codes"]')?.querySelectorAll('li'),
    ).toHaveLength(10);
  });

  it('drops codes that come once someone else is signed in', async () => {
    const d = await confirming();
    d.state.open.set(false);
    await d.settle();
    // Another tab signed someone in: until it is known whom, the codes wait.
    person(`${UNCONFIRMED}1`);
    await d.settle();
    await d.answer();
    expect(d.state.open()).toBe(false);
    person('lee');
    await d.settle();
    expect(d.state.open()).toBe(false);
    expect(document.body.textContent).not.toContain(codes[0]);
    // Nor are they there for the next one who opens it.
    d.state.open.set(true);
    await d.settle();
    expect(d.get('[data-testid="recovery-codes"]')).toBeNull();
    d.http.expectOne('/api/me/second-factor').flush(own(null));
    await d.settle();
    expect(d.view()).toBe('off');
  });

  it('shows codes held back for a sign-in in another tab, once it is the same person', async () => {
    const d = await confirming();
    const me = TestBed.inject(MeService).me();
    person(`${UNCONFIRMED}1`);
    await d.settle();
    await d.answer();
    expect(d.view()).toBe('set-up');
    TestBed.inject(MeService).set(me);
    await d.settle();
    expect(d.view()).toBe('codes');
  });

  it('closes with its codes when someone else signs in', async () => {
    const d = await confirming();
    await d.answer();
    expect(d.view()).toBe('codes');
    person('lee');
    await d.settle();
    expect(d.state.open()).toBe(false);
    expect(document.body.textContent).not.toContain(codes[0]);
  });

  it('stays open for the person it turns out to be, opened before that was known', async () => {
    const d = await open(own(null));
    d.state.open.set(false);
    await d.settle();
    person(`${UNCONFIRMED}1`);
    d.state.open.set(true);
    await d.settle();
    d.http.expectOne('/api/me/second-factor').flush(own(null));
    person('pat');
    await d.settle();
    expect(d.state.open()).toBe(true);
    person('lee');
    await d.settle();
    expect(d.state.open()).toBe(false);
  });

  describe('with codes not put away yet', () => {
    const question = () =>
      document.querySelector<HTMLElement>('[role="alertdialog"]');
    const answerWith = (text: string) =>
      [...(question()?.querySelectorAll('button') ?? [])]
        .find((b) => b.textContent?.includes(text))!
        .click();
    const escape = () =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    const ways: [string, () => void][] = [
      ['Escape', escape],
      [
        'the X',
        () =>
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="z-close-header-button"]',
            )!
            .click(),
      ],
      [
        'Back',
        () => (TestBed.inject(Location) as SpyLocation).simulateUrlPop('/back'),
      ],
    ];
    it.each(ways)('asks first on %s', async (_, way) => {
      const d = await confirming();
      await d.answer();
      way();
      await d.settle();
      expect(question()).not.toBeNull();
      expect(d.view()).toBe('codes');
      answerWith('Back to the codes');
      await new Promise((r) => setTimeout(r, 150));
      await d.settle();
      expect(question()).toBeNull();
      expect(d.state.open()).toBe(true);
      way();
      await d.settle();
      answerWith('Close');
      await d.settle();
      expect(d.state.open()).toBe(false);
    });

    it('holds a navigation until it is answered, Escape as no', async () => {
      const d = await confirming();
      // Nothing to lose yet.
      expect(await d.state.leave()).toBe(true);
      await d.answer();
      let left: boolean | undefined;
      void d.state.leave().then((answer) => (left = answer));
      await d.settle();
      expect(left).toBeUndefined();
      escape();
      await d.settle();
      expect(left).toBe(false);
      void d.state.leave().then((answer) => (left = answer));
      await d.settle();
      answerWith('Close');
      await d.settle();
      expect(left).toBe(true);
    });
  });

  it('closes on Back where nothing is lost', async () => {
    const d = await open(own('2026-01-02T00:00:00Z'));
    (TestBed.inject(Location) as SpyLocation).simulateUrlPop('/back');
    await new Promise((r) => setTimeout(r, 50));
    await d.settle();
    expect(d.state.open()).toBe(false);
  });

  it('takes a recovery code in place of the app’s', async () => {
    const d = await open(
      own('2026-01-02T00:00:00Z', { hasPassword: false, required: true }),
    );
    await d.click('second-factor-turn-off');
    expect(d.get('z-dialog-description')?.textContent).toContain(
      'you set it up again',
    );
    await d.click('second-factor-other-code');
    expect(d.get('#second-factor-own-code')?.getAttribute('inputmode')).toBe(
      'text',
    );
    d.type('#second-factor-own-code', 'aaaa-bbbb-cccc-dddd');
    await d.submit();
    const off = d.http.expectOne('/api/me/second-factor/turn-off');
    expect(off.request.body.data.attributes).toEqual({
      code: 'aaaabbbbccccdddd',
    });
    off.flush(...refusal(403, 'wrong-code'));
    await d.settle();
    expect(d.get('[role="alert"]')?.textContent).toContain(
      'This recovery code is not right',
    );
  });

  it('offers nothing to set up without the server’s key', async () => {
    const d = await open(own(null, { available: false }));
    expect(d.get('[data-testid="second-factor-unavailable"]')).not.toBeNull();
    expect(d.get('[data-testid="second-factor-submit"]')).toBeNull();
  });
});
