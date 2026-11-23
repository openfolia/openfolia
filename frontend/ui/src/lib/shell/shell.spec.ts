import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';

import { provideZard } from '../core/provide-zard';
import { ZardDropdownImports } from '../dropdown-menu/dropdown.imports';
import { ThemeService } from '../theme/theme.service';
import {
  ZardTabLinkComponent,
  ZardTabNavComponent,
} from '../tabs/tab-nav.component';
import { AccountMenuComponent } from './account-menu.component';
import { PageHeaderComponent } from './page-header.component';
import { PAGE_HELP, type PageHelpLink } from './page-help.component';

@Component({ template: '' })
class Blank {}

@Component({
  imports: [
    AccountMenuComponent,
    ZardDropdownImports,
    PageHeaderComponent,
    ZardTabNavComponent,
    ZardTabLinkComponent,
    RouterLink,
    RouterLinkActive,
  ],
  template: `
    <of-account-menu name="Demo User" role="Reviewer" [collapsed]="collapsed">
      <z-dropdown-menu-item id="entry">Profile</z-dropdown-menu-item>
    </of-account-menu>
    <of-page-header title="Roles and permissions">
      <button type="button" id="action">New role</button>
    </of-page-header>
    <nav z-tab-nav aria-label="Plain">
      <a z-tab-link href="#plain" id="plain">Plain</a>
    </nav>
    <nav z-tab-nav aria-label="Sections">
      <a
        z-tab-link
        routerLink="/a"
        routerLinkActive
        ariaCurrentWhenActive="page"
        >A</a
      >
      <a
        z-tab-link
        routerLink="/b"
        routerLinkActive
        ariaCurrentWhenActive="page"
        >B</a
      >
    </nav>
  `,
})
class Host {
  collapsed = false;
}

async function setup(collapsed = false) {
  TestBed.configureTestingModule({
    providers: [
      provideZard(),
      provideRouter([
        { path: 'a', component: Blank },
        { path: 'b', component: Blank },
      ]),
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.collapsed = collapsed;
  if (vi.isFakeTimers()) await settle(0);
  else await fixture.whenStable();
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

function trigger(root: HTMLElement): HTMLButtonElement {
  return root.querySelector('of-account-menu button') as HTMLButtonElement;
}

/** Runs the timers due within `ms` of the fake clock (each render's own among them). */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Runs what is due within `ms` of the fake clock (30 by default: the menu's own timers, the renders), then renders. Fake time only. */
async function settle(ms = 30) {
  await wait(ms);
  TestBed.tick();
  await wait(0);
}

async function openMenu(root: HTMLElement) {
  trigger(root).focus();
  trigger(root).click();
  await settle();
}

const menu = () =>
  document.querySelector('[role="menu"]') as HTMLElement | null;

describe('account menu', () => {
  // Fake timers: the menu and its tooltip open and close on timers that change detection, itself
  // on a timer, starts. With real ones a busy machine runs a fixed wait before those timers are
  // even set; the fake clock runs every timer due in the step, in order, however slow it is.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the initials and the name, or only the initials when collapsed', async () => {
    const { root } = await setup(false);
    const initials = trigger(root).querySelector('[aria-hidden="true"]');
    expect(initials?.textContent?.trim()).toBe('DU');
    expect(trigger(root).textContent).toContain('Demo User');
    TestBed.resetTestingModule();
    const narrow = await setup(true);
    const button = trigger(narrow.root);
    expect(button.textContent?.trim()).toBe('DU');
    expect(button.getAttribute('aria-label')).toBe('Account: Demo User');
  });

  describe('tooltip when collapsed', () => {
    const tooltip = () =>
      document.querySelector('[role="tooltip"]') as HTMLElement | null;

    it('is the Zard tooltip, not a native title, and follows keyboard focus and Escape', async () => {
      const { root } = await setup(true);
      const button = trigger(root);
      expect(button.hasAttribute('title')).toBe(false);
      button.dispatchEvent(new Event('focus'));
      await wait(250);
      expect(tooltip()?.textContent?.trim()).toBe('Demo User');
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await wait(250);
      expect(tooltip()).toBeNull();
    });

    it('is not shown on the click that opens the menu, nor while it is open', async () => {
      const { root } = await setup(true);
      const button = trigger(root);
      button.dispatchEvent(new Event('mouseenter'));
      await openMenu(root);
      await wait(300);
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(tooltip()).toBeNull();
      button.dispatchEvent(new Event('mouseenter'));
      await wait(250);
      expect(tooltip()).toBeNull();
    });

    it('is not used on the expanded button, which shows the name', async () => {
      const { root } = await setup(false);
      trigger(root).dispatchEvent(new Event('mouseenter'));
      await wait(250);
      expect(tooltip()).toBeNull();
    });
  });

  it('is a dropdown menu: opens with the name, the role, the theme choice and the entries', async () => {
    const { root } = await setup();
    const button = trigger(root);
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    // The accessible name contains the visible name (label in name).
    expect(button.getAttribute('aria-label')).toBe('Demo User');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await openMenu(root);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const text = menu()?.textContent ?? '';
    expect(text).toContain('Demo User');
    expect(text).toContain('Reviewer');
    expect(text).toContain('Profile');
    const themes = [
      ...(menu()?.querySelectorAll('[role="menuitemradio"]') ?? []),
    ].map((e) => e.textContent?.trim());
    // The theme, then the languages, each named in itself.
    expect(themes).toEqual(['Light', 'Dark', 'System', 'English', 'Deutsch']);
  });

  it('Escape closes it and returns the focus to the button', async () => {
    const { root } = await setup();
    const button = trigger(root);
    await openMenu(root);
    (document.activeElement ?? button).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    expect(menu()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('chooses the theme with the keyboard', async () => {
    const { root } = await setup();
    const theme = TestBed.inject(ThemeService);
    await openMenu(root);
    const dark = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((e) => e.textContent?.trim() === 'Dark') as HTMLElement;
    dark.click();
    await settle();
    expect(theme.preference()).toBe('dark');
    // A choice that changes the page in place keeps the menu open (the crossfade needs its icon).
    expect(menu()).toBeTruthy();
  });
});

describe('page header', () => {
  it('has the title as the page heading and the actions beside it', async () => {
    const { root } = await setup();
    const header = root.querySelector('of-page-header') as HTMLElement;
    expect(header.querySelector('h1')?.textContent?.trim()).toBe(
      'Roles and permissions',
    );
    expect(header.querySelector('#action')).toBeTruthy();
  });
});

describe('page help (#221)', () => {
  @Component({
    imports: [PageHeaderComponent],
    template: `<of-page-header title="Content" />`,
  })
  class HelpHost {}

  const render = async (
    help?: ReturnType<typeof signal<PageHelpLink | null>>,
  ) => {
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        ...(help ? [{ provide: PAGE_HELP, useValue: help }] : []),
      ],
    });
    const fixture = TestBed.createComponent(HelpHost);
    await fixture.whenStable();
    return {
      fixture,
      link: () =>
        (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(
          '[data-slot="page-help"]',
        ),
    };
  };

  it('shows no link without the app’s help', async () => {
    expect((await render()).link()).toBeNull();
  });

  it('opens the screen’s page in a new tab, and goes when the screen has none', async () => {
    const help = signal<PageHelpLink | null>({
      href: 'https://docs.example.org/guide/writing/content-browser',
      title: 'Find a module',
    });
    const { fixture, link } = await render(help);
    expect(link()?.href).toBe(
      'https://docs.example.org/guide/writing/content-browser',
    );
    expect(link()?.target).toBe('_blank');
    expect(link()?.rel).toBe('noopener noreferrer');
    expect(link()?.getAttribute('aria-label')).toBeTruthy();
    help.set(null);
    await fixture.whenStable();
    expect(link()).toBeNull();
  });
});

describe('tab nav', () => {
  it('marks the tab of the current route, by attribute and as the current page', async () => {
    const { fixture, root } = await setup();
    await TestBed.inject(Router).navigateByUrl('/b');
    await fixture.whenStable();
    const [a, b] = [
      ...root.querySelectorAll<HTMLElement>('nav[aria-label=Sections] a'),
    ];
    // A tab link without routerLinkActive works too: it is just never active.
    expect(root.querySelector('#plain')?.hasAttribute('data-active')).toBe(
      false,
    );
    expect(b?.getAttribute('aria-current')).toBe('page');
    expect(b?.hasAttribute('data-active')).toBe(true);
    expect(a?.hasAttribute('data-active')).toBe(false);
    expect(
      root
        .querySelector('nav[z-tab-nav]:last-of-type')
        ?.getAttribute('aria-label'),
    ).toBe('Sections');
  });
});
