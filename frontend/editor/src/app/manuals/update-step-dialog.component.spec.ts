import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import type { ProjectConfig } from '../content/browser-model';
import type { PickCondition } from './manual-settings-panel.component';
import type { UpdateGuide, UpdateStep } from './update-guide';
import {
  UpdateStepDialogComponent,
  type StepRequest,
} from './update-step-dialog.component';

const CONFIG = {
  languages: { source: 'en', targets: [] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [],
  moduleTypes: [],
} as unknown as ProjectConfig;

const GUIDE: UpdateGuide = {
  attribute: 'software',
  versions: ['1.0', '2.0', '3.0'],
  steps: [{ module: 'install', version: '2.0', phase: 'during' }],
};

const CLUSTER = { op: 'in' as const, attr: 'cluster', values: ['yes'] };

@Component({
  imports: [UpdateStepDialogComponent],
  template: `
    <of-update-step-dialog
      [(open)]="open"
      [request]="request()"
      [guide]="guide"
      [config]="config"
      [levels]="config.audiences"
      [pickCondition]="pick"
      [conditionText]="text"
      (save)="saved.push($event)"
    />
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly request = signal<StepRequest | null>(null);
  readonly guide = GUIDE;
  readonly config = CONFIG;
  readonly saved: { index: number | null; step: UpdateStep }[] = [];
  readonly picks: unknown[] = [];
  readonly pick: PickCondition = (current) => {
    this.picks.push(current);
    return Promise.resolve(CLUSTER);
  };
  readonly text = (when: unknown) => JSON.stringify(when);
}

async function setup(request: StepRequest) {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(HostComponent);
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  const host = fixture.componentInstance;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  host.request.set(request);
  host.open.set(true);
  await settle();
  const choose = async (select: string, label: string) => {
    document
      .querySelector<HTMLElement>(`[data-testid=${select}] button`)
      ?.click();
    await settle();
    Array.from(document.querySelectorAll<HTMLElement>('z-select-item'))
      .find((o) => o.textContent?.trim() === label)
      ?.click();
    await settle();
  };
  const phase = async (label: string) => {
    Array.from(
      document.querySelectorAll<HTMLLabelElement>(
        '[data-testid=update-step-phase] label',
      ),
    )
      .find((l) => l.textContent?.trim() === label)
      ?.querySelector<HTMLElement>('[role=radio], input')
      ?.click();
    await settle();
  };
  const submit = async () => {
    document
      .querySelector<HTMLFormElement>('#update-step-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const text = () =>
    document.querySelector('[data-testid=update-step-form]')?.textContent ?? '';
  return { host, settle, choose, phase, submit, text };
}

describe('UpdateStepDialogComponent (#908)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('says what is missing, then saves a new step with its level and condition', async () => {
    const t = await setup({
      index: null,
      step: { module: 'back-up' },
      title: 'Back up',
    });
    await t.submit();
    expect(t.text()).toContain('Choose the version that needs this step.');
    expect(t.text()).toContain('Choose when the step is done.');
    expect(t.host.saved).toEqual([]);
    expect(t.host.open()).toBe(true);

    // Every version but the first is offered.
    document
      .querySelector<HTMLElement>('[data-testid=update-step-version] button')
      ?.click();
    await t.settle();
    const offered = Array.from(
      document.querySelectorAll<HTMLElement>('z-select-item'),
    ).map((o) => o.textContent?.trim());
    expect(offered).toEqual(
      expect.arrayContaining([
        'Version 2.0',
        'Version 3.0',
        'Another version…',
      ]),
    );
    expect(offered).not.toContain('Version 1.0');
    Array.from(document.querySelectorAll<HTMLElement>('z-select-item'))
      .find((o) => o.textContent?.trim() === 'Version 3.0')
      ?.click();
    await t.settle();
    await t.phase('Before the update');
    await t.choose('update-step-level', 'Internal');
    document
      .querySelector<HTMLElement>('[data-testid=update-step-pick-condition]')
      ?.click();
    await t.settle();
    expect(t.host.picks).toEqual([null]);
    await t.submit();
    expect(t.host.saved).toEqual([
      {
        index: null,
        step: {
          module: 'back-up',
          version: '3.0',
          phase: 'before',
          level: 'internal',
          when: CLUSTER,
        },
      },
    ]);
    expect(t.host.open()).toBe(false);
  });

  it('takes a new version typed, refusing one that is not dotted or not after the first', async () => {
    const t = await setup({
      index: 0,
      step: GUIDE.steps[0] as UpdateStep,
      title: 'Install',
    });
    await t.choose('update-step-version', 'Another version…');
    const field = document.querySelector<HTMLInputElement>(
      '#update-step-new-version',
    ) as HTMLInputElement;
    const type = async (value: string) => {
      field.value = value;
      field.dispatchEvent(new Event('input'));
      await t.settle();
    };
    await type('2.x');
    await t.submit();
    expect(t.text()).toContain('Type a dotted version such as 2.3.');
    await type('1.0');
    expect(t.text()).toContain('Choose a version after 1.0');
    await type('2.5');
    await t.submit();
    expect(t.host.saved).toEqual([
      {
        index: 0,
        step: { module: 'install', version: '2.5', phase: 'during' },
      },
    ]);
  });

  it('opens a step whose version the guide lists in another spelling on the listed one', async () => {
    const t = await setup({
      index: 0,
      step: { module: 'install', version: '2.0.0', phase: 'during' },
      title: 'Install',
    });
    const picked =
      document.querySelector('[data-testid=update-step-version]')
        ?.textContent ?? '';
    expect(picked).toContain('Version 2.0');
    expect(picked).not.toContain('Another version');
    await t.submit();
    expect(t.host.saved).toEqual([
      {
        index: 0,
        step: { module: 'install', version: '2.0', phase: 'during' },
      },
    ]);
  });
});
