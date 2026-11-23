import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';
import { of } from 'rxjs';

import { ApiClient } from '../api';
import type { ProjectConfig } from '../content/browser-model';
import type { VariantPick } from '../doc-editor/blocks/doc-blocks-context';
import { ManualDraft, type DraftMode } from './manual-draft';
import {
  ManualSettingsPanelComponent,
  type PickCondition,
} from './manual-settings-panel.component';
import type {
  Condition,
  Issue,
  ManualSettings,
  SettingsPatch,
} from './manual-settings';

const CONFIG = {
  languages: { source: 'en', targets: [] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [
    {
      id: 'market',
      label: 'Market',
      kind: 'enum',
      values: [
        { id: 'eu', label: 'EU' },
        { id: 'us', label: 'US' },
      ],
    },
    { id: 'software', label: 'Software', kind: 'version' },
  ],
  textAttributes: [
    { id: 'product', label: 'Product name' },
    { id: 'plug', label: 'Plug type' },
  ],
  pdf: { design: 'house' },
} as unknown as ProjectConfig;

/** `GET /page-designs`: two designs, and a file that is no design (not offered). */
const DESIGNS = {
  data: [
    { type: 'PageDesign', id: 'house', attributes: { name: 'House style' } },
    { type: 'PageDesign', id: 'service', attributes: { name: 'Service' } },
    { type: 'PageDesign', id: 'broken', meta: { error: 'Not a design.' } },
  ],
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 200, total: 3 } },
};

const EU: Condition = { op: 'in', attr: 'market', values: ['eu'] };

/** The draft as the panel reads and changes it: changes apply at once, like an eager save. */
class FakeDraft {
  readonly settings = signal<ManualSettings | null>({
    variants: [{ market: 'eu' }],
    attributes: { product: 'Lifter' },
  });
  readonly mode = signal<DraftMode>({ kind: 'edit' });
  readonly issues = signal<readonly Issue[]>([]);
  readonly manual = signal({ id: 'guide' });
  /** The manual and change set it edits (`ManualDraft.scope`). */
  current = 'guide\ncs1';
  scope(): string {
    return this.current;
  }
  readonly patches: SettingsPatch[] = [];
  changeSettings(patch: SettingsPatch): void {
    this.patches.push(patch);
    this.settings.update((s) => (s ? { ...s, ...patch } : s));
  }
}

@Component({
  imports: [ManualSettingsPanelComponent],
  template: `
    <of-manual-settings-panel
      [config]="config"
      [blockedReason]="blocked()"
      [pickCondition]="pick"
    />
  `,
})
class HostComponent {
  readonly config = CONFIG;
  readonly blocked = signal<string | null>(null);
  next: VariantPick | null = null;
  readonly asked: (Condition | null)[] = [];
  readonly pick: PickCondition = async (current) => {
    this.asked.push(current);
    return this.next;
  };
}

async function setup() {
  const draft = new FakeDraft();
  TestBed.configureTestingModule({
    providers: [
      provideZard(),
      { provide: ManualDraft, useValue: draft },
      { provide: ApiClient, useValue: { get: () => of(DESIGNS) } },
    ],
  });
  const fixture = TestBed.createComponent(HostComponent);
  const el = fixture.nativeElement as HTMLElement;
  document.body.appendChild(el);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  await settle();
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    el.querySelector<T>(selector) as T;
  const click = async (selector: string) => {
    q(selector).click();
    await settle();
  };
  /** Opens the select under `scope` and chooses the option reading `text`. */
  const choose = async (scope: string, text: string) => {
    q(`${scope} button`).click();
    await settle();
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('z-select-item'),
    ).find((o) => o.textContent?.trim() === text);
    option?.click();
    await settle();
  };
  return {
    fixture,
    el,
    draft,
    settle,
    q,
    click,
    choose,
    host: fixture.componentInstance,
  };
}

describe('ManualSettingsPanelComponent', () => {
  it('chooses the manual’s own page design, and the project default again (#589)', async () => {
    const t = await setup();
    const select = '[data-testid=settings-design]';
    expect(t.q(`${select} button`).textContent).toContain(
      'Project default (House style)',
    );
    await t.choose(select, 'Service');
    expect(t.draft.patches.at(-1)).toEqual({ design: 'service' });
    expect(t.q(`${select} button`).textContent).toContain('Service');
    await t.choose(select, 'Project default (House style)');
    expect(t.draft.patches.at(-1)).toEqual({ design: undefined });
    // A file that is no design is not offered.
    t.q(`${select} button`).click();
    await t.settle();
    const offered = Array.from(
      document.querySelectorAll<HTMLElement>('z-select-item'),
    ).map((o) => o.textContent?.trim());
    expect(offered).toEqual([
      'Project default (House style)',
      'House style',
      'Service',
    ]);
  });

  it('warns of a design of its own that is not in the revision (#589)', async () => {
    const t = await setup();
    t.draft.settings.update((s) => (s ? { ...s, design: 'gone' } : s));
    await t.settle();
    expect(t.q('[data-testid=settings-design-missing]').textContent).toContain(
      'gone',
    );
  });

  it('sets the audience from the configured levels, and clears it', async () => {
    const t = await setup();
    await t.choose('[data-testid=settings-audience]', 'Internal');
    expect(t.draft.patches.at(-1)).toEqual({ audience: 'internal' });
    await t.choose(
      '[data-testid=settings-audience]',
      'Not set (every audience)',
    );
    expect(t.draft.patches.at(-1)).toEqual({ audience: undefined });
  });

  it('adds a variant build not listed yet, and refuses a duplicate', async () => {
    const t = await setup();
    await t.click('[data-testid=variant-add]');
    // The first free combination is offered.
    await t.click('[data-testid=variant-new] [data-testid=variant-save]');
    expect(t.draft.patches.at(-1)).toEqual({
      variants: [{ market: 'eu' }, { market: 'us' }],
    });
    expect(t.el.querySelectorAll('[data-build]')).toHaveLength(2);
    // Editing the second into the first is a duplicate: said beside the field, nothing saved.
    t.q<HTMLButtonElement>(
      '[data-build="1"] [data-testid=variant-edit]',
    ).click();
    await t.settle();
    await t.choose('[data-build="1"] [data-attr=market]', 'EU');
    expect(
      t.q('[data-build="1"] [data-testid=variant-form-error]').textContent,
    ).toContain('EU is already a variant build');
    const count = t.draft.patches.length;
    t.q<HTMLFormElement>('[data-build="1"] form').dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await t.settle();
    expect(t.draft.patches).toHaveLength(count);
    // A version set as well makes it another combination.
    const version = t.q<HTMLInputElement>(
      '[data-build="1"] input[data-attr=software]',
    );
    version.value = '2.3';
    version.dispatchEvent(new Event('input'));
    await t.settle();
    expect(t.el.querySelector('[data-testid=variant-form-error]')).toBeNull();
    t.q<HTMLFormElement>('[data-build="1"] form').dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await t.settle();
    expect(t.draft.patches.at(-1)).toEqual({
      variants: [{ market: 'eu' }, { market: 'eu', software: '2.3' }],
    });
  });

  it('removes a variant build with an undo, and keeps the last one', async () => {
    const t = await setup();
    t.draft.settings.set({
      variants: [{ market: 'eu' }, { market: 'us' }],
      attributes: {},
    });
    await t.settle();
    await t.click('[data-build="0"] [data-testid=variant-remove]');
    expect(t.draft.settings()?.variants).toEqual([{ market: 'us' }]);
    expect(
      t
        .q('[data-build="0"] [data-testid=variant-remove]')
        .getAttribute('aria-disabled'),
    ).toBe('true');
    const toast = TestBed.inject(ToastService);
    const shown = toast.toasts().at(-1);
    expect(shown).toBeDefined();
    toast.runAction(shown?.id ?? -1);
    await t.settle();
    expect(t.draft.settings()?.variants).toEqual([
      { market: 'eu' },
      { market: 'us' },
    ]);
  });

  it('lets a variant’s own cover image follow it when it changes or goes, and come back with the undo (#394)', async () => {
    const t = await setup();
    const image = { asset: `sha256:${'a'.repeat(64)}`, alt: 'US' };
    t.draft.settings.set({
      variants: [{ market: 'eu' }, { market: 'us' }],
      attributes: {},
      coverImage: { variants: [{ variant: { market: 'us' }, ...image }] },
    });
    await t.settle();
    t.q<HTMLButtonElement>(
      '[data-build="1"] [data-testid=variant-edit]',
    ).click();
    await t.settle();
    const version = t.q<HTMLInputElement>(
      '[data-build="1"] input[data-attr=software]',
    );
    version.value = '2.3';
    version.dispatchEvent(new Event('input'));
    await t.settle();
    t.q<HTMLFormElement>('[data-build="1"] form').dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await t.settle();
    const moved = { market: 'us', software: '2.3' };
    expect(t.draft.settings()?.coverImage?.variants).toEqual([
      { variant: moved, ...image },
    ]);
    await t.click('[data-build="1"] [data-testid=variant-remove]');
    expect(t.draft.settings()?.coverImage).toBeUndefined();
    const toast = TestBed.inject(ToastService);
    toast.runAction(toast.toasts().at(-1)?.id ?? -1);
    await t.settle();
    expect(t.draft.settings()?.coverImage?.variants).toEqual([
      { variant: moved, ...image },
    ]);
  });

  it('closes an open form when the combinations change under it', async () => {
    const t = await setup();
    t.draft.settings.set({
      variants: [{ market: 'eu' }, { market: 'us' }, { software: '2.0' }],
      attributes: {},
    });
    await t.settle();
    await t.click('[data-build="1"] [data-testid=variant-edit]');
    expect(t.el.querySelector('[data-testid=variant-form]')).not.toBeNull();
    await t.click('[data-build="0"] [data-testid=variant-remove]');
    // Nothing left to save over another combination.
    expect(t.el.querySelector('[data-testid=variant-form]')).toBeNull();
    expect(t.draft.settings()?.variants).toEqual([
      { market: 'us' },
      { software: '2.0' },
    ]);
  });

  it('keeps an open form when another setting changes', async () => {
    const t = await setup();
    await t.click('[data-testid=variant-add]');
    t.draft.changeSettings({ audience: 'public' });
    t.draft.changeSettings({ attributes: { product: 'Other' } });
    await t.settle();
    expect(t.el.querySelector('[data-testid=variant-form]')).not.toBeNull();
  });

  it('closes the form on Escape', async () => {
    const t = await setup();
    await t.click('[data-testid=variant-add]');
    t.q('[data-testid=variant-form]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await t.settle();
    expect(t.el.querySelector('[data-testid=variant-form]')).toBeNull();
  });

  it('undoes nothing once another change set is read', async () => {
    const t = await setup();
    t.draft.settings.set({
      variants: [{ market: 'eu' }, { market: 'us' }],
      attributes: {},
    });
    await t.settle();
    await t.click('[data-build="0"] [data-testid=variant-remove]');
    t.draft.current = 'guide\ncs2';
    const toast = TestBed.inject(ToastService);
    toast.runAction(toast.toasts().at(-1)?.id ?? -1);
    await t.settle();
    expect(t.draft.settings()?.variants).toEqual([{ market: 'us' }]);
  });

  it('lists unset text attributes, sets a value and one for some variants', async () => {
    const t = await setup();
    const plug = '[data-attribute=plug]';
    expect(
      t.q(`${plug} [data-testid=attribute-not-set]`).textContent,
    ).toContain('Not set');
    await t.click(`${plug} [data-testid=attribute-add-value]`);
    const field = t.q<HTMLInputElement>(
      `${plug} [data-testid=attribute-new-value]`,
    );
    expect(document.activeElement).toBe(field);
    // Enter on nothing says what is missing.
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await t.settle();
    expect(t.q(`${plug} [aria-live]`).textContent).toContain('Enter a value');
    field.value = ' Type  E ';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await t.settle();
    expect(t.draft.settings()?.attributes).toEqual({
      product: 'Lifter',
      plug: 'Type E',
    });
    // The product name only for the EU: chosen in the variant picker.
    t.host.next = EU;
    await t.click(
      '[data-attribute=product] [data-testid=option-condition-pick]',
    );
    expect(t.host.asked).toEqual([null]);
    expect(t.draft.settings()?.attributes['product']).toEqual([
      { value: 'Lifter', when: EU },
    ]);
    expect(
      t.q('[data-attribute=product] [data-testid=option-condition]')
        .textContent,
    ).toContain('Market: EU');
    // A value after one for every variant is never used, and says so.
    await t.click(`${plug} [data-testid=attribute-add-value]`);
    const second = t.q<HTMLInputElement>(
      `${plug} [data-testid=attribute-new-value]`,
    );
    second.value = 'Type F';
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await t.settle();
    expect(
      t.el.querySelectorAll(`${plug} [data-testid=option-unused]`),
    ).toHaveLength(1);
    // Removing its only value leaves it not set.
    await t.click('[data-attribute=product] [data-testid=option-remove]');
    expect('product' in (t.draft.settings()?.attributes ?? {})).toBe(false);
  });

  it('edits a value in place; an emptied one comes back', async () => {
    const t = await setup();
    const field = t.q<HTMLInputElement>(
      '[data-attribute=product] [data-testid=attribute-value]',
    );
    field.value = '';
    field.dispatchEvent(new Event('change'));
    await t.settle();
    expect(field.value).toBe('Lifter');
    expect(t.draft.patches).toHaveLength(0);
    field.value = 'Lifter Pro';
    field.dispatchEvent(new Event('change'));
    await t.settle();
    expect(t.draft.settings()?.attributes['product']).toBe('Lifter Pro');
  });

  it('shows the content model’s issues beside the field they are about', async () => {
    const t = await setup();
    t.draft.issues.set([
      {
        severity: 'error',
        code: 'unknown-variant-value',
        message: '"asia" is not a value of variant attribute "market"',
        at: 'variant 1',
      },
      {
        severity: 'error',
        code: 'unknown-audience',
        message: 'audience "x" is not configured',
      },
    ]);
    await t.settle();
    expect(
      t.q('[data-build="0"] [data-testid=settings-issue]').textContent,
    ).toContain('Unknown variant value');
    expect(
      t.q(
        'section[aria-labelledby=settings-audience] [data-testid=settings-issue]',
      ).textContent,
    ).toContain('Unknown audience');
  });

  it('is read-only with the reason when the manual can’t be changed', async () => {
    const t = await setup();
    t.draft.mode.set({
      kind: 'read',
      reason: 'editor.manuals.blocked.notDraft',
    });
    t.fixture.componentInstance.blocked.set('editor.manuals.blocked.notDraft');
    await t.settle();
    expect(t.q('[data-testid=settings-read-only]')).not.toBeNull();
    expect(t.el.querySelector('[data-testid=variant-add]')).toBeNull();
    expect(t.el.querySelector('input')).toBeNull();
    expect(t.q('[data-testid=settings-audience]').textContent).toContain(
      'Not set',
    );
  });
});
