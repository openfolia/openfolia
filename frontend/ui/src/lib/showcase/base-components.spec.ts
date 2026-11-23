import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';

import { ZardAlertDialogImports } from '../alert-dialog/alert-dialog.imports';
import { ZardButtonComponent } from '../button/button.component';
import { ZardCommandImports } from '../command/command.imports';
import { provideZard } from '../core/provide-zard';
import { ZardDialogImports } from '../dialog/dialog.imports';
import { ZardDropdownImports } from '../dropdown-menu/dropdown.imports';
import { ZardRadioGroupImports } from '../radio-group/radio-group.imports';
import { ZardSelectImports } from '../select/select.imports';
import { ZardSheetImports } from '../sheet/sheet.imports';
import { ZardSwitchComponent } from '../switch/switch.component';
import { ZardTooltipDirective } from '../tooltip/tooltip';
import { ShowcasePage } from './showcase.page';

// Fake timers: an overlay closes on a timer its change detection starts, and change detection
// itself runs on a timer. With real ones a busy machine runs a fixed wait (`settle(60)`) before
// the overlay's own timer has even been set, and the closed overlay is still there. The fake
// clock runs every timer due in the step, in order, however long the machine takes.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// jsdom has no layout: give elements a size so the CDK focus trap finds them tabbable and visible.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 10,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
    'offsetWidth'
  ];
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
    'scrollIntoView'
  ];
});

function key(target: EventTarget, name: string): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );
}

@Component({
  imports: [
    FormsModule,
    ZardButtonComponent,
    ZardDialogImports,
    ZardAlertDialogImports,
    ZardSheetImports,
    ZardSelectImports,
    ZardCommandImports,
    ZardDropdownImports,
    ZardRadioGroupImports,
    ZardSwitchComponent,
    ZardTooltipDirective,
  ],
  template: `
    <button id="open-dialog" (click)="dialog.set(true)">Open dialog</button>
    <button id="open-alert" (click)="alert.set(true)">Open alert</button>
    <button id="open-sheet" (click)="sheet.set(true)">Open sheet</button>
    <z-dialog [(zVisible)]="dialog" [zDuration]="0">
      <z-dialog-header>
        <z-dialog-title>Dialog title</z-dialog-title>
        <z-dialog-description>Dialog text</z-dialog-description>
      </z-dialog-header>
      <input id="in-dialog" aria-label="Field" />
      <z-dialog-footer>
        <button z-button id="dialog-ok" z-dialog-close>Close</button>
      </z-dialog-footer>
    </z-dialog>
    <z-alert-dialog [(zVisible)]="alert" [zDuration]="0">
      <z-alert-dialog-header>
        <z-alert-dialog-title>Alert title</z-alert-dialog-title>
        <z-alert-dialog-description>Alert text</z-alert-dialog-description>
      </z-alert-dialog-header>
      <z-alert-dialog-footer>
        <button z-button z-alert-dialog-close>Cancel</button>
      </z-alert-dialog-footer>
    </z-alert-dialog>
    <z-sheet [(zVisible)]="sheet" [zDuration]="0">
      <z-sheet-header>
        <z-sheet-title>Sheet title</z-sheet-title>
        <z-sheet-description>Sheet text</z-sheet-description>
      </z-sheet-header>
      <z-sheet-footer
        ><button z-button z-sheet-close>Done</button></z-sheet-footer
      >
    </z-sheet>

    <z-select
      id="select"
      zAriaLabel="Size"
      zPlaceholder="Pick"
      [(zValue)]="size"
    >
      <z-select-item zValue="small">Small</z-select-item>
      <z-select-item zValue="medium">Medium</z-select-item>
      <z-select-item zValue="large">Large</z-select-item>
    </z-select>

    <z-select
      id="audience"
      zAriaLabel="Audience"
      zPlaceholder="Every audience"
      [(zValue)]="audience"
    >
      <z-select-item zValue="">Every audience</z-select-item>
      <z-select-item zValue="internal">Internal</z-select-item>
    </z-select>

    <z-select id="searchable" zSearchable zAriaLabel="City" [(zValue)]="city">
      <z-select-item zValue="Zürich">Zürich</z-select-item>
      <z-select-item zValue="Zagreb">Zagreb</z-select-item>
      <z-select-item zValue="Oslo">Oslo</z-select-item>
      <z-select-item zValue="Málaga">Málaga</z-select-item>
    </z-select>

    <z-command id="command" (zCommandSelected)="chosen.set($event.label)">
      <z-command-input placeholder="Search" />
      <z-command-list>
        <z-command-option zValue="a" zLabel="Alpha" />
        <z-command-option zValue="b" zLabel="Beta" />
        <z-command-option zValue="c" zLabel="Gamma" />
      </z-command-list>
    </z-command>

    <button id="menu-trigger" z-dropdown [zDropdownMenu]="menu">Menu</button>
    <z-dropdown-menu-content #menu>
      <z-dropdown-menu-item (click)="picked.set('one')"
        >One</z-dropdown-menu-item
      >
      <z-dropdown-menu-item (click)="picked.set('two')"
        >Two</z-dropdown-menu-item
      >
    </z-dropdown-menu-content>

    <z-radio-group id="radios" aria-label="Pick one" [(ngModel)]="radio">
      <z-radio value="a" zId="ra" />
      <z-radio value="b" zId="rb" />
      <z-radio value="c" zId="rc" />
    </z-radio-group>

    <z-switch id="switch" [(zChecked)]="on">Notes</z-switch>

    <button
      id="tip"
      z-button
      aria-disabled="true"
      zTooltip="Blocked while checks fail."
    >
      Blocked
    </button>
  `,
})
class Host {
  readonly dialog = signal(false);
  readonly alert = signal(false);
  readonly sheet = signal(false);
  readonly size = signal<string | string[]>('');
  readonly city = signal<string | string[]>('');
  readonly audience = signal<string | string[]>('internal');
  readonly chosen = signal('');
  readonly picked = signal('');
  radio = 'a';
  readonly on = signal(false);
}

async function setup() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(Host);
  /** Runs the timers due within `ms` of the fake clock (each render's own among them), then renders. */
  const settle = async (ms = 30) => {
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
  };
  await settle(0);
  const root = fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(selector: string) =>
    document.querySelector<T>(selector) as T;
  return { fixture, host: fixture.componentInstance, root, q, settle };
}

describe('overlays: dialog, alert dialog, sheet', () => {
  for (const [name, openId, role] of [
    ['dialog', 'open-dialog', 'Dialog title'],
    ['alert dialog', 'open-alert', 'Alert title'],
    ['sheet', 'open-sheet', 'Sheet title'],
  ] as const) {
    it(`${name}: is a labelled modal, keeps the focus inside, closes with Escape and gives the focus back`, async () => {
      const { q, settle } = await setup();
      const opener = q<HTMLButtonElement>('#' + openId);
      opener.focus();
      opener.click();
      await settle();
      const panel = document.querySelector(
        '.cdk-overlay-container [role="dialog"], .cdk-overlay-container [role="alertdialog"]',
      ) as HTMLElement;
      expect(panel).toBeTruthy();
      expect(panel.getAttribute('aria-modal')).toBe('true');
      const label = document.getElementById(
        panel.getAttribute('aria-labelledby') ?? 'none',
      );
      expect(label?.textContent?.trim()).toBe(role);
      expect(panel.contains(document.activeElement)).toBe(true);

      key(document.activeElement ?? document.body, 'Escape');
      await settle(60);
      expect(
        document.querySelector(
          '.cdk-overlay-container [role="dialog"], .cdk-overlay-container [role="alertdialog"]',
        ),
      ).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  }

  it('closes from its own close control', async () => {
    const { q, settle } = await setup();
    q<HTMLButtonElement>('#open-dialog').click();
    await settle();
    q<HTMLButtonElement>('#dialog-ok').click();
    await settle(60);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('stacks: one Escape closes only the top overlay', async () => {
    const { host, q, settle } = await setup();
    host.sheet.set(true);
    await settle();
    host.dialog.set(true);
    await settle();
    key(q<HTMLInputElement>('#in-dialog'), 'Escape');
    await settle(60);
    expect(host.dialog()).toBe(false);
    expect(host.sheet()).toBe(true);
  });
});

describe('select', () => {
  it('works without a mouse: Enter opens, arrows move, Enter chooses, Escape closes', async () => {
    const { host, q, settle } = await setup();
    const trigger = q<HTMLButtonElement>('#select button[role="combobox"]');
    expect(trigger.getAttribute('aria-label')).toBe('Size: Pick');
    trigger.focus();
    key(trigger, 'Enter');
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const options = [
      ...document.querySelectorAll<HTMLElement>(
        '.cdk-overlay-container [role="option"]',
      ),
    ];
    expect(options.length).toBe(3);
    expect(document.activeElement).toBe(options[0]);
    key(document.activeElement as HTMLElement, 'ArrowDown');
    key(document.activeElement as HTMLElement, 'Enter');
    await settle();
    expect(host.size()).toBe('medium');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label')).toBe('Size: Medium');

    key(trigger, 'ArrowDown');
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    key(document.activeElement as HTMLElement, 'Escape');
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(host.size()).toBe('medium');
  });

  it('chooses an option whose value is empty (a "none" or "every" choice)', async () => {
    const { host, q, settle } = await setup();
    const trigger = q<HTMLButtonElement>('#audience button[role="combobox"]');
    expect(trigger.getAttribute('aria-label')).toBe('Audience: Internal');
    trigger.click();
    await settle();
    const every = [
      ...document.querySelectorAll<HTMLElement>(
        '.cdk-overlay-container [role="option"]',
      ),
    ].find((o) => o.textContent?.trim() === 'Every audience');
    every?.click();
    await settle();
    expect(host.audience()).toBe('');
    expect(trigger.getAttribute('aria-label')).toBe('Audience: Every audience');
  });
});

describe('command', () => {
  it('filters as you type and chooses with the keyboard', async () => {
    const { host, q, settle } = await setup();
    const input = q<HTMLInputElement>('#command input');
    input.focus();
    input.value = 'ga';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    const visible = [...document.querySelectorAll('#command [role="option"]')];
    expect(visible.map((o) => o.textContent?.trim())).toEqual(['Gamma']);
    key(input, 'Enter');
    await settle();
    expect(host.chosen()).toBe('Gamma');
  });

  it('moves the highlight with the arrow keys and says when nothing matches', async () => {
    const { q, settle } = await setup();
    const input = q<HTMLInputElement>('#command input');
    input.focus();
    await settle();
    const selected = () =>
      document
        .querySelector('#command [role="option"][aria-selected="true"]')
        ?.textContent?.trim();
    expect(selected()).toBe('Alpha');
    key(input, 'ArrowDown');
    await settle();
    expect(selected()).toBe('Beta');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(q('#command [data-slot="command-empty"]').textContent).toContain(
      'No results',
    );
  });

  it('gives each command its own ids', async () => {
    const { q } = await setup();
    const input = q('#command input');
    const listId = input.getAttribute('aria-controls');
    expect(listId).toMatch(/^z-command-\d+-list$/);
    expect(document.getElementById(listId ?? '')).toBeTruthy();
  });
});

describe('dropdown menu', () => {
  it('opens from the keyboard, moves with arrows, chooses and returns the focus', async () => {
    const { host, q, settle } = await setup();
    const trigger = q<HTMLButtonElement>('#menu-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    trigger.focus();
    key(trigger, 'Enter');
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        '.cdk-overlay-container [role="menuitem"]',
      ),
    ];
    expect(items.length).toBe(2);
    key(document.activeElement as HTMLElement, 'ArrowDown');
    key(document.activeElement as HTMLElement, 'ArrowDown');
    await settle();
    key(document.activeElement as HTMLElement, 'Enter');
    await settle();
    expect(host.picked()).toBe('two');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes with Escape and gives the focus back to the trigger', async () => {
    const { q, settle } = await setup();
    const trigger = q<HTMLButtonElement>('#menu-trigger');
    trigger.focus();
    key(trigger, 'ArrowDown');
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
    key(document.activeElement as HTMLElement, 'Escape');
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('radio group and switch', () => {
  it('moves and selects with the arrow keys; the group is one tab stop', async () => {
    const { fixture, host, q, settle } = await setup();
    const a = q<HTMLButtonElement>('#ra');
    expect(a.getAttribute('aria-checked')).toBe('true');
    a.focus();
    key(a, 'ArrowDown');
    await settle();
    fixture.detectChanges();
    expect(host.radio).toBe('b');
    expect(document.activeElement).toBe(q('#rb'));
    key(q('#rb'), 'ArrowUp');
    await settle();
    expect(host.radio).toBe('a');
    expect(q('#radios').getAttribute('role')).toBe('radiogroup');
  });

  it('a switch is a labelled switch and toggles with the keyboard', async () => {
    const { host, q, settle } = await setup();
    const sw = q<HTMLButtonElement>('#switch button[role="switch"]');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(
      document.querySelector(`label[for="${sw.id}"]`)?.textContent?.trim(),
    ).toBe('Notes');
    sw.click();
    await settle();
    expect(host.on()).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});

describe('tooltip', () => {
  it('shows on keyboard focus, not only on hover, and describes the control', async () => {
    const { q, settle } = await setup();
    const button = q<HTMLButtonElement>('#tip');
    button.focus();
    await settle(400);
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain('Blocked while checks fail.');
    expect(button.getAttribute('aria-describedby')).toBe(tip?.id);
    key(button, 'Escape');
    await settle(400);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe('showcase page', () => {
  it('shows every base component, each section labelled', async () => {
    TestBed.configureTestingModule({ providers: [provideZard()] });
    const fixture = TestBed.createComponent(ShowcasePage);
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    const headings = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('h2'),
    ].map((h) => h.textContent?.trim());
    for (const name of [
      'Table',
      'Input and textarea',
      'Select',
      'Checkbox, radio group and switch',
      'Dialog, alert dialog and sheet',
      'Command',
      'Popover',
      'Tooltip',
      'Dropdown menu',
    ]) {
      expect(headings).toContain(name);
    }
  });
});

describe('searchable select', () => {
  const open = async () => {
    const ctx = await setup();
    const trigger = ctx.q<HTMLButtonElement>(
      '#searchable button[role="combobox"]',
    );
    trigger.focus();
    key(trigger, 'Enter');
    await ctx.settle();
    const input = document.querySelector<HTMLInputElement>(
      '.cdk-overlay-container [data-slot="select-search-input"]',
    ) as HTMLInputElement;
    const visible = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '.cdk-overlay-container [role="option"]',
        ),
      ]
        .filter((o) => !o.hasAttribute('hidden'))
        .map((o) => o.textContent?.trim());
    const type = async (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await ctx.settle();
    };
    return { ...ctx, trigger, input, visible, type };
  };

  it('is a combobox with a listbox and the focus in the search field', async () => {
    const { input, trigger } = await open();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe(
      document
        .querySelector('.cdk-overlay-container [role="listbox"]')
        ?.getAttribute('id'),
    );
    expect(document.activeElement).toBe(input);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('filters ignoring case and diacritics, with an empty state', async () => {
    const { visible, type } = await open();
    expect(visible()).toHaveLength(4);
    await type('zur');
    expect(visible()).toEqual(['Zürich']);
    await type('MALAGA');
    expect(visible()).toEqual(['Málaga']);
    await type('z');
    expect(visible()).toEqual(['Zürich', 'Zagreb']);
    await type('nothing');
    expect(visible()).toEqual([]);
    expect(
      document.querySelector('[data-slot="select-empty"]')?.textContent,
    ).toContain('No results');
  });

  it('moves through the filtered options with the arrows, Enter chooses and the focus returns', async () => {
    const { host, input, type, trigger, settle } = await open();
    await type('z');
    expect(input.getAttribute('aria-activedescendant')).toBe(
      document.querySelectorAll('.cdk-overlay-container [role="option"]')[0]
        ?.id,
    );
    const activeText = () =>
      document
        .getElementById(input.getAttribute('aria-activedescendant') ?? '')
        ?.textContent?.trim();
    expect(activeText()).toBe('Zürich');
    key(input, 'ArrowDown');
    await settle();
    expect(activeText()).toBe('Zagreb');
    key(input, 'Enter');
    await settle();
    expect(host.city()).toBe('Zagreb');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes with Escape and returns the focus to the trigger', async () => {
    const { input, trigger, settle } = await open();
    key(input, 'Escape');
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
