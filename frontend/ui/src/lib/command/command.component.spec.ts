import { Component, ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '../core/provide-zard';
import { ZardCommandImports } from './command.imports';

@Component({
  imports: [ZardCommandImports],
  template: `
    <z-command>
      <z-command-input label="Search" />
      <z-command-list>
        @for (o of options(); track o) {
          <z-command-option [zValue]="o" [zLabel]="o" />
        }
      </z-command-list>
    </z-command>
  `,
})
class Host {
  readonly options = signal(['Alpha', 'Beta']);
}

describe('ZardCommandComponent', () => {
  it('takes an option added while it is open, with no error', async () => {
    const errors: unknown[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        {
          provide: ErrorHandler,
          useValue: { handleError: (e: unknown) => errors.push(e) },
        },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('input') as HTMLInputElement;
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.options.set(['Alpha', 'Beta', 'Gamma']);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(errors).toEqual([]);
    expect(
      Array.from(el.querySelectorAll('[role=option]')).map((o) =>
        o.textContent?.trim(),
      ),
    ).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
