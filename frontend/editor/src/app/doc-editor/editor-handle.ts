import { signal } from '@angular/core';
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

import { SelectionMemory } from './plugins/selection-memory';

/**
 * The editor as the UI around it sees it: the instance, a revision that ticks on every
 * transaction (so computed state, such as which marks are active, reads fresh), and the
 * remembered selection for commands that come from outside the editor.
 */
export class EditorHandle {
  readonly revision = signal(0);
  readonly memory = new SelectionMemory();

  constructor(readonly editor: Editor) {
    editor.on('transaction', ({ transaction }) => {
      this.memory.note(editor, transaction);
      this.revision.update((n) => n + 1);
    });
  }

  /** For a command coming from the toolbar or a menu: back where the person was, then run. */
  run<T>(command: (editor: Editor) => T): T {
    this.memory.restore(this.editor);
    return command(this.editor);
  }

  /**
   * The state with the selection where the person was: the live one while the editor has the
   * focus, the remembered one while they are in the toolbar or a menu. Toolbar state reads this.
   */
  state(): EditorState {
    this.revision();
    const { editor } = this;
    const { state } = editor;
    if (editor.isFocused) return state;
    const remembered = this.memory.current(editor);
    return remembered.eq(state.selection)
      ? state
      : state.apply(state.tr.setSelection(remembered));
  }

  /** Reads `read` again on every transaction, inside a computed or a template. */
  read<T>(read: (editor: Editor) => T): T {
    this.revision();
    return read(this.editor);
  }
}
