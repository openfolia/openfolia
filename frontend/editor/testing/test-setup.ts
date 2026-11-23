// Runs before every unit test file of the editor (project.json, `setupFiles`).
//
// The Angular builder runs Vitest without isolation: the spec files a worker picks up share one
// window, so whatever one test leaves in it is there for the next test, of that file or another
// (#306). Which files share a worker, and in which order, changes with the machine's load. So every
// test starts from the same window here, once, instead of each spec cleaning up after itself.
import { afterEach, beforeEach, vi } from 'vitest';

import { trackTest } from '../src/app/testing/fake-time';

// `window.matchMedia` as the worker's window first had it. This file runs again before every spec
// file of the worker, so the first run keeps it on the window, where the later ones find it.
// Vitest's environment makes it a getter and setter that keeps what was assigned, so both the
// property and its value are kept: putting the property back undoes a `defineProperty`, setting
// the value undoes an assignment.
const windowMatchMedia = Symbol.for('openfolia.test-setup.matchMedia');
type Kept = {
  descriptor: PropertyDescriptor | undefined;
  value: typeof window.matchMedia | undefined;
};
const kept = window as unknown as Record<symbol, Kept | undefined>;
kept[windowMatchMedia] ??= {
  descriptor: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  value: window.matchMedia,
};
const matchMedia = kept[windowMatchMedia];

function restoreMatchMedia() {
  if (!matchMedia.descriptor) {
    Reflect.deleteProperty(window, 'matchMedia');
    return;
  }
  Object.defineProperty(window, 'matchMedia', matchMedia.descriptor);
  if (window.matchMedia !== matchMedia.value)
    Reflect.set(window, 'matchMedia', matchMedia.value);
}

beforeEach((context) => {
  // The fake-time helpers stop a test that timed out at its next step, so that it cannot run on
  // the next test's clock and page (#615).
  trackTest(context.signal);
  // Browser storage: the change set chosen (`openfolia.change-set`), the sidebar choice, drafts,
  // recent items, the signed-in demo user. A test that needs a value sets it itself.
  localStorage.clear();
  sessionStorage.clear();
  // The page: dialogs and menus opened into the body, and fixtures a spec moved there. TestBed
  // removes only the hosts it still finds by their `root…` id, so a component that binds its own
  // `id` (a review diff item, say) stays behind, and a later test's query finds its buttons.
  // The previous test's TestBed is torn down by now.
  document.body.replaceChildren();
});

afterEach(() => {
  // After its test: a hook's own steps (this file's, the next file's beforeAll) are no test's.
  trackTest(undefined);
  // A test that failed before undoing its own fakes leaves none behind: spies on shared objects
  // (`URL.createObjectURL`, `Storage.prototype`, a component's prototype) and fake timers.
  // This runs after the spec's own afterEach hooks but before TestBed's teardown, so the
  // components' ngOnDestroy already sees the real functions: a spec that checks a spy's calls
  // made on destroy restores that spy itself, later (`onTestFinished`).
  vi.restoreAllMocks();
  vi.useRealTimers();
  // A stub set with `defineProperty` or a plain assignment, which `vi.restoreAllMocks()` leaves:
  // a partial MediaQueryList breaks code that listens for a change, and a `matches` answer
  // turns motion off for the specs after it (#780).
  restoreMatchMedia();
});
