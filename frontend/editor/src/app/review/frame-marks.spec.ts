import {
  clearMarks,
  markChanges,
  MARK_ATTR,
  type FramePalette,
} from './frame-marks';

const tone = { bar: 'green', tint: 'honeydew', text: 'green' };
const PALETTE: FramePalette = {
  added: tone,
  changed: { ...tone, tint: '' },
  moved: { ...tone, tint: '' },
};

/** The page shadows `document.getElementById` by a form's name: read past it, as the marks do. */
const byId = (doc: Document, id: string) =>
  Document.prototype.getElementById.call(doc, id);

const page = () =>
  new DOMParser().parseFromString(
    `<!doctype html><body>
      <p id="of-m--p1" style="color: red">Plug in.</p>
      <ol><li id="of-m--s1">Wait.</li></ol>
      <form name="getElementById"></form>
    </body>`,
    'text/html',
  );

describe('frame marks', () => {
  it('marks each block shown with its change in words, and names those missing', () => {
    const doc = page();
    const missing = markChanges(
      doc,
      [
        { elementId: 'of-m--p1', tone: 'added', text: '+ Paragraph added' },
        {
          elementId: 'of-m--s1',
          tone: 'changed',
          text: '~ Step text changed',
        },
        { elementId: 'of-m--gone', tone: 'moved', text: '↕ Moved' },
      ],
      PALETTE,
    );
    expect(missing.map((m) => m.elementId)).toEqual(['of-m--gone']);
    // The page's form named after it does shadow it: the marks went past it.
    expect(typeof doc.getElementById).not.toBe('function');
    const p = byId(doc, 'of-m--p1')!;
    expect(p.getAttribute('style')).toContain('box-shadow');
    expect(p.getAttribute('style')).toContain('background-color:honeydew');
    expect(byId(doc, 'of-m--s1')!.getAttribute('style')).not.toContain(
      'background-color',
    );
    // Its line stands before it; inside a list item, at its start.
    expect(p.previousElementSibling?.textContent).toBe('+ Paragraph added');
    const li = byId(doc, 'of-m--s1')!;
    expect(li.firstElementChild?.getAttribute(MARK_ATTR)).toBe('changed');
    expect(li.firstElementChild?.textContent).toBe('~ Step text changed');
  });

  it('writes its text as text, never as markup', () => {
    const doc = page();
    markChanges(
      doc,
      [{ elementId: 'of-m--p1', tone: 'added', text: '<img src=x>' }],
      PALETTE,
    );
    expect(doc.querySelector('img')).toBeNull();
  });

  it('takes its marks away again, the blocks’ own styles back', () => {
    const doc = page();
    markChanges(
      doc,
      [
        { elementId: 'of-m--p1', tone: 'added', text: '+' },
        { elementId: 'of-m--s1', tone: 'changed', text: '~' },
      ],
      PALETTE,
    );
    clearMarks(doc);
    expect(doc.querySelectorAll(`[${MARK_ATTR}]`).length).toBe(0);
    expect(byId(doc, 'of-m--p1')!.getAttribute('style')).toBe('color: red');
    expect(byId(doc, 'of-m--s1')!.hasAttribute('style')).toBe(false);
  });

  it('never takes the page’s own elements for its marks', () => {
    const doc = page();
    const own = doc.createElement('div');
    own.setAttribute(MARK_ATTR, 'added');
    doc.body.append(own);
    markChanges(
      doc,
      [{ elementId: 'of-m--p1', tone: 'added', text: '+' }],
      PALETTE,
    );
    clearMarks(doc);
    expect(own.isConnected).toBe(true);
  });
});
