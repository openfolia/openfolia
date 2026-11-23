import { TestBed } from '@angular/core/testing';
import { getSchema, type Editor, type JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  createEditorExtensions,
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import type { Attachment, Block, Module } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { BlockEditorComponent } from '../block-editor.component';
import { canInsertBlock, insertBlockAt } from '../editor-commands';
import {
  blockActions,
  deleteBlock,
  duplicateBlock,
} from '../plugins/block-actions';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import { SAMPLE_MODULE } from '../sample-module';
import { SLASH_ITEMS } from '../slash/slash-items';
import { doc, insideText, p, testEditor } from '../testing/test-editor';
import type { AttachmentChoice, DocBlockSettings } from './doc-blocks-context';
import {
  insertAttachment,
  pickAndInsertAttachment,
  withDocBlocks,
} from './doc-blocks';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const SETTINGS = `sha256:${'a'.repeat(64)}`;
const SAMPLE = `sha256:${'b'.repeat(64)}`;

const CHOICE: AttachmentChoice = {
  asset: SAMPLE,
  name: '  Sample\n data ',
  description: ' For a quick start. ',
  fileName: 'sample.json',
  mediaType: 'application/json',
  size: 1234,
};

const ATTACHMENT: Attachment = {
  type: 'attachment',
  id: 'settings-file',
  asset: SETTINGS,
  name: 'Sample settings',
  description: 'Import them to start.',
  fileName: 'sample-settings.zip',
  mediaType: 'application/zip',
  size: 48_213,
};

const MODULE: Module = {
  ...SAMPLE_MODULE,
  blocks: [
    {
      type: 'paragraph',
      id: 'intro',
      content: [{ type: 'text', text: 'Intro' }],
    },
    ATTACHMENT,
  ],
};

const attachmentsOf = (module: Module): Attachment[] =>
  module.blocks.filter((b: Block): b is Attachment => b.type === 'attachment');

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('inserting an attachment', () => {
  it('only says where it could go without a choice, and puts the choice there, selected', () => {
    const editor = testEditor(doc(p('Intro', 'intro'), p()));
    editor.commands.setTextSelection(insideText(editor, ''));
    const before = editor.state.doc;
    expect(insertAttachment(null)(editor.state, editor.view.dispatch)).toBe(
      true,
    );
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(insertAttachment(CHOICE)(editor.state, editor.view.dispatch)).toBe(
      true,
    );
    // In place of the blank line.
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe('attachment');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    const module = fromEditor(
      normalizeEditorDoc({
        type: 'doc',
        attrs: { moduleId: 'm', schemaVersion: 1, meta: SAMPLE_MODULE.meta },
        content: editor.getJSON().content,
      }),
    );
    const [inserted] = attachmentsOf(module);
    expect(inserted).toMatchObject({
      asset: SAMPLE,
      name: 'Sample data',
      description: 'For a quick start.',
      fileName: 'sample.json',
      mediaType: 'application/json',
      size: 1234,
    });
    expect(inserted?.id).toMatch(/\S/);
  });

  it('keeps no empty description', () => {
    const editor = testEditor(doc(p('Intro', 'intro'), p()));
    editor.commands.setTextSelection(insideText(editor, ''));
    insertAttachment({ ...CHOICE, description: '  ' })(
      editor.state,
      editor.view.dispatch,
    );
    expect(editor.state.doc.child(1).attrs['description']).toBeNull();
  });

  it('is an atom even without node views, so it moves and deletes whole', () => {
    const schema = getSchema(withDocBlocks(createEditorExtensions(), null));
    expect(schema.nodes['attachment']?.spec.atom).toBe(true);
  });
});

async function mount(
  settings: DocBlockSettings,
  module: Module = MODULE,
  editable = true,
) {
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', toEditor(module));
  fixture.componentRef.setInput('blocks', settings);
  fixture.componentRef.setInput('editable', editable);
  let last: JSONContent | null = null;
  fixture.componentInstance.changed.subscribe((d) => (last = d));
  await fixture.whenStable();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return {
    editor,
    el,
    block: () => el.querySelector<HTMLElement>('[data-node="attachment"]')!,
    button: (label: string) =>
      [
        ...el.querySelectorAll<HTMLButtonElement>(
          '[data-node="attachment"] button',
        ),
      ].find((b) => b.textContent?.includes(label)),
    model: () =>
      fromEditor(
        normalizeEditorDoc(last ?? withoutCaretGaps(editor.getJSON())),
      ),
    stable,
  };
}

const atIntro = (editor: Editor) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, insideText(editor, 'Intro') + 5),
    ),
  );

/** Where the attachment block starts in the document. */
const attachmentPos = (editor: Editor): number => {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'attachment' && found < 0) found = pos;
  });
  return found;
};

describe('the attachment block in the editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('round-trips unchanged through its node view', async () => {
    const { model } = await mount({});
    expect(model()).toEqual(MODULE);
  });

  it('shows an icon by type, the name, file name, type, size and description', async () => {
    const { block } = await mount({});
    const el = block();
    expect(el.getAttribute('contenteditable')).toBe('false');
    expect(
      el.querySelector<HTMLElement>('[data-slot="attachment-icon"]')?.dataset[
        'icon'
      ],
    ).toBe('archive');
    expect(
      el.querySelector('[data-slot="attachment-name"]')?.textContent?.trim(),
    ).toBe('Sample settings');
    expect(
      el.querySelector('[data-slot="attachment-facts"]')?.textContent?.trim(),
    ).toBe('sample-settings.zip · ZIP · 48.2 kB');
    expect(el.textContent).toContain('Import them to start.');
    // Without a way to save files, no Download; without the dialog, no Edit.
    expect(el.querySelector('button')).toBeNull();
  });

  it('downloads through the page, under the block’s file name; a gone file says so', async () => {
    const asked: [string, string][] = [];
    let answer: boolean | Error = true;
    const { button, block, stable } = await mount({
      downloadAttachment: async (asset, fileName) => {
        asked.push([asset, fileName]);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    button('Download')!.click();
    await stable();
    expect(asked).toEqual([[SETTINGS, 'sample-settings.zip']]);
    expect(
      block().querySelector('of-attachment-block')?.getAttribute('data-state'),
    ).toBe('ready');

    answer = false;
    button('Download')!.click();
    await stable();
    expect(
      block().querySelector('of-attachment-block')?.getAttribute('data-state'),
    ).toBe('missing');
    expect(block().textContent).toContain('File not found');
  });

  it('says a failed download in a toast with Retry', async () => {
    const errors: unknown[] = [];
    const toast = TestBed.inject(ToastService);
    vi.spyOn(toast, 'error').mockImplementation((text, options) => {
      errors.push([text, options?.actionLabel]);
      return undefined as never;
    });
    const { button, stable } = await mount({
      downloadAttachment: async () => {
        throw new Error('offline');
      },
    });
    button('Download')!.click();
    await stable();
    expect(errors).toEqual([
      [
        { key: 'editor.docEditor.attachment.failed' },
        { key: 'editor.docEditor.attachment.retry' },
      ],
    ]);
  });

  it('edits through the dialog in one step that Undo takes back', async () => {
    const offered: (AttachmentChoice | null)[] = [];
    let answer: AttachmentChoice | null = null;
    const { button, editor, model, stable } = await mount({
      pickAttachment: async (current) => {
        offered.push(current);
        return answer;
      },
    });
    // Cancelled: nothing changes.
    button('Edit')!.click();
    await stable();
    expect(offered).toEqual([
      {
        asset: SETTINGS,
        name: 'Sample settings',
        description: 'Import them to start.',
        fileName: 'sample-settings.zip',
        mediaType: 'application/zip',
        size: 48_213,
      },
    ]);
    expect(model()).toEqual(MODULE);

    editor.view.dispatch(closeHistory(editor.state.tr));
    answer = { ...CHOICE, description: '' };
    button('Edit')!.click();
    await stable();
    expect(attachmentsOf(model())).toEqual([
      {
        type: 'attachment',
        id: 'settings-file',
        asset: SAMPLE,
        name: 'Sample data',
        fileName: 'sample.json',
        mediaType: 'application/json',
        size: 1234,
      },
    ]);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    editor.commands.undo();
    await stable();
    expect(model()).toEqual(MODULE);
  });

  it('edits on a double click on the block, never on one on its buttons', async () => {
    let asked = 0;
    const { button, block, stable } = await mount({
      pickAttachment: async () => {
        asked += 1;
        return null;
      },
      downloadAttachment: async () => true,
    });
    button('Download')!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
    await stable();
    expect(asked).toBe(0);
    block()
      .querySelector('[data-slot="attachment-name"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await stable();
    expect(asked).toBe(1);
  });

  it('offers no Edit read-only, or without a dialog; Download stays', async () => {
    const pickAttachment = async () => null;
    const downloadAttachment = async () => true;
    const readOnly = await mount(
      { pickAttachment, downloadAttachment },
      MODULE,
      false,
    );
    expect(readOnly.button('Edit')).toBeUndefined();
    expect(readOnly.button('Download')).toBeDefined();
    const none = await mount({ downloadAttachment });
    expect(none.button('Edit')).toBeUndefined();
  });

  it('is deleted, duplicated and moved whole from the block menu', async () => {
    const { editor, model, stable } = await mount({});
    const pos = attachmentPos(editor);
    expect(blockActions(editor.state, pos)).toEqual({
      canDelete: true,
      canDuplicate: true,
      canMoveUp: true,
      canMoveDown: false,
      canUnwrap: false,
    });
    expect(duplicateBlock(editor.view, pos)).toBe(true);
    await stable();
    const [first, copy] = attachmentsOf(model());
    expect(copy).toEqual({ ...ATTACHMENT, id: copy?.id });
    expect(copy?.id).not.toBe(first?.id);
    expect(deleteBlock(editor.view, attachmentPos(editor))).toBe(true);
    await stable();
    expect(attachmentsOf(model())).toHaveLength(1);
  });

  it('is inserted from the toolbar’s Insert menu and "/" only with the dialog, once a file is chosen', async () => {
    expect(SLASH_ITEMS.find((item) => item.id === 'attachment')?.group).toBe(
      'content',
    );
    const without = await mount({});
    atIntro(without.editor);
    expect(
      canInsertBlock(without.editor.state, 'attachment', without.editor),
    ).toBe(false);
    const slash = SLASH_ITEMS.find((item) => item.id === 'attachment')!;
    expect(slash.available?.(without.editor.state, without.editor)).toBe(false);
    expect(await pickAndInsertAttachment(without.editor)).toBe(false);

    let answer: AttachmentChoice | null = null;
    const { editor, model, stable } = await mount({
      pickAttachment: async () => answer,
    });
    atIntro(editor);
    expect(slash.available?.(editor.state, editor)).toBe(true);
    // Cancelled: nothing is inserted.
    expect(await pickAndInsertAttachment(editor)).toBe(false);
    expect(model()).toEqual(MODULE);

    answer = CHOICE;
    expect(insertBlockAt(editor, 'attachment')).toBe(true);
    await stable();
    expect(model().blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'attachment',
      'attachment',
    ]);
    expect(attachmentsOf(model())[0]).toMatchObject({
      asset: SAMPLE,
      name: 'Sample data',
    });
  });
});
