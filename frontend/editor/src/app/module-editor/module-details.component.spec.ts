import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import type { ProjectConfig } from '../content/browser-model';
import type { Deprecation } from '../content/deprecate-dialog.component';
import {
  ModuleDetailsComponent,
  type UsedInRow,
} from './module-details.component';

const config = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
  ],
  audiences: [],
  facets: [],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
  maxHeadingLevel: 3,
  codeLanguages: [],
} as unknown as ProjectConfig;

@Component({
  imports: [ModuleDetailsComponent],
  template: `<of-module-details
    [meta]="meta"
    moduleId="charging"
    [config]="config"
    [usedIn]="usedIn()"
    [deprecation]="deprecation()"
  />`,
})
class Host {
  readonly meta = {
    title: 'Charging',
    type: 'concept',
    lang: 'en',
    facets: {},
  };
  readonly config = config;
  readonly usedIn = signal<readonly UsedInRow[] | null>([
    { id: 'operating', title: 'Operating manual' },
    { id: 'old', title: 'Old manual', deprecated: true },
  ]);
  readonly deprecation = signal<Deprecation | null>(null);
}

async function render() {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideZard()],
  });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, host: fixture.componentInstance };
}

describe('ModuleDetailsComponent, deprecation (#266)', () => {
  it('says nothing of a deprecation while there is none, and badges a deprecated manual', async () => {
    const { el } = await render();
    expect(el.querySelector('[data-slot="module-deprecation"]')).toBeNull();
    expect(el.querySelector('[data-slot="used-in-deprecated"]')).toBeNull();
    const badges = Array.from(
      el.querySelectorAll('of-status-badge[data-status="deprecated"]'),
    );
    expect(badges.map((b) => b.closest('li')?.textContent)).toEqual([
      expect.stringContaining('Old manual'),
    ]);
  });

  it('shows the reason and the replacement, and warns that the manuals still include it', async () => {
    const { el, fixture, host } = await render();
    host.deprecation.set({ reason: 'Superseded.', replacedBy: 'safety-note' });
    await fixture.whenStable();
    const notice = el.querySelector(
      '[data-slot="module-deprecation"]',
    ) as HTMLElement;
    expect(notice.textContent).toContain('Deprecated');
    expect(notice.textContent).toContain('Superseded.');
    const link = notice.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe('safety-note');
    expect(link.getAttribute('href')).toBe('/content/en/safety-note');
    expect(
      el.querySelector('[data-slot="used-in-deprecated"]')?.textContent,
    ).toContain('These 2 manuals still include the deprecated module');
  });
});

@Component({
  imports: [ModuleDetailsComponent],
  template: `<of-module-details
    [meta]="meta()"
    moduleId="charging"
    [config]="config"
    [usedIn]="[]"
    [deprecation]="null"
    [editable]="true"
  />`,
})
class AudienceHost {
  readonly meta = signal<{
    title: string;
    type: string;
    lang: string;
    facets: Record<string, string[]>;
    audience?: string;
  }>({ title: 'Charging', type: 'concept', lang: 'en', facets: {} });
  readonly config = {
    ...config,
    audiences: [
      { id: 'operator', label: 'Operator' },
      { id: 'service', label: 'Service' },
    ],
  } as unknown as ProjectConfig;
}

describe('ModuleDetailsComponent, audience (#693)', () => {
  async function renderAudience() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideZard()],
    });
    const fixture = TestBed.createComponent(AudienceHost);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const trigger = () =>
      [
        ...el.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'),
      ].find((b) => b.getAttribute('aria-label')?.startsWith('Audience:'));
    return { fixture, el, host: fixture.componentInstance, trigger };
  }

  it('names the last, most restricted level a module without an audience counts as', async () => {
    const { trigger } = await renderAudience();
    expect(trigger()?.getAttribute('aria-label')).toBe(
      'Audience: Not set: counts as Service',
    );
    expect(trigger()?.textContent).not.toMatch(/every audience/i);
  });

  it('offers the unset choice by the level it counts as', async () => {
    const { trigger, fixture } = await renderAudience();
    trigger()?.click();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
    const options = [
      ...document.querySelectorAll<HTMLElement>('z-select-item'),
    ].map((o) => o.textContent?.trim());
    expect(options).toEqual([
      'Not set: counts as Service',
      'Operator',
      'Service',
    ]);
  });

  it('shows a set audience by its label', async () => {
    const { trigger, fixture, host } = await renderAudience();
    host.meta.update((m) => ({ ...m, audience: 'operator' }));
    await fixture.whenStable();
    expect(trigger()?.getAttribute('aria-label')).toBe('Audience: Operator');
  });
});
