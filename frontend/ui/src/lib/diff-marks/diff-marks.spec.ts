import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  CommentAnchorComponent,
  DiffDeletedComponent,
  DiffInsertedComponent,
} from './diff-marks.component';

@Component({
  imports: [
    DiffInsertedComponent,
    DiffDeletedComponent,
    CommentAnchorComponent,
  ],
  template: `<ins of-diff-inserted>new</ins><del of-diff-deleted>old</del
    ><button of-comment-anchor [count]="2">text</button>`,
})
class Host {}

describe('diff marks', () => {
  it('marks changes by more than colour', () => {
    const f = TestBed.createComponent(Host);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const ins = el.querySelector('ins')!;
    const del = el.querySelector('del')!;
    expect(ins.className).toContain('underline');
    expect(ins.textContent).toContain('Inserted: new');
    expect(del.className).toContain('line-through');
    expect(del.textContent).toContain('Deleted: old');
    const anchor = el.querySelector('button')!;
    expect(anchor.querySelector('ng-icon')).not.toBeNull();
    expect(anchor.textContent).toContain('2');
    expect(anchor.textContent).toContain('comments');
  });
});
