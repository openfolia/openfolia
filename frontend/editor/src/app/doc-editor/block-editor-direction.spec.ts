import { TestBed } from '@angular/core/testing';
import type { ShownConfig as ProjectConfig } from '../i18n';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from './block-editor.component';
import type { DocBlockSettings } from './blocks/doc-blocks-context';
import { doc, p } from './testing/test-editor';

// Right-to-left languages (#458): the document area takes its language's direction, the
// toolbar around it stays left to right.

const config = (direction?: Record<string, 'ltr' | 'rtl'>) =>
  ({
    languages: { source: 'en', targets: ['ar', 'he', 'de'], direction },
    maxHeadingLevel: 3,
  }) as unknown as ProjectConfig;

async function render(blocks: DocBlockSettings) {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', doc(p('نص', 'a')));
  fixture.componentRef.setInput('blocks', blocks);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const content = () => el.querySelector<HTMLElement>('.doc-editor-content')!;
  const set = async (next: DocBlockSettings) => {
    fixture.componentRef.setInput('blocks', next);
    await fixture.whenStable();
  };
  return { el, content, set };
}

describe('the block editor’s direction', () => {
  it('sets the document’s language and its script’s direction on the document area only', async () => {
    const { el, content } = await render({ lang: 'ar', config: config() });
    expect(content().getAttribute('lang')).toBe('ar');
    expect(content().getAttribute('dir')).toBe('rtl');
    // Still the editor's text box, with its name.
    expect(content().getAttribute('role')).toBe('textbox');
    expect(content().getAttribute('aria-label')).toBeTruthy();
    // The toolbar is the UI's: it keeps the page's direction.
    expect(el.querySelector('[role="toolbar"]')?.closest('[dir]')).toBe(null);
  });

  it('follows the configured direction, and a change of language', async () => {
    const { content, set } = await render({
      lang: 'ar',
      config: config({ ar: 'ltr' }),
    });
    expect(content().getAttribute('dir')).toBe('ltr');
    await set({ lang: 'he', config: config() });
    expect(content().getAttribute('lang')).toBe('he');
    expect(content().getAttribute('dir')).toBe('rtl');
    await set({ lang: 'de', config: config() });
    expect(content().getAttribute('dir')).toBe('ltr');
  });

  it('takes the script’s direction before the configuration arrives, and sets none without a language', async () => {
    const { content, set } = await render({ lang: 'he' });
    expect(content().getAttribute('dir')).toBe('rtl');
    await set({});
    expect(content().hasAttribute('lang')).toBe(false);
    expect(content().hasAttribute('dir')).toBe(false);
  });
});
