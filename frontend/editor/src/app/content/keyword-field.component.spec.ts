import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import {
  cleanKeyword,
  KeywordFieldComponent,
  keywordProblem,
  withKeyword,
} from './keyword-field.component';

async function render(keywords: readonly string[] = []) {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(KeywordFieldComponent);
  fixture.componentRef.setInput('label', 'Keywords');
  fixture.componentRef.setInput('keywords', keywords);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const input = () => el.querySelector('input')!;
  const settle = () => fixture.whenStable();
  const type = async (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    await settle();
  };
  const press = async (key: string) => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);
    await settle();
    return event;
  };
  const chips = () =>
    [...el.querySelectorAll('li')].map((li) => li.textContent?.trim());
  return { fixture, el, input, type, press, chips, settle };
}

describe('keyword helpers', () => {
  it('clean a keyword as the content model stores it', () => {
    expect(cleanKeyword('  deep \t discharge ')).toBe('deep discharge');
    expect(cleanKeyword('Wärme')).toBe('Wärme');
  });

  it('add a keyword once, case aside', () => {
    expect(withKeyword(['Battery'], 'battery')).toEqual(['Battery']);
    expect(withKeyword(['Battery'], 'Akku')).toEqual(['Battery', 'Akku']);
  });

  it('refuse a keyword too long, one too many, or a control character', () => {
    expect(keywordProblem('x'.repeat(64), [])).toBeNull();
    expect(keywordProblem('x'.repeat(65), [])).toBe('editor.keywords.tooLong');
    const full = Array.from({ length: 32 }, (_, i) => `k${i}`);
    expect(keywordProblem('more', full)).toBe('editor.keywords.tooMany');
    expect(keywordProblem('a\u0007b', [])).toBe('editor.keywords.invalid');
  });
});

describe('KeywordFieldComponent', () => {
  it('adds with Enter or a comma, splits a pasted list, and keeps each once', async () => {
    const t = await render();
    await t.type('maintenance');
    const enter = await t.press('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(t.input().value).toBe('');
    await t.type('battery, MAINTENANCE,deep  discharge,Wär');
    expect(t.fixture.componentInstance.keywords()).toEqual([
      'maintenance',
      'battery',
      'deep discharge',
    ]);
    // What follows the last comma is still being typed.
    expect(t.input().value).toBe('Wär');
    t.input().dispatchEvent(new Event('blur'));
    await t.settle();
    expect(t.chips()).toEqual([
      'maintenance',
      'battery',
      'deep discharge',
      'Wär',
    ]);
  });

  it('leaves Enter in the empty field to the form', async () => {
    const t = await render(['a']);
    expect((await t.press('Enter')).defaultPrevented).toBe(false);
  });

  it('removes the last with Backspace in the empty field, any one with its button', async () => {
    const t = await render(['one', 'two', 'three']);
    await t.press('Backspace');
    expect(t.fixture.componentInstance.keywords()).toEqual(['one', 'two']);
    await t.type('x');
    expect((await t.press('Backspace')).defaultPrevented).toBe(false);
    const remove = t.el.querySelector<HTMLButtonElement>(
      'li button[aria-label="editor.keywords.remove"], li button',
    );
    remove?.click();
    await t.settle();
    expect(t.fixture.componentInstance.keywords()).toEqual(['two']);
  });

  it('says why a keyword cannot be added and keeps what was typed', async () => {
    const t = await render();
    await t.type('x'.repeat(65));
    expect(t.input().getAttribute('aria-invalid')).toBe('true');
    await t.press('Enter');
    expect(t.fixture.componentInstance.keywords()).toEqual([]);
    expect(t.input().value).toBe('x'.repeat(65));
    expect(t.fixture.componentInstance.problem()).toBe(
      'editor.keywords.tooLong',
    );
  });
});
