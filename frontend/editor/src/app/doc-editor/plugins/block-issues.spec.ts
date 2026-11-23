import {
  BlockIssues,
  blockIssueDecorations,
  findBlock,
  setBlockIssues,
} from './block-issues';
import { doc, inside, p, testEditor } from '../testing/test-editor';

describe('block issues', () => {
  it('marks the blocks that have a problem, the worst severity winning', () => {
    const editor = testEditor(
      doc(p('One', 'one'), p('Two', 'two'), p('Three', 'three')),
      [BlockIssues],
    );
    setBlockIssues(editor.view, [
      { at: 'one', severity: 'warning', text: 'Check this' },
      { at: 'one', severity: 'error', text: 'Fix this' },
      { at: 'three', severity: 'warning', text: 'Maybe' },
      { at: 'gone', severity: 'error', text: 'Not there' },
    ]);
    const found = blockIssueDecorations(editor.state).find();
    expect(found).toHaveLength(2);
    const one = editor.view.dom.querySelector('[data-issue]');
    expect(one?.className).toContain('doc-editor-issue-error');
    expect(one?.getAttribute('data-issue')).toBe('Check this\nFix this');
    // Not an edit: undo has nothing to take back.
    expect(editor.can().undo()).toBe(false);
  });

  it('shows a block not finished yet as a draft, calm, unless something worse is there (#796)', () => {
    const editor = testEditor(doc(p('One', 'one'), p('Two', 'two')), [
      BlockIssues,
    ]);
    setBlockIssues(editor.view, [
      { at: 'one', severity: 'draft', text: 'Not finished' },
      { at: 'two', severity: 'draft', text: 'Not finished' },
      { at: 'two', severity: 'warning', text: 'Check' },
    ]);
    const [one, two] = editor.view.dom.querySelectorAll('[data-issue]');
    expect(one?.className).toContain('doc-editor-issue-draft');
    expect(one?.className).not.toContain('doc-editor-issue-error');
    expect(two?.className).toContain('doc-editor-issue-warning');
  });

  it('follows its block as the document changes, and clears', () => {
    const editor = testEditor(doc(p('One', 'one'), p('Two', 'two')), [
      BlockIssues,
    ]);
    setBlockIssues(editor.view, [
      { at: 'two', severity: 'warning', text: 'Check' },
    ]);
    editor.commands.insertContentAt(inside(editor, 0), 'More ');
    const [deco] = blockIssueDecorations(editor.state).find();
    expect(deco?.from).toBe(findBlock(editor.state.doc, 'two')?.pos);
    setBlockIssues(editor.view, []);
    expect(blockIssueDecorations(editor.state).find()).toHaveLength(0);
  });
});
