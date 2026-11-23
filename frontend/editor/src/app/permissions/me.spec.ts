import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService, UNCONFIRMED } from './me';

/** The key a tab marks a change of the signed-in person under, for the other tabs. */
const SIGNED_IN = 'openfolia.signed-in';

const meDoc = (id: string, session = true) => ({
  data: {
    type: 'Actor',
    id,
    attributes: { kind: 'user', name: `Name ${id}`, roles: [] },
    meta: {
      permissions: [],
      ...(session && {
        session: { provider: 'password', expiresAt: '2099-01-01T00:00:00Z' },
      }),
    },
  },
});

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return {
    me: TestBed.inject(MeService),
    http: TestBed.inject(HttpTestingController),
  };
}

const isMe = (r: { url: string }) => r.url === '/api/me';
const otherTab = (value: string) =>
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: SIGNED_IN,
      newValue: value,
      storageArea: localStorage,
    }),
  );

describe('MeService across tabs (#716)', () => {
  afterEach(() => localStorage.clear());

  it('reads who is acting again when another tab signed someone in', async () => {
    const { me, http } = setup();
    const first = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await first;
    expect(me.me().id).toBe('u1');

    // Another tab signed in as u2: the session cookie is theirs now.
    otherTab('1');
    http.expectOne(isMe).flush(meDoc('u2'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(me.me().id).toBe('u2');
    expect(me.status()).toBe('ready');
    http.verify();
  });

  it('tells the other tabs when the person it confirmed changed, and only then', async () => {
    const { me, http } = setup();
    const first = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await first;
    const marked = localStorage.getItem(SIGNED_IN);
    expect(marked).not.toBeNull();

    // The same person again: nothing to tell.
    const same = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await same;
    expect(localStorage.getItem(SIGNED_IN)).toBe(marked);

    const next = me.refresh();
    http.expectOne(isMe).flush(meDoc('u2'));
    await next;
    expect(localStorage.getItem(SIGNED_IN)).not.toBe(marked);
    // Nothing that names the person is written.
    expect(localStorage.getItem(SIGNED_IN)).toMatch(/^\d+$/);
  });

  it('keys what is read before its `/me` answers to nobody, not to the person before', async () => {
    const { me, http } = setup();
    const first = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await first;

    otherTab('1');
    // The cookie may be someone else's already: neither u1 nor "not known yet" ('').
    expect(me.me().id.startsWith(UNCONFIRMED)).toBe(true);
    expect(me.presence()).toBe('person');
    http.expectOne(isMe).flush(meDoc('u2'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(me.me().id).toBe('u2');
  });

  it('tells no other tab when it followed one, so the sign-in does not echo back', async () => {
    const { me, http } = setup();
    const first = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await first;
    const marked = localStorage.getItem(SIGNED_IN);

    otherTab('1');
    http.expectOne(isMe).flush(meDoc('u2'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(me.me().id).toBe('u2');
    expect(localStorage.getItem(SIGNED_IN)).toBe(marked);
  });

  it('shows the failure, never the person before, when that read fails', async () => {
    const { me, http } = setup();
    const first = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await first;

    otherTab('1');
    http.expectOne(isMe).flush(null, { status: 503, statusText: 'x' });
    await new Promise((resolve) => setTimeout(resolve));
    expect(me.status()).toBe('error');
    expect(me.presence()).toBe('failed');
    expect(me.me().id).not.toBe('u1');
  });

  it('reads once more for a sign-in told while its read is on its way', async () => {
    const { me, http } = setup();
    const first = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await first;

    otherTab('1');
    otherTab('2');
    // One read at a time.
    http.expectOne(isMe).flush(meDoc('u2'));
    await new Promise((resolve) => setTimeout(resolve));
    http.expectOne(isMe).flush(meDoc('u3'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(me.me().id).toBe('u3');
    http.verify();
  });

  it('reads again when a read that overtook the follow failed, so the placeholder does not stay', async () => {
    const { me, http } = setup();
    const first = me.refresh();
    http.expectOne(isMe).flush(meDoc('u1'));
    await first;
    const marked = localStorage.getItem(SIGNED_IN);

    otherTab('1');
    const follow = http.expectOne(isMe);
    // A refused call checks the session meanwhile: its read overtakes the follow.
    me.sessionRefused();
    const check = http.expectOne(isMe);
    follow.flush(meDoc('u2'));
    check.flush(null, { status: 503, statusText: 'x' });
    await new Promise((resolve) => setTimeout(resolve));
    // Still nobody known here: read once more.
    http.expectOne(isMe).flush(meDoc('u2'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(me.me().id).toBe('u2');
    expect(localStorage.getItem(SIGNED_IN)).toBe(marked);
    http.verify();
  });

  it('asks nothing for a tab acting without a session (the token, a demo user)', () => {
    const { me, http } = setup();
    me.set({
      id: 'u1',
      kind: 'user',
      name: 'U',
      role: '',
      permissions: new Set(),
    });
    otherTab('1');
    http.expectNone(isMe);
  });
});
