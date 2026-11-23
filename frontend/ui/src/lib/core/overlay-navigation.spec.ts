import { Location } from '@angular/common';
import { provideLocationMocks, SpyLocation } from '@angular/common/testing';
import { Component, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ZardAlertDialogImports } from '../alert-dialog/alert-dialog.imports';
import { ZardDialogImports } from '../dialog/dialog.imports';
import { ZardSheetImports } from '../sheet/sheet.imports';

type Kind = 'sheet' | 'dialog' | 'alert-dialog';
const KINDS: readonly Kind[] = ['sheet', 'dialog', 'alert-dialog'];

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Timers (the exit transition, the router's own), effects and renders, a few times over. */
async function settle(fixture: { whenStable(): Promise<unknown> }) {
  for (let round = 0; round < 5; round++) {
    await wait();
    await fixture.whenStable();
  }
}

// jsdom has no layout: give elements a size so the CDK focus trap finds them tabbable and visible.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 10,
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
    'offsetWidth'
  ];
});

const body = () => document.querySelector('#overlay-body');

/** Back or Forward, as the browser reports it. */
const pop = (url: string) =>
  (TestBed.inject(Location) as SpyLocation).simulateUrlPop(url);

// The same overlay three ways; `open` two-way bound, as most hosts do.
@Component({
  imports: [ZardSheetImports, ZardDialogImports, ZardAlertDialogImports],
  template: `
    <button type="button" id="opener">Open</button>
    @switch (kind()) {
      @case ('sheet') {
        <z-sheet
          [(zVisible)]="open"
          [zCloseOnNavigation]="closeOnNavigation()"
          [zDuration]="0"
        >
          <button type="button" id="overlay-body">Inside</button>
        </z-sheet>
      }
      @case ('dialog') {
        <z-dialog
          [(zVisible)]="open"
          [zCloseOnNavigation]="closeOnNavigation()"
          [zDuration]="0"
        >
          <button type="button" id="overlay-body">Inside</button>
        </z-dialog>
      }
      @case ('alert-dialog') {
        <z-alert-dialog
          [(zVisible)]="open"
          [zCloseOnNavigation]="closeOnNavigation()"
          [zDuration]="0"
        >
          <button type="button" id="overlay-body">Inside</button>
        </z-alert-dialog>
      }
    }
  `,
})
class TwoWayHost {
  readonly kind = input.required<Kind>();
  readonly closeOnNavigation = input(true);
  readonly open = signal(false);
}

// One-way bound to the address (`?open`), closed by writing the address: the module editor's
// preview sheet. A close reported during the `popstate` would write against the old address.
@Component({
  imports: [ZardSheetImports, ZardDialogImports, ZardAlertDialogImports],
  template: `
    @switch (kind) {
      @case ('sheet') {
        <z-sheet
          [zVisible]="open()"
          (zVisibleChange)="$event || close()"
          [zCloseOnNavigation]="closeOnNavigation"
          [zDuration]="0"
        >
          <p id="overlay-body">Inside</p>
        </z-sheet>
      }
      @case ('dialog') {
        <z-dialog
          [zVisible]="open()"
          (zVisibleChange)="$event || close()"
          [zCloseOnNavigation]="closeOnNavigation"
          [zDuration]="0"
        >
          <p id="overlay-body">Inside</p>
        </z-dialog>
      }
      @case ('alert-dialog') {
        <z-alert-dialog
          [zVisible]="open()"
          (zVisibleChange)="$event || close()"
          [zCloseOnNavigation]="closeOnNavigation"
          [zDuration]="0"
        >
          <p id="overlay-body">Inside</p>
        </z-alert-dialog>
      }
    }
  `,
})
class AddressHost {
  static kind: Kind = 'sheet';
  static closeOnNavigation = true;
  static closes = 0;

  private readonly router = inject(Router);
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap, {
    requireSync: true,
  });
  protected readonly kind = AddressHost.kind;
  protected readonly closeOnNavigation = AddressHost.closeOnNavigation;
  protected readonly open = computed(() => this.query().has('open'));

  protected close(): void {
    AddressHost.closes++;
    void this.router.navigate([], {
      queryParams: { open: null },
      queryParamsHandling: 'merge',
    });
  }
}

let fixture: ComponentFixture<TwoWayHost> | null = null;
afterEach(() => {
  fixture?.destroy();
  fixture = null;
});

async function openTwoWay(kind: Kind, closeOnNavigation = true) {
  TestBed.configureTestingModule({ providers: [provideLocationMocks()] });
  fixture = TestBed.createComponent(TwoWayHost);
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('closeOnNavigation', closeOnNavigation);
  fixture.detectChanges();
  document.querySelector<HTMLElement>('#opener')!.focus();
  fixture.componentInstance.open.set(true);
  await settle(fixture);
  expect(body()).not.toBeNull();
  return fixture;
}

async function openAtAddress(kind: Kind, closeOnNavigation: boolean) {
  AddressHost.kind = kind;
  AddressHost.closeOnNavigation = closeOnNavigation;
  AddressHost.closes = 0;
  TestBed.configureTestingModule({
    providers: [
      provideLocationMocks(),
      provideRouter([{ path: '', component: AddressHost }]),
    ],
  });
  const router = TestBed.inject(Router);
  // What the app's initial navigation sets up: the router follows Back and Forward.
  router.setUpLocationChangeListener();
  const harness = await RouterTestingHarness.create('/?open=1&tab=a');
  await router.navigateByUrl('/?open=1&tab=b');
  await settle(harness.fixture);
  expect(body()).not.toBeNull();
  return { harness, router };
}

describe.each(KINDS)('%s on Back and Forward', (kind) => {
  it('closes, says so once the navigation has settled, gives the focus back and opens again', async () => {
    const fixture = await openTwoWay(kind);
    const host = fixture.componentInstance;
    expect(document.activeElement?.id).not.toBe('opener');

    pop('/elsewhere');
    // Not reported inside the `popstate`: a host writing the address would race the router.
    expect(host.open()).toBe(true);
    await settle(fixture);

    expect(body()).toBeNull();
    expect(host.open()).toBe(false);
    expect(document.activeElement?.id).toBe('opener');

    host.open.set(true);
    await settle(fixture);
    expect(body()).not.toBeNull();
  });

  it('stays with zCloseOnNavigation off', async () => {
    const fixture = await openTwoWay(kind, false);
    pop('/elsewhere');
    await settle(fixture);
    expect(body()).not.toBeNull();
    expect(fixture.componentInstance.open()).toBe(true);
  });

  it('a host bound to the address writes its close on top of the address Back went to', async () => {
    const { harness, router } = await openAtAddress(kind, true);

    pop('/?open=1&tab=a');
    await settle(harness.fixture);

    // Back to `tab=a` kept, and only then the close written: never `tab=b` again.
    expect(router.url).toBe('/?tab=a');
    expect(AddressHost.closes).toBe(1);
    expect(body()).toBeNull();
  });

  it('a host bound to the address that Back closes reports nothing more', async () => {
    const { harness, router } = await openAtAddress(kind, true);

    pop('/?tab=a');
    await settle(harness.fixture);

    expect(router.url).toBe('/?tab=a');
    expect(AddressHost.closes).toBe(0);
    expect(body()).toBeNull();
  });

  it('with zCloseOnNavigation off follows the address alone', async () => {
    const { harness, router } = await openAtAddress(kind, false);

    pop('/?open=1&tab=a');
    await settle(harness.fixture);
    expect(router.url).toBe('/?open=1&tab=a');
    expect(body()).not.toBeNull();

    pop('/?tab=a');
    await settle(harness.fixture);
    expect(router.url).toBe('/?tab=a');
    expect(body()).toBeNull();
    expect(AddressHost.closes).toBe(0);
  });
});
