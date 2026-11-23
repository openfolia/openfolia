import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { ProjectFileDiffComponent } from './project-file-diff.component';
import { ReviewContext } from './review-context';
import type { ChangeSetChange } from './review-model';

const change = (fields: string[], kind = 'changed') =>
  ({
    type: 'ChangeSetChange',
    id: 'config',
    attributes: { subject: { type: 'config' } },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: 'x' } } },
    meta: { change: kind, fields, blocks: [], unreadable: false },
  }) as unknown as ChangeSetChange;

async function render(c: ChangeSetChange) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
      ReviewContext,
    ],
  });
  const fixture = TestBed.createComponent(ProjectFileDiffComponent);
  fixture.componentRef.setInput('change', c);
  await fixture.whenStable();
  return TestBed.inject(ReviewContext);
}

describe('ProjectFileDiffComponent', () => {
  it('tells the overview what changed in the project file, so its chip is not left loading', async () => {
    const context = await render(change(['audiences', 'facets']));
    expect(context.summaryOf('config')).toEqual({
      counts: expect.any(Object),
      fields: 2,
      title: 'openfolia.yaml',
      renamed: false,
    });
    expect(context.total()).toBe(2);
  });

  it('counts a file added whole as one change', async () => {
    const context = await render(change([], 'added'));
    expect(context.summaryOf('config')?.fields).toBe(1);
  });
});
