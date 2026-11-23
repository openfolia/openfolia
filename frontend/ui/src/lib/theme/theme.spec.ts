import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { withThemeFade } from './theme-fade';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

/** A document whose window answers the two media queries the theme reads. */
function fakeDocument(options: {
  reducedMotion?: boolean;
  systemDark?: boolean;
  viewTransition?: (callback: () => void) => void;
  storage?: Storage;
}): { doc: Document; setSystemDark: (dark: boolean) => void } {
  const doc = document.implementation.createHTMLDocument('t');
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const view = {
    matchMedia: (query: string) => ({
      matches: query.includes('reduced-motion')
        ? !!options.reducedMotion
        : !!options.systemDark,
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) =>
        listeners.push(l),
    }),
    localStorage: options.storage ?? new MemoryStorage(),
  };
  Object.defineProperty(doc, 'defaultView', { value: view });
  if (options.viewTransition) {
    Object.defineProperty(doc, 'startViewTransition', {
      value: options.viewTransition,
    });
  }
  return {
    doc,
    setSystemDark: (dark) => listeners.forEach((l) => l({ matches: dark })),
  };
}

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe('withThemeFade', () => {
  it('crossfades the change where the browser can', () => {
    const start = vi.fn((callback: () => void) => callback());
    const { doc } = fakeDocument({ viewTransition: start });
    const change = vi.fn();
    withThemeFade(change, doc);
    expect(start).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledOnce();
  });

  it('just applies the change where the browser has no view transitions', () => {
    const { doc } = fakeDocument({});
    const change = vi.fn();
    withThemeFade(change, doc);
    expect(change).toHaveBeenCalledOnce();
  });

  it('skips the fade for someone who asked for less motion', () => {
    const start = vi.fn((callback: () => void) => callback());
    const { doc } = fakeDocument({
      reducedMotion: true,
      viewTransition: start,
    });
    const change = vi.fn();
    withThemeFade(change, doc);
    expect(start).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledOnce();
  });
});

describe('ThemeService', () => {
  function service(doc: Document) {
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: doc }],
    });
    return TestBed.inject(ThemeService);
  }

  it('follows the device by default, and its changes', () => {
    const { doc, setSystemDark } = fakeDocument({ systemDark: true });
    const theme = service(doc);
    expect(theme.preference()).toBe('system');
    expect(doc.documentElement.classList.contains('dark')).toBe(true);
    setSystemDark(false);
    expect(doc.documentElement.classList.contains('dark')).toBe(false);
    expect(doc.documentElement.style.colorScheme).toBe('light');
  });

  it('applies a choice inside the crossfade and remembers it for the next visit', () => {
    const storage = new MemoryStorage();
    let classDuringTransition: boolean | undefined;
    const start = vi.fn((callback: () => void) => {
      callback();
      classDuringTransition = doc.documentElement.classList.contains('dark');
    });
    const { doc } = fakeDocument({ storage, viewTransition: start });
    service(doc).choose('dark');
    expect(start).toHaveBeenCalledOnce();
    expect(classDuringTransition).toBe(true);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    TestBed.resetTestingModule();
    const next = fakeDocument({ storage });
    expect(service(next.doc).resolved()).toBe('dark');
    expect(next.doc.documentElement.classList.contains('dark')).toBe(true);
  });

  it('keeps the last of two quick choices, before the first has been applied', () => {
    const pending: (() => void)[] = [];
    const { doc } = fakeDocument({
      viewTransition: (callback) => pending.push(callback),
    });
    const theme = service(doc);
    theme.choose('dark');
    theme.choose('system');
    pending.forEach((callback) => callback());
    expect(theme.preference()).toBe('system');
    expect(doc.documentElement.classList.contains('dark')).toBe(false);
  });

  it('works without storage: the choice lasts for the page', () => {
    const blocked = new MemoryStorage();
    blocked.getItem = () => {
      throw new Error('blocked');
    };
    blocked.setItem = () => {
      throw new Error('blocked');
    };
    const { doc } = fakeDocument({ storage: blocked });
    const theme = service(doc);
    expect(theme.preference()).toBe('system');
    theme.choose('dark');
    expect(theme.resolved()).toBe('dark');
  });

  it('ignores a stored value it does not know', () => {
    const storage = new MemoryStorage();
    storage.setItem(THEME_STORAGE_KEY, 'sepia');
    const { doc } = fakeDocument({ storage });
    expect(service(doc).preference()).toBe('system');
  });
});
