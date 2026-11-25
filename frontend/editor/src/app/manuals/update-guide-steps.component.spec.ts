import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import type { ProjectConfig } from '../content/browser-model';
import type { UpdateGuide } from './update-guide';
import { UpdateGuideStepsComponent } from './update-guide-steps.component';

const CONFIG = {
  languages: { source: 'en', targets: [] },
  audiences: [{ id: 'public', label: 'Public' }],
  variantAttributes: [{ id: 'software', label: 'Software', kind: 'version' }],
  moduleTypes: [],
} as unknown as ProjectConfig;

@Component({
  imports: [UpdateGuideStepsComponent],
  template: `
    <of-update-guide-steps
      [guide]="guide()"
      [config]="config"
      [editable]="true"
      [titleOf]="titleOf"
      [conditionText]="text"
      (guideChange)="guide.set($event)"
    />
  `,
})
class HostComponent {
  readonly guide = signal<UpdateGuide>({
    attribute: 'software',
    versions: ['1.0', '2.0'],
    steps: [
      { module: 'a', version: '2.0', phase: 'before' },
      { module: 'b', version: '2.0', phase: 'before' },
      { module: 'c', version: '2.0', phase: 'before' },
    ],
  });
  readonly config = CONFIG;
  readonly titleOf = (id: string) => id.toUpperCase();
  readonly text = (when: unknown) => JSON.stringify(when);
}

describe('UpdateGuideStepsComponent (#908)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('keeps moving the same step with the keyboard: focus follows the step, not its old place', async () => {
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
    const modules = () =>
      fixture.componentInstance.guide().steps.map((s) => s.module);
    const grip = (module: string) =>
      document
        .querySelector<HTMLElement>(
          `[data-testid=guide-step][data-module=${module}]`,
        )
        ?.closest('[data-id]')
        ?.querySelector<HTMLElement>('[data-slot=sortable-grip]');
    grip('a')?.focus();
    for (let i = 0; i < 2; i++) {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    }
    expect(modules()).toEqual(['b', 'c', 'a']);
    expect(document.activeElement).toBe(grip('a'));
  });
});
