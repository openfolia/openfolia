import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideZard } from '@openfolia/ui/core';

import { MeService } from '../permissions/me';
import { ChangeSetControlComponent } from './change-set-control.component';
import { ChangeSetSession } from './change-set-session';

describe('ChangeSetControlComponent', () => {
  it('offers New change set in its menu, and shows a loading state while a switch is unanswered', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideZard(),
      ],
    });
    TestBed.inject(MeService).set({
      id: 'a',
      kind: 'user',
      name: 'A',
      role: '',
      permissions: new Set(['content.edit']),
    });
    const fixture = TestBed.createComponent(ChangeSetControlComponent);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const trigger = () =>
      el.querySelector<HTMLElement>('[data-testid=change-set-trigger]');
    const start = () =>
      document
        .querySelector('[data-testid=change-set-start]')
        ?.querySelector('[role=option]');
    // One control: the trigger opens the list with "New change set" at its end.
    trigger()?.click();
    await fixture.whenStable();
    expect(start()?.getAttribute('aria-disabled')).toBeNull();
    start()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    expect(
      document.querySelector('[data-testid=change-set-start-form]'),
    ).toBeTruthy();

    TestBed.inject(ChangeSetSession).beginSwitch();
    await fixture.whenStable();
    expect(trigger()).toBeNull();
    expect(el.querySelector('[aria-busy="true"]')).toBeTruthy();
    document.body.replaceChildren();
  });
});
