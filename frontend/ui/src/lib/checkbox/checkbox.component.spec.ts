import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ZardTableImports } from '../table/table.imports';
import { ZardCheckboxComponent } from './checkbox.component';

@Component({
  imports: [ZardCheckboxComponent, ZardTableImports],
  template: `
    <table z-table>
      <thead z-table-header>
        <tr z-table-row>
          <th z-table-head><z-checkbox zAriaLabel="All" class="w-6" /></th>
        </tr>
      </thead>
      <tbody z-table-body>
        <tr z-table-row>
          <td z-table-cell><z-checkbox zAriaLabel="One" /></td>
        </tr>
      </tbody>
    </table>
  `,
})
class Host {}

describe('checkbox in a table', () => {
  it('stays a size-4 square, even when the caller passes a width', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const inputs = fixture.nativeElement.querySelectorAll(
      'input[type=checkbox]',
    ) as NodeListOf<HTMLInputElement>;
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.classList.contains('size-4')).toBe(true);
      expect(input.classList.contains('w-6')).toBe(false);
    }
  });

  it('paints the header background on the row, so no cell shows a seam', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const table = fixture.nativeElement.querySelector('table') as HTMLElement;
    expect(table.className).toContain('[&_thead_tr]:bg-muted');
    expect(table.className).not.toContain('[&_thead_th]:bg-muted');
    expect(table.className).not.toContain('[&_th]:bg-muted');
    // Rounded by clipping the row, not by cell backgrounds with radii.
    expect(table.className).toContain(
      '[&_thead_tr]:[clip-path:inset(0_round_var(--radius))]',
    );
    // A hovered row's band has the same corners.
    expect(table.className).toContain(
      '[&_tbody_tr]:hover:[clip-path:inset(0_round_var(--radius))]',
    );
  });
});
