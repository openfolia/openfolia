import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { SaveSnippetDialogComponent } from './save-snippet-dialog.component';

@Component({
  imports: [SaveSnippetDialogComponent],
  template: `<of-save-snippet-dialog />`,
})
class Host {
  readonly dialog = viewChild.required(SaveSnippetDialogComponent);
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

const ONE = [
  { id: 'phrase', label: 'Phrase', restricted: false, snippet: true },
];
const TWO = [
  ...ONE,
  {
    id: 'warning-text',
    label: 'Warning text',
    restricted: false,
    snippet: true,
  },
];

async function setup() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const stable = async () => {
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  const panel = () => document.querySelector<HTMLElement>('z-dialog-panel')!;
  const input = (id: string) =>
    panel().querySelector<HTMLInputElement>(`#${id}`)!;
  const type = async (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input'));
    await stable();
  };
  const submit = async () => {
    panel()
      .querySelector<HTMLButtonElement>('[data-slot="save-snippet-submit"]')!
      .click();
    await stable();
  };
  /**
   * The dialog's answer to `open()`, once it has closed: it answers only after its leave
   * transition (a timer started by the change detection after the click). Waits for the answer
   * itself, not for a fixed time, which a loaded machine can overrun (#355).
   */
  const closed = async <T>(answer: Promise<T>): Promise<T> => {
    const value = await answer;
    await stable();
    return value;
  };
  return {
    dialog: fixture.componentInstance.dialog(),
    stable,
    panel,
    input,
    type,
    submit,
    closed,
  };
}

describe('the save-as-snippet dialog', () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('makes the ID from the title, preselects the only snippet type and answers once closed', async () => {
    const t = await setup();
    const answer = t.dialog.open({ types: ONE, moduleId: 'charging' });
    let answered = false;
    void answer.then(() => (answered = true));
    await t.stable();
    expect(t.panel().textContent).toContain('Saved as Phrase.');
    await t.type(t.input('save-snippet-title'), '  Hot   surface ');
    expect(t.input('save-snippet-id').value).toBe('hot-surface');
    await t.submit();
    expect(answered).toBe(false); // not before it has closed
    expect(await t.closed(answer)).toEqual({
      title: 'Hot surface',
      type: 'phrase',
      id: 'hot-surface',
    });
  });

  it('asks for the title and the type, keeps an ID typed by hand and refuses the module’s own', async () => {
    const t = await setup();
    const answer = t.dialog.open({ types: TWO, moduleId: 'charging' });
    await t.stable();
    await t.submit();
    expect(t.panel().textContent).toContain('Give the snippet a title.');
    expect(t.panel().textContent).toContain('Choose the snippet type.');
    await t.type(t.input('save-snippet-title'), 'Charging');
    await t.submit();
    expect(t.panel().textContent).toContain(
      'This is the ID of the module you are editing.',
    );
    await t.type(t.input('save-snippet-id'), 'Not a slug');
    expect(t.panel().textContent).toContain(
      'Use lowercase letters, digits and single hyphens only.',
    );
    await t.type(t.input('save-snippet-id'), 'charging-note');
    // The title no longer changes an ID typed by hand.
    await t.type(t.input('save-snippet-title'), 'Charging, briefly');
    expect(t.input('save-snippet-id').value).toBe('charging-note');
    t.panel()
      .querySelector<HTMLButtonElement>('[data-type="warning-text"]')!
      .click();
    await t.stable();
    await t.submit();
    expect(await t.closed(answer)).toEqual({
      title: 'Charging, briefly',
      type: 'warning-text',
      id: 'charging-note',
    });
  });

  it('answers null when cancelled', async () => {
    const t = await setup();
    const answer = t.dialog.open({ types: ONE, moduleId: 'charging' });
    await t.stable();
    [...t.panel().querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .click();
    expect(await t.closed(answer)).toBeNull();
  });
});
