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
import type { Block, Image, Module } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from '../block-editor.component';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import { SAMPLE_MODULE } from '../sample-module';
import { runInsertEntry, SLASH_ITEMS } from '../slash/slash-items';
import { doc, insideText, p, testEditor } from '../testing/test-editor';
import { canInsertBlock, insertBlockAt } from '../editor-commands';
import type { DocBlockSettings, ImageChoice } from './doc-blocks-context';
import {
  insertImage,
  pickAndInsertImage,
  pickAndReplaceImage as replaceIn,
  withDocBlocks,
} from './doc-blocks';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const PUMP = `sha256:${'a'.repeat(64)}`;
const FILTER = `sha256:${'b'.repeat(64)}`;

const CHOICE: ImageChoice = {
  asset: FILTER,
  alt: '  The filter,\nfrom above ',
  caption: 'The filter',
  width: 30,
};

const IMAGE: Image = {
  type: 'image',
  id: 'pump-photo',
  asset: PUMP,
  alt: 'A pump',
  title: [
    { type: 'text', text: 'The ' },
    { type: 'text', text: 'main', marks: [{ type: 'emphasis' }] },
    { type: 'text', text: ' pump' },
  ],
  width: 50,
};

const MODULE: Module = {
  ...SAMPLE_MODULE,
  blocks: [
    {
      type: 'paragraph',
      id: 'intro',
      content: [{ type: 'text', text: 'Intro' }],
    },
    IMAGE,
  ],
};

const imageOf = (module: Module, index = 0): Image => {
  const found = module.blocks.filter(
    (b: Block): b is Image => b.type === 'image',
  );
  const image = found[index];
  if (!image) throw new Error(`no image #${index}`);
  return image;
};

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('inserting an image', () => {
  it('only says where it could go without a choice, and puts the choice there, selected', () => {
    const editor = testEditor(doc(p('Intro', 'intro'), p()));
    editor.commands.setTextSelection(insideText(editor, ''));
    const before = editor.state.doc;
    expect(insertImage(null)(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(insertImage(CHOICE)(editor.state, editor.view.dispatch)).toBe(true);
    // In place of the blank line.
    expect(editor.state.doc.childCount).toBe(2);
    const image = editor.state.doc.child(1);
    expect(image.type.name).toBe('image');
    expect(image.attrs).toMatchObject({
      asset: FILTER,
      alt: 'The filter, from above',
      width: 30,
    });
    expect(image.textContent).toBe('The filter');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    const module = fromEditor(
      normalizeEditorDoc({
        type: 'doc',
        attrs: { moduleId: 'm', schemaVersion: 1, meta: SAMPLE_MODULE.meta },
        content: editor.getJSON().content,
      }),
    );
    expect(imageOf(module)).toMatchObject({
      asset: FILTER,
      alt: 'The filter, from above',
      title: [{ type: 'text', text: 'The filter' }],
      width: 30,
    });
  });

  it('is an atom even without node views, so it moves and deletes whole', () => {
    const schema = getSchema(withDocBlocks(createEditorExtensions(), null));
    expect(schema.nodes['image']?.spec.atom).toBe(true);
    // The schema itself is the model's: the caption is still its content.
    expect(schema.nodes['image']?.spec.content).toBe('title? callout*');
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
  return {
    editor,
    el,
    model: () =>
      fromEditor(
        normalizeEditorDoc(last ?? withoutCaretGaps(editor.getJSON())),
      ),
    stable: async () => {
      await flush();
      fixture.detectChanges();
      await fixture.whenStable();
    },
  };
}

const atIntro = (editor: Editor) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, insideText(editor, 'Intro') + 5),
    ),
  );

describe('the image block in the editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('round-trips unchanged through its node view', async () => {
    const { model } = await mount({});
    expect(model()).toEqual(MODULE);
  });

  it('shows the picture from the page, its caption and alt text, at its width', async () => {
    const asked: string[] = [];
    const { el, stable } = await mount({
      imageSource: async (asset) => {
        asked.push(asset);
        return 'blob:pump';
      },
    });
    await stable();
    const block = el.querySelector<HTMLElement>('[data-node="image"]')!;
    expect(block.getAttribute('contenteditable')).toBe('false');
    const img = block.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:pump');
    expect(img.getAttribute('alt')).toBe('A pump');
    expect(block.textContent).toContain('The main pump');
    expect(block.textContent).toContain('Alt text: A pump');
    expect(
      block.querySelector<HTMLElement>('[data-slot="image-frame"]')!.style
        .width,
    ).toBe('50%');
    expect(asked).toEqual([PUMP]);
  });

  it('says when the picture is missing, and retries one that failed', async () => {
    let fail = true;
    const { el, stable } = await mount({
      imageSource: async () => {
        if (fail) throw new Error('offline');
        return null;
      },
    });
    await stable();
    const block = el.querySelector<HTMLElement>('[data-node="image"]')!;
    expect(block.textContent).toContain('could not be loaded');
    fail = false;
    block.querySelector<HTMLButtonElement>('button')!.click();
    await stable();
    expect(block.textContent).toContain('Image not found');
  });

  it('edits through the picker in one step: a caption left as it was keeps its formatting', async () => {
    const offered: (ImageChoice | null)[] = [];
    let answer: ImageChoice | null = null;
    const { el, editor, model, stable } = await mount({
      pickImage: async (current) => {
        offered.push(current);
        return answer;
      },
    });
    const edit = () =>
      [...el.querySelectorAll<HTMLButtonElement>('[data-node="image"] button')]
        .find((b) => b.textContent?.includes('Edit'))!
        .click();
    // Cancelled: nothing changes.
    edit();
    await stable();
    expect(offered).toEqual([
      { asset: PUMP, alt: 'A pump', caption: 'The main pump', width: 50 },
    ]);
    expect(model()).toEqual(MODULE);

    answer = {
      asset: PUMP,
      alt: 'The pump',
      caption: 'The main pump',
      width: 75,
    };
    edit();
    await stable();
    expect(imageOf(model())).toEqual({ ...IMAGE, alt: 'The pump', width: 75 });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    // Two edits in a row are two steps, however quick.
    editor.view.dispatch(closeHistory(editor.state.tr));
    answer = { asset: FILTER, alt: 'A filter', caption: '', width: 30 };
    edit();
    await stable();
    const image = imageOf(model());
    expect(image).toEqual({
      type: 'image',
      id: 'pump-photo',
      asset: FILTER,
      alt: 'A filter',
      width: 30,
    });
    editor.commands.undo();
    await stable();
    expect(imageOf(model())).toEqual({ ...IMAGE, alt: 'The pump', width: 75 });
  });

  it('keeps its callouts through the picker, and offers the caption without their legends (#498)', async () => {
    const withCallouts: Image = {
      ...IMAGE,
      callouts: [
        {
          id: 'inlet',
          anchor: { x: 0.2, y: 0.3 },
          legend: [{ type: 'text', text: 'Inlet' }],
        },
        {
          id: 'outlet',
          anchor: { x: 0.8, y: 0.3 },
          label: { x: 0.9, y: 0.1 },
          legend: [{ type: 'text', text: 'Outlet' }],
        },
      ],
    };
    const offered: (ImageChoice | null)[] = [];
    let answer: ImageChoice | null = null;
    const { el, editor, model, stable } = await mount(
      {
        pickImage: async (current) => {
          offered.push(current);
          return answer;
        },
      },
      { ...MODULE, blocks: [MODULE.blocks[0]!, withCallouts] },
    );
    const edit = () =>
      [...el.querySelectorAll<HTMLButtonElement>('[data-node="image"] button')]
        .find((b) => b.textContent?.includes('Edit'))!
        .click();
    answer = { asset: PUMP, alt: 'A pump', caption: 'New caption', width: 50 };
    edit();
    await stable();
    expect(offered).toEqual([
      { asset: PUMP, alt: 'A pump', caption: 'The main pump', width: 50 },
    ]);
    expect(imageOf(model())).toEqual({
      ...withCallouts,
      title: [{ type: 'text', text: 'New caption' }],
    });

    // The media library's Replace, by the block's ID, with the caption taken away.
    answer = { asset: FILTER, alt: 'A filter', caption: '', width: 30 };
    editor.view.dispatch(closeHistory(editor.state.tr));
    expect(await replaceIn(editor, 'pump-photo')).toBe(true);
    await stable();
    expect(offered.at(-1)?.caption).toBe('New caption');
    const untitled: Image = { ...withCallouts };
    delete untitled.title;
    expect(imageOf(model())).toEqual({
      ...untitled,
      asset: FILTER,
      alt: 'A filter',
      width: 30,
    });
  });

  it('opens the picker on an image block by its ID (the media library’s Replace), in one step', async () => {
    const offered: (ImageChoice | null)[] = [];
    const { editor, model, stable } = await mount({
      pickImage: async (current) => {
        offered.push(current);
        return {
          asset: FILTER,
          alt: 'A filter',
          caption: 'The main pump',
          width: 50,
        };
      },
    });
    expect(await replaceIn(editor, 'intro')).toBe(false);
    expect(await replaceIn(editor, 'pump-photo')).toBe(true);
    await stable();
    expect(offered).toEqual([
      { asset: PUMP, alt: 'A pump', caption: 'The main pump', width: 50 },
    ]);
    // The caption left as it was keeps its formatting.
    expect(imageOf(model())).toEqual({
      ...IMAGE,
      asset: FILTER,
      alt: 'A filter',
    });
    editor.commands.undo();
    await stable();
    expect(imageOf(model())).toEqual(IMAGE);
  });

  it('does not replace read-only', async () => {
    let asked = false;
    const { editor } = await mount(
      {
        pickImage: async () => {
          asked = true;
          return CHOICE;
        },
      },
      MODULE,
      false,
    );
    expect(await replaceIn(editor, 'pump-photo')).toBe(false);
    expect(asked).toBe(false);
  });

  it('offers no Edit read-only, or without a picker', async () => {
    const pickImage = async () => null;
    const readOnly = await mount({ pickImage }, MODULE, false);
    expect(readOnly.el.querySelector('[data-node="image"] button')).toBeNull();
    const none = await mount({});
    // Only the callouts' own button: no Edit.
    expect(
      none.el.querySelector(
        '[data-node="image"] [data-slot="image-meta"] button',
      ),
    ).toBeNull();
  });

  it('is inserted from the toolbar and "/" only with a picker, once one is chosen', async () => {
    const without = await mount({});
    atIntro(without.editor);
    expect(canInsertBlock(without.editor.state, 'image', without.editor)).toBe(
      false,
    );
    const slash = SLASH_ITEMS.find((item) => item.id === 'image')!;
    expect(slash.available?.(without.editor.state, without.editor)).toBe(false);
    expect(await pickAndInsertImage(without.editor)).toBe(false);

    let answer: ImageChoice | null = null;
    const { editor, model, stable } = await mount({
      pickImage: async () => answer,
    });
    atIntro(editor);
    expect(slash.available?.(editor.state, editor)).toBe(true);
    // Cancelled: nothing is inserted.
    expect(await pickAndInsertImage(editor)).toBe(false);
    expect(model()).toEqual(MODULE);

    answer = CHOICE;
    expect(insertBlockAt(editor, 'image')).toBe(true);
    await stable();
    const module = model();
    expect(module.blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'image',
      'image',
    ]);
    expect(imageOf(module, 0)).toMatchObject({
      asset: FILTER,
      alt: 'The filter, from above',
      width: 30,
    });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  });
});

describe('an image in a procedure step', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  const STEPS: Module = {
    ...SAMPLE_MODULE,
    blocks: [
      {
        type: 'procedure',
        id: 'steps',
        steps: [
          {
            id: 's1',
            content: [{ type: 'text', text: 'Open the cover.' }],
            blocks: [],
          },
          {
            id: 's2',
            content: [{ type: 'text', text: 'Plug in.' }],
            blocks: [],
          },
        ],
      },
    ],
  };

  /** The image alts under each step's text. */
  const stepImages = (module: Module) => {
    const procedure = module.blocks[0];
    if (procedure?.type !== 'procedure') throw new Error('no procedure');
    return procedure.steps.map((s) =>
      s.blocks.map((b) => (b.type === 'image' ? b.alt : b.type)),
    );
  };

  const caretIn = (editor: Editor, text: string) =>
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, insideText(editor, text) + 2),
      ),
    );

  it('is inserted from the Insert menu and "/" under the step text, the step after it untouched', async () => {
    const { editor, model, stable } = await mount(
      { pickImage: async () => CHOICE },
      STEPS,
    );
    const slash = SLASH_ITEMS.find((item) => item.id === 'image')!;
    caretIn(editor, 'Open the cover.');
    expect(slash.available?.(editor.state, editor)).toBe(true);
    runInsertEntry(editor, slash);
    await stable();
    caretIn(editor, 'Open the cover.');
    runInsertEntry(editor, slash);
    await stable();
    // Several per step: the second goes right under the text, above the first.
    expect(stepImages(model())).toEqual([
      ['The filter, from above', 'The filter, from above'],
      [],
    ]);
    const module = model();
    expect(module.blocks).toHaveLength(1);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  });

  it('opens the picker with a file dropped or pasted into a step, and puts the image there', async () => {
    const handed: (File | undefined)[] = [];
    const { editor, model, stable } = await mount(
      {
        pickImage: async (_current, file) => {
          handed.push(file);
          return { ...CHOICE, alt: file?.name ?? '' };
        },
      },
      STEPS,
    );
    const png = new File(['x'], 'pasted.png', { type: 'image/png' });
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });
    caretIn(editor, 'Plug in.');
    const paste = (files: File[]) => {
      const event = new Event('paste', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', { value: { files } });
      return editor.view.someProp('handlePaste', (f) =>
        f(editor.view, event, editor.state.doc.slice(0, 0)),
      );
    };
    // Anything but a picture is left to the editor.
    expect(paste([text])).toBeFalsy();
    // A picture beside text (an office app's copy) is pasted as the text.
    const withText = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(withText, 'clipboardData', {
      value: { files: [png], getData: () => 'Copied text' },
    });
    expect(
      editor.view.someProp('handlePaste', (f) =>
        f(editor.view, withText, editor.state.doc.slice(0, 0)),
      ),
    ).toBeFalsy();
    expect(paste([text, png])).toBe(true);
    await stable();
    expect(handed).toEqual([png]);
    expect(stepImages(model())).toEqual([[], ['pasted.png']]);

    // Dropped on the first step's text: the image goes under it.
    const dropped = new File(['x'], 'dropped.jpg', { type: 'image/jpeg' });
    const at = insideText(editor, 'Open the cover.') + 4;
    const coords = editor.view.posAtCoords;
    editor.view.posAtCoords = () => ({ pos: at, inside: -1 });
    const drop = new Event('drop', { cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [dropped] },
    });
    expect(
      editor.view.someProp('handleDrop', (f) =>
        f(editor.view, drop, editor.state.doc.slice(0, 0), false),
      ),
    ).toBe(true);
    editor.view.posAtCoords = coords;
    await stable();
    expect(handed).toEqual([png, dropped]);
    expect(stepImages(model())).toEqual([['dropped.jpg'], ['pasted.png']]);
  });
});
