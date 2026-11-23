import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { provideZard } from '@openfolia/ui/core';
import { throwError } from 'rxjs';

import { ApiClient } from '../api';
import type { ProjectConfig } from '../content/browser-model';
import type { ImageChoice } from '../doc-editor/blocks/doc-blocks-context';
import { InsertImageDialogComponent } from '../images/insert-image-dialog.component';
import { CoverImageSettingsComponent } from './cover-image-settings.component';
import { ManualDraft, type DraftMode } from './manual-draft';
import type { Issue, ManualSettings, SettingsPatch } from './manual-settings';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;

const CONFIG = {
  languages: { source: 'en', targets: ['de'] },
  audiences: [],
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
  ],
  textAttributes: [],
} as unknown as ProjectConfig;

class FakeDraft {
  readonly settings = signal<ManualSettings | null>({
    variants: [{ market: 'eu' }, { market: 'us' }],
    attributes: {},
  });
  readonly mode = signal<DraftMode>({ kind: 'edit' });
  readonly issues = signal<readonly Issue[]>([]);
  readonly manual = signal({ id: 'guide' });
  scope(): string {
    return 'guide\ncs1';
  }
  readonly patches: SettingsPatch[] = [];
  changeSettings(patch: SettingsPatch): void {
    this.patches.push(patch);
    this.settings.update((s) => (s ? { ...s, ...patch } : s));
  }
}

@Component({
  imports: [CoverImageSettingsComponent],
  template: `
    <of-cover-image-settings
      [config]="config"
      [editable]="editable()"
      changeSetId="cs1"
    />
  `,
})
class HostComponent {
  readonly config = CONFIG;
  readonly editable = signal(true);
}

async function setup() {
  const draft = new FakeDraft();
  TestBed.configureTestingModule({
    providers: [
      provideZard(),
      { provide: ManualDraft, useValue: draft },
      // Thumbnails are not read here.
      { provide: ApiClient, useValue: { get: () => throwError(() => 1) } },
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
  const picks: (ImageChoice | null)[] = [];
  /** The image dialog answers with the next of `picks`. */
  const dialog = fixture.debugElement.query(
    By.directive(InsertImageDialogComponent),
  ).componentInstance as InsertImageDialogComponent;
  dialog.open = async () => picks.shift() ?? null;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    el.querySelector<T>(selector) as T;
  const row = (key: string) => q(`[data-cover="${key}"]`);
  const type = async (
    input: HTMLInputElement,
    value: string,
    change = true,
  ) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    if (change) input.dispatchEvent(new Event('change'));
    await settle();
  };
  const pick = (asset: string) =>
    picks.push({ asset, alt: '', caption: '', width: null });
  return { fixture, el, draft, settle, q, row, type, pick };
}

describe('CoverImageSettingsComponent (#394)', () => {
  afterEach(() => document.body.replaceChildren());

  it('lists the manual and each variant, each showing the design’s image without one', async () => {
    const { row, el } = await setup();
    expect(row('manual').textContent).toContain('All variants');
    expect(row('variant-0').textContent).toContain('EU');
    expect(row('variant-1').textContent).toContain('US');
    expect(
      [...el.querySelectorAll('[data-testid="cover-status"]')].map((s) =>
        s.textContent?.trim(),
      ),
    ).toEqual([
      "The design's image, if any",
      "The design's image, if any",
      "The design's image, if any",
    ]);
  });

  it('waits for the alternative text before saving a chosen image', async () => {
    const { row, draft, settle, type, pick } = await setup();
    pick(A);
    row('manual')
      .querySelector<HTMLButtonElement>('[data-testid="cover-choose"]')
      ?.click();
    await settle();
    const use = row('manual').querySelector<HTMLButtonElement>(
      '[data-testid="cover-use"]',
    ) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    expect(draft.patches).toEqual([]);
    await type(
      row('manual').querySelector(
        '[data-testid="cover-alt-new"]',
      ) as HTMLInputElement,
      '  The   lifter ',
      false,
    );
    expect(use.disabled).toBe(false);
    use.click();
    await settle();
    expect(draft.patches).toEqual([
      {
        coverImage: {
          default: { asset: A, alt: { en: 'The lifter' } },
          variants: [],
        },
      },
    ]);
    expect(row('variant-0').textContent).toContain("The manual's image");
  });

  it('gives a variant its own, keeps texts on a change, and refuses an empty source text', async () => {
    const { row, draft, settle, type, pick } = await setup();
    draft.settings.update(
      (s) =>
        s && {
          ...s,
          coverImage: {
            default: { asset: A, alt: { en: 'Lifter' } },
            variants: [],
          },
        },
    );
    await settle();
    pick(B);
    row('variant-1')
      .querySelector<HTMLButtonElement>('[data-testid="cover-choose"]')
      ?.click();
    await settle();
    await type(
      row('variant-1').querySelector(
        '[data-testid="cover-alt-new"]',
      ) as HTMLInputElement,
      'US lifter',
      false,
    );
    row('variant-1')
      .querySelector<HTMLButtonElement>('[data-testid="cover-use"]')
      ?.click();
    await settle();
    expect(draft.settings()?.coverImage?.variants).toEqual([
      { variant: { market: 'us' }, asset: B, alt: { en: 'US lifter' } },
    ]);

    // A pick waiting for its text outlives a save of another field.
    pick(A);
    row('variant-0')
      .querySelector<HTMLButtonElement>('[data-testid="cover-choose"]')
      ?.click();
    await settle();
    draft.manual.set({ id: 'guide' });
    draft.changeSettings({ audience: 'public' });
    await settle();
    expect(
      row('variant-0').querySelector('[data-testid="cover-pending"]'),
    ).not.toBeNull();

    // Changing the manual's image keeps its text.
    pick(B);
    row('manual')
      .querySelector<HTMLButtonElement>('[data-testid="cover-choose"]')
      ?.click();
    await settle();
    expect(draft.settings()?.coverImage?.default).toEqual({
      asset: B,
      alt: { en: 'Lifter' },
    });

    const before = draft.patches.length;
    const en = row('manual').querySelector(
      '[data-alt="en"]',
    ) as HTMLInputElement;
    await type(en, '');
    expect(draft.patches.length).toBe(before);
    expect(
      (row('manual').querySelector('[data-alt="en"]') as HTMLInputElement)
        .value,
    ).toBe('Lifter');
    expect(
      row('manual').querySelector('[data-testid="cover-alt-error"]'),
    ).not.toBeNull();

    await type(
      row('manual').querySelector('[data-alt="de"]') as HTMLInputElement,
      'Heber',
    );
    expect(draft.settings()?.coverImage?.default?.alt).toEqual({
      en: 'Lifter',
      de: 'Heber',
    });
  });

  it('takes one away, and with none left names none', async () => {
    const { row, draft, settle } = await setup();
    draft.settings.update(
      (s) =>
        s && {
          ...s,
          coverImage: { default: { asset: A, alt: 'Lifter' }, variants: [] },
        },
    );
    await settle();
    row('manual')
      .querySelector<HTMLButtonElement>('[data-testid="cover-remove"]')
      ?.click();
    await settle();
    expect(draft.patches.at(-1)).toEqual({ coverImage: undefined });
  });

  it('names a variant’s own image that is never shown, and takes it away', async () => {
    const { draft, settle, el } = await setup();
    draft.settings.update(
      (s) =>
        s && {
          ...s,
          coverImage: {
            variants: [
              { variant: { market: 'us' }, asset: A, alt: 'US' },
              { variant: { market: 'cn' }, asset: B, alt: 'CN' },
            ],
          },
        },
    );
    await settle();
    const unshown = el.querySelector('[data-testid="cover-unshown"]');
    expect(unshown?.querySelectorAll('li')).toHaveLength(1);
    unshown
      ?.querySelector<HTMLButtonElement>('[data-testid="cover-unshown-remove"]')
      ?.click();
    await settle();
    expect(draft.settings()?.coverImage?.variants).toEqual([
      { variant: { market: 'us' }, asset: A, alt: 'US' },
    ]);
    expect(el.querySelector('[data-testid="cover-unshown"]')).toBeNull();
  });

  it('shows the images and texts read-only, with nothing to change', async () => {
    const { row, draft, settle, fixture, el } = await setup();
    draft.settings.update(
      (s) =>
        s && {
          ...s,
          coverImage: {
            default: { asset: A, alt: { en: 'Lifter', de: 'Heber' } },
            variants: [],
          },
        },
    );
    fixture.componentInstance.editable.set(false);
    await settle();
    expect(el.querySelector('[data-testid="cover-choose"]')).toBeNull();
    expect(el.querySelector('input')).toBeNull();
    expect(
      row('manual').querySelector('[data-alt="de"]')?.textContent,
    ).toContain('German: Heber');
  });
});
