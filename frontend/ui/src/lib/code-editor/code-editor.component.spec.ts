import { TestBed } from '@angular/core/testing';

import { CodeEditorComponent } from './code-editor.component';

describe('CodeEditorComponent', () => {
  const render = (value: string, inputs: Record<string, unknown> = {}) => {
    const fixture = TestBed.createComponent(CodeEditorComponent);
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('path', 'manual.typ');
    fixture.componentRef.setInput('label', 'manual.typ');
    for (const [k, v] of Object.entries(inputs)) {
      fixture.componentRef.setInput(k, v);
    }
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const area = el.querySelector('textarea') as HTMLTextAreaElement;
    const changes: string[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => changes.push(v));
    return { fixture, el, area, changes };
  };
  const press = (area: HTMLTextAreaElement, key: string, init = {}) => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    area.dispatchEvent(event);
    return event;
  };

  it('is a named text field over the highlighted text, a number per line', () => {
    const { el, area } = render('#let x = 1\n// note\n');
    expect(area.value).toBe('#let x = 1\n// note\n');
    expect(area.getAttribute('aria-label')).toBe('manual.typ');
    expect(area.getAttribute('spellcheck')).toBe('false');
    const lines = el.querySelectorAll(
      '[data-slot="code-editor-code"] [data-line]',
    );
    expect(lines.length).toBe(3);
    expect(lines[0]?.textContent).toBe('#let x = 1');
    expect(lines[0]?.querySelector('.text-primary')?.textContent).toBe('#let');
    expect(lines[1]?.querySelector('.italic')?.textContent).toBe('// note');
    const gutter = el.querySelector('[data-slot="code-editor-gutter"]');
    expect(gutter?.getAttribute('aria-hidden')).toBe('true');
    expect(gutter?.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 2 3');
  });

  it('says what is typed, and shows it at once', () => {
    const { fixture, el, area, changes } = render('a');
    area.value = 'ab';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(changes).toEqual(['ab']);
    expect(el.querySelector('[data-line="1"]')?.textContent).toBe('ab');
  });

  it('marks the lines with a problem, and says the field is invalid', () => {
    const { el, area } = render('a\nb\nc', {
      markers: [{ line: 2, message: 'unknown variable' }],
    });
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(
      el
        .querySelector('[data-line="2"]')
        ?.classList.contains('bg-destructive-muted'),
    ).toBe(true);
    expect(el.querySelectorAll('[data-marked]').length).toBe(1);
  });

  it('indents with Tab, outdents with Shift+Tab, and lets Tab leave after Escape', () => {
    const { area, changes } = render('a\nb');
    area.focus();
    area.setSelectionRange(0, 3);
    expect(press(area, 'Tab').defaultPrevented).toBe(true);
    expect(changes.at(-1)).toBe('  a\n  b');
    area.setSelectionRange(0, area.value.length);
    press(area, 'Tab', { shiftKey: true });
    expect(changes.at(-1)).toBe('a\nb');
    press(area, 'Escape');
    expect(press(area, 'Tab').defaultPrevented).toBe(false);
  });

  it('keeps the indent on a new line, one more after an opening bracket', () => {
    const { area, changes } = render('  #let f(x) = {');
    area.setSelectionRange(area.value.length, area.value.length);
    press(area, 'Enter');
    expect(changes.at(-1)).toBe('  #let f(x) = {\n    ');
  });

  it('asks to save on Ctrl+S, and changes nothing when read-only', () => {
    const { fixture, area, changes } = render('x', { readonly: true });
    let saves = 0;
    fixture.componentInstance.saveRequest.subscribe(() => saves++);
    expect(press(area, 's', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(saves).toBe(1);
    expect(area.readOnly).toBe(true);
    press(area, 'Tab');
    expect(changes).toEqual([]);
  });

  it('puts the caret on a line it reveals', () => {
    const { fixture, area } = render('one\ntwo\nthree');
    const carets: { line: number; column: number }[] = [];
    fixture.componentInstance.caretChange.subscribe((c) => carets.push(c));
    fixture.componentInstance.revealLine(3, 2);
    expect(area.selectionStart).toBe('one\ntwo\n'.length + 1);
    expect(carets.at(-1)).toEqual({ line: 3, column: 2 });
  });

  it('shows a new value given from outside', () => {
    const { fixture, area, el } = render('old');
    fixture.componentRef.setInput('value', 'new\ntext');
    fixture.detectChanges();
    expect(area.value).toBe('new\ntext');
    expect(el.querySelectorAll('[data-line]').length).toBe(2);
  });
});
