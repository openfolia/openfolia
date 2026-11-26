import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ZardDialogImports } from './dialog.imports';

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// jsdom has no layout: give elements a size so the CDK focus trap finds them tabbable and visible.
// The workers share their jsdom between spec files: jsdom's own getter is put back after.
let offsetWidth: PropertyDescriptor | undefined;
beforeAll(() => {
  offsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 10,
  });
});
afterAll(() => {
  if (offsetWidth)
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
  else
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
      'offsetWidth'
    ];
});

@Component({
  imports: [ZardDialogImports],
  template: `
    <button type="button" id="opener">Open</button>
    <button type="button" id="elsewhere">Elsewhere</button>
    <z-dialog [(zVisible)]="open" [zDuration]="0" [zCanClose]="canClose">
      <button type="button" id="inside">Inside</button>
    </z-dialog>
  `,
})
class Host {
  readonly open = signal(false);
  may = true;
  asked = 0;
  readonly canClose = () => {
    this.asked++;
    return this.may;
  };
}

async function opened() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  document.querySelector<HTMLElement>('#opener')!.focus();
  fixture.componentInstance.open.set(true);
  fixture.detectChanges();
  await fixture.whenStable();
  await wait();
  expect(document.querySelector('#inside')).not.toBeNull();
  const close = async (then?: () => void) => {
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    then?.();
    await wait(10);
    await fixture.whenStable();
    expect(document.querySelector('#inside')).toBeNull();
  };
  return { fixture, close };
}

describe('the dialog’s focus on closing', () => {
  it('goes back to where it was before the dialog opened', async () => {
    const { fixture, close } = await opened();
    await close();
    expect(document.activeElement?.id).toBe('opener');
    fixture.destroy();
  });

  it('stays where the host put it while the dialog closed (#793)', async () => {
    const { fixture, close } = await opened();
    await close(() =>
      document.querySelector<HTMLElement>('#elsewhere')!.focus(),
    );
    expect(document.activeElement?.id).toBe('elsewhere');
    fixture.destroy();
  });
});

describe('the dialog’s own ways to close', () => {
  it('each ask the host first: Escape, the X (#611)', async () => {
    const { fixture } = await opened();
    const host = fixture.componentInstance;
    const ways = [
      () =>
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      () =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="z-close-header-button"]',
          )!
          .click(),
    ];
    for (const way of ways) {
      host.may = false;
      host.asked = 0;
      way();
      await wait(10);
      await fixture.whenStable();
      expect(host.asked).toBe(1);
      expect(host.open()).toBe(true);
      expect(document.querySelector('#inside')).not.toBeNull();
      host.may = true;
      way();
      await wait(20);
      await fixture.whenStable();
      expect(host.open()).toBe(false);
      host.open.set(true);
      fixture.detectChanges();
      await wait(10);
      await fixture.whenStable();
    }
    fixture.destroy();
  });
});
