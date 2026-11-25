import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import type { ProjectConfig } from '../content/browser-model';
import type { UpdateGuide } from './update-guide';
import { UpdateGuidePreviewComponent } from './update-guide-preview.component';

const CONFIG = {
  languages: { source: 'en', targets: [] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [
    {
      id: 'cluster',
      label: 'Cluster',
      kind: 'enum',
      values: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    },
    { id: 'market', label: 'Market', kind: 'enum', values: [] },
  ],
  moduleTypes: [],
} as unknown as ProjectConfig;

const GUIDE: UpdateGuide = {
  attribute: 'software',
  versions: ['1.0', '2.0', '3.0'],
  steps: [
    { module: 'back-up', version: '2.0', phase: 'before' },
    { module: 'install', version: '2.0', phase: 'during' },
    { module: 'check', version: '3.0', phase: 'after', level: 'internal' },
    {
      module: 'drain',
      version: '3.0',
      phase: 'before',
      when: { op: 'in', attr: 'cluster', values: ['yes'] },
    },
  ],
};

@Component({
  imports: [UpdateGuidePreviewComponent],
  template: `
    <of-update-guide-preview
      [guide]="guide()"
      [config]="config"
      [levels]="config.audiences"
      [titleOf]="title"
    />
  `,
})
class HostComponent {
  readonly guide = signal(GUIDE);
  readonly config = CONFIG;
  readonly title = (id: string) => `Title of ${id}`;
}

async function setup() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(HostComponent);
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  await settle();
  const choose = async (select: string, label: string) => {
    document.querySelector<HTMLElement>(`${select} button`)?.click();
    await settle();
    Array.from(document.querySelectorAll<HTMLElement>('z-select-item'))
      .find((o) => o.textContent?.trim() === label)
      ?.click();
    await settle();
  };
  const steps = () =>
    Array.from(
      document.querySelectorAll('[data-testid=guide-preview-step]'),
    ).map((s) => s.getAttribute('data-module'));
  const count = () =>
    document
      .querySelector('[data-testid=guide-preview-count]')
      ?.textContent?.trim();
  return { host: fixture.componentInstance, settle, choose, steps, count };
}

describe('UpdateGuidePreviewComponent (#908)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('shows the whole guide first, by phase, then the reader’s range, level and option', async () => {
    const t = await setup();
    expect(t.steps()).toEqual(['back-up', 'install', 'check']);
    expect(t.count()).toBe('3 steps from 1.0 to 3.0');
    expect(document.body.textContent).toContain('Title of back-up');
    // Only the option the conditions name.
    expect(document.querySelector('[data-option=cluster]')).not.toBeNull();
    expect(document.querySelector('[data-option=market]')).toBeNull();

    await t.choose('[data-testid=guide-preview-from]', '2.0');
    expect(t.steps()).toEqual(['check']);
    await t.choose('[data-option=cluster]', 'Yes');
    expect(t.steps()).toEqual(['drain', 'check']);
    await t.choose('[data-testid=guide-preview-level]', 'Public');
    expect(t.steps()).toEqual(['drain']);
    expect(t.count()).toBe('1 step from 2.0 to 3.0');
  });

  it('says when the range goes nowhere, and falls back once a version is gone', async () => {
    const t = await setup();
    await t.choose('[data-testid=guide-preview-from]', '3.0');
    expect(
      document.querySelector('[data-testid=guide-preview-not-forward]'),
    ).not.toBeNull();
    expect(t.steps()).toEqual([]);
    t.host.guide.set({ ...GUIDE, versions: ['1.0', '2.0', '3.5'] });
    await t.settle();
    // 3.0 is gone: from the first version again.
    expect(t.count()).toBe('3 steps from 1.0 to 3.5');
  });
});
