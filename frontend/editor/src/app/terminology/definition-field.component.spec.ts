import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { Editor } from '@tiptap/core';

import { provideZard } from '@openfolia/ui/core';

import { DefinitionFieldComponent } from './definition-field.component';
import type { TermDefinition } from './terms-model';

@Component({
  imports: [DefinitionFieldComponent],
  template: `@if (shown()) {
    <of-definition-field
      label="Definition"
      inputId="def"
      lang="en"
      [editable]="true"
      [value]="value"
      (changed)="changes.push($event)"
    />
  }`,
})
class Host {
  readonly shown = signal(true);
  readonly value: TermDefinition = [{ type: 'text', text: 'A device.' }];
  readonly changes: (TermDefinition | undefined)[] = [];
}

async function render() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(Host);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
      await fixture.whenStable();
    }
  };
  await settle();
  const editor = () =>
    (
      fixture.debugElement.query(By.directive(DefinitionFieldComponent))
        .componentInstance as unknown as { editor: Editor }
    ).editor;
  return { fixture, host: fixture.componentInstance, settle, editor };
}

describe('DefinitionFieldComponent', () => {
  it('shows the definition, inline marks and line breaks only', async () => {
    const { fixture, editor } = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#def')?.textContent).toBe('A device.');
    expect(el.querySelector('#def')?.getAttribute('role')).toBe('textbox');
    const nodes = Object.keys(editor().schema.nodes).sort();
    expect(nodes).toEqual(['definition', 'doc', 'hardBreak', 'text']);
  });

  it('hands on each change at once, so none is lost when the field goes without a blur', async () => {
    const { host, settle, editor } = await render();
    editor().commands.insertContentAt(
      editor().state.doc.content.size - 1,
      ' More.',
    );
    // Gone before the debounce ran (Escape, Back, another term): the text is not lost.
    host.shown.set(false);
    await settle();
    expect(host.changes).toEqual([[{ type: 'text', text: 'A device. More.' }]]);
  });
});
