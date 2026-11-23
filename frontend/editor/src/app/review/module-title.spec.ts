import { signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { MeService } from '../permissions/me';
import { OutlineTitleComponent } from './diff-outline.component';
import { DiffReferenceComponent } from './diff-reference.component';
import {
  DIFF_ITEM,
  ReviewContext,
  type DiffItemContext,
} from './review-context';

const person = (id: string) =>
  TestBed.inject(MeService).set({
    id,
    kind: 'user',
    name: id,
    role: '',
    permissions: new Set(['content.read']),
  });

const item: DiffItemContext = {
  key: signal('module/en/edited'),
  lang: signal('en'),
  before: signal([]),
  after: signal([]),
  base: signal('c1'),
  head: signal('c2'),
  open: signal(new Set<string>()),
  commentModule: signal(null),
  toggle: () => undefined,
};

describe('a module title in the diff', () => {
  for (const [name, component] of [
    ['DiffReferenceComponent', DiffReferenceComponent],
    ['OutlineTitleComponent', OutlineTitleComponent],
  ] as [string, Type<unknown>][]) {
    it(`${name} asks for it again for the next person, never keeping the one shown before (#716)`, async () => {
      const moduleTitle = vi.fn(() =>
        Promise.resolve(`Title for ${TestBed.inject(MeService).me().id}`),
      );
      TestBed.configureTestingModule({
        providers: [
          { provide: ReviewContext, useValue: { moduleTitle } },
          { provide: DIFF_ITEM, useValue: item },
        ],
      });
      person('u1');
      const fixture = TestBed.createComponent(component);
      fixture.componentRef.setInput('moduleId', 'torque');
      await fixture.whenStable();
      const text = () => (fixture.nativeElement as HTMLElement).textContent;
      expect(moduleTitle).toHaveBeenCalledTimes(1);
      expect(text()).toContain('Title for u1');

      person('u2');
      await fixture.whenStable();
      expect(moduleTitle).toHaveBeenCalledTimes(2);
      expect(text()).toContain('Title for u2');
      expect(text()).not.toContain('Title for u1');
    });
  }
});
