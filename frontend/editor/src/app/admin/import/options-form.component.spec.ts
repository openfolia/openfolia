import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import {
  ImportOptionsComponent,
  type OptionChange,
} from './options-form.component';
import { initialValues, optionFields, problemsOf } from './options-schema';

const fields = optionFields({
  type: 'object',
  properties: {
    folder: {
      type: 'string',
      title: 'Target folder',
      description: 'Where the modules go.',
    },
    keepIds: { type: 'boolean', title: 'Keep IDs' },
    language: { type: 'string', enum: ['en', 'de'], title: 'Language' },
    tags: { type: 'array', title: 'Tags' },
  },
  required: ['folder'],
});

async function render(shown: ReadonlySet<string> | 'all' = new Set()) {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(ImportOptionsComponent);
  const values = { ...initialValues(fields), tags: '[1' };
  fixture.componentRef.setInput('fields', fields);
  fixture.componentRef.setInput('values', values);
  fixture.componentRef.setInput('problems', problemsOf(fields, values));
  fixture.componentRef.setInput('shown', shown);
  const changes: OptionChange[] = [];
  const existing: boolean[] = [];
  fixture.componentInstance.optionChange.subscribe((c) => changes.push(c));
  fixture.componentInstance.updateExistingChange.subscribe((v) =>
    existing.push(v),
  );
  fixture.detectChanges();
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, changes, existing };
}

const option = (el: HTMLElement, name: string) =>
  el.querySelector<HTMLElement>(`[data-option="${name}"]`)!;

describe('ImportOptionsComponent', () => {
  it('renders a text field, a checkbox, a select and JSON, each labelled', async () => {
    const { el } = await render();
    const folder = option(el, 'folder').querySelector('input')!;
    expect(folder.type).toBe('text');
    expect(
      el.querySelector(`label[for="${folder.id}"]`)?.textContent,
    ).toContain('Target folder');
    expect(folder.getAttribute('aria-describedby')).toContain('-hint');
    expect(option(el, 'folder').textContent).toContain('Where the modules go.');
    expect(
      option(el, 'keepIds').querySelector('input[type="checkbox"]'),
    ).not.toBeNull();
    expect(option(el, 'keepIds').textContent).toContain('Keep IDs');
    expect(
      option(el, 'language').querySelector('z-select')?.getAttribute('id'),
    ).toBeTruthy();
    expect(option(el, 'tags').querySelector('textarea')).not.toBeNull();
    expect(option(el, 'tags').textContent).toContain('Written as JSON.');
    // "Update existing" is always there, below the importer's own options.
    expect(
      el.querySelector('[data-slot="update-existing"]')?.textContent,
    ).toContain('Update existing modules and manuals');
  });

  it('shows a problem only once its field was changed or the form was sent', async () => {
    const before = await render();
    expect(before.el.querySelector('[data-slot="option-problem"]')).toBeNull();
    TestBed.resetTestingModule();
    const { el } = await render('all');
    const problems = [
      ...el.querySelectorAll('[data-slot="option-problem"]'),
    ].map((p) => p.textContent?.trim());
    expect(problems).toEqual(['Fill this in.', 'This is not valid JSON.']);
    const tags = option(el, 'tags').querySelector('textarea')!;
    expect(tags.getAttribute('aria-invalid')).toBe('true');
    expect(tags.getAttribute('aria-describedby')).toContain('-problem');
  });

  it('says each change', async () => {
    const { el, changes, existing } = await render();
    const folder = option(el, 'folder').querySelector('input')!;
    folder.value = 'imported';
    folder.dispatchEvent(new Event('input'));
    (option(el, 'keepIds').querySelector('input') as HTMLElement).click();
    (
      el.querySelector('[data-slot="update-existing"] input') as HTMLElement
    ).click();
    expect(changes).toEqual([
      { name: 'folder', value: 'imported' },
      { name: 'keepIds', value: true },
    ]);
    expect(existing).toEqual([true]);
  });
});
