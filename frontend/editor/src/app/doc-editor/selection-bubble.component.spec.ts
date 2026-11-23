import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { BlockEditorComponent } from './block-editor.component';
import type { DocBlockSettings } from './blocks/doc-blocks-context';
import type { SnippetSaveRequest } from './snippets/save-snippet';
import { doc, insideText, p, sec } from './testing/test-editor';
import { advance } from '../testing/fake-time';

// jsdom lays nothing out: ProseMirror asks for rectangles when it scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

async function render(value: JSONContent, settings: DocBlockSettings) {
  // Fake time: the editor, its menus and change detection run on timers; a fixed real wait
  // ends before they have run on a busy machine (#562).
  vi.useFakeTimers();
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('blocks', settings);
  await advance();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  /** Runs what is due within 10 ms of the fake clock (the menus' and the editor's own
   * timers), then renders. */
  const settle = () => advance(10);
  const select = async (from: string, to: string) => {
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          insideText(editor, from),
          insideText(editor, to) + to.length,
        ),
      ),
    );
    await settle();
  };
  const button = () =>
    el.querySelector<HTMLButtonElement>(
      'of-selection-bubble [data-action="save-snippet"]',
    );
  return { editor, el, settle, select, button };
}

describe('the selection bubble’s Save as snippet (#309)', () => {
  it('hands the selected blocks to the page', async () => {
    const requests: SnippetSaveRequest[] = [];
    const t = await render(doc(p('First', 'b1'), p('Second', 'b2')), {
      saveSnippet: { blocked: null, save: (r) => requests.push(r) },
    });
    await t.select('First', 'Second');
    const button = t.button()!;
    expect(button.getAttribute('aria-label')).toBe('Save as snippet');
    expect(button.dataset['blocked']).toBeUndefined();
    button.click();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.blocks).toHaveLength(2);
  });

  it('says why when the selection can’t be a snippet, and does nothing', async () => {
    const requests: SnippetSaveRequest[] = [];
    const t = await render(doc(p('Intro', 'b1'), sec('Part', p('In', 'b2'))), {
      saveSnippet: { blocked: null, save: (r) => requests.push(r) },
    });
    await t.select('Intro', 'In');
    const button = t.button()!;
    expect(button.dataset['blocked']).toBe('true');
    expect(button.getAttribute('aria-description')).toContain(
      'no section and no module reference',
    );
    button.click();
    expect(requests).toHaveLength(0);
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .map((toast) => toast.kind),
    ).toEqual(['error']);
  });

  it('is not there when the page offers no snippets', async () => {
    const t = await render(doc(p('First', 'b1'), p('Second', 'b2')), {});
    await t.select('First', 'Second');
    expect(t.button()).toBeNull();
  });
});
