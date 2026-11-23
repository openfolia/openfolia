import {
  ApplicationRef,
  EnvironmentInjector,
  Injector,
  afterEveryRender,
  createComponent,
  signal,
  type AfterRenderRef,
  type Type,
} from '@angular/core';
import type { NodeViewRenderer } from '@tiptap/core';
import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';

import {
  DOC_BLOCKS,
  NODE_VIEW,
  type DocBlocksContext,
} from './doc-blocks-context';
import { noteDeparture, takeFresh } from './block-motion';

/** What an Angular node view needs from the app: where its components live. */
export interface AngularHost {
  readonly injector: EnvironmentInjector;
  readonly appRef: ApplicationRef;
  readonly context: DocBlocksContext;
}

/** Elements inside a node view's own controls: their events are the component's, not the editor's. */
const CONTROLS =
  'button, a, input, select, textarea, [role="menuitem"], [data-node-view-control]';

/**
 * A ProseMirror node view drawn by an Angular component. The component injects `NODE_VIEW` (the
 * node as a signal, whether it is selected, a way to set its attributes) and `DOC_BLOCKS`. With
 * `content`, the editable content goes into an element the component projects with its default
 * `<ng-content />`; ProseMirror keeps that part, the component the rest. Only what is in the
 * content is the document: the rest is not editable (no caret lands in a signal word or a chip),
 * and mutations and events there (the component's own controls) are left to the component.
 */
export function angularNodeView(
  component: Type<unknown>,
  host: AngularHost,
  options: { content: boolean },
): NodeViewRenderer {
  return ({ node, view, getPos, editor }) => {
    const doc = view.dom.ownerDocument;
    const contentDOM = options.content ? doc.createElement('div') : null;
    if (contentDOM) {
      contentDOM.classList.add('doc-block-content');
      contentDOM.dataset['content'] = node.type.name;
    }
    const current = signal(node);
    const selected = signal(false);
    const injector = Injector.create({
      parent: host.injector,
      providers: [
        { provide: DOC_BLOCKS, useValue: host.context },
        {
          provide: NODE_VIEW,
          useValue: {
            node: current.asReadonly(),
            selected: selected.asReadonly(),
            setAttrs(attrs: Record<string, unknown>) {
              const pos = getPos();
              if (typeof pos !== 'number' || !editor.isEditable) return;
              const { state } = view;
              const at = state.doc.nodeAt(pos);
              if (!at) return;
              view.dispatch(
                state.tr.setNodeMarkup(pos, undefined, {
                  ...at.attrs,
                  ...attrs,
                }),
              );
            },
            replaceWith(content: Record<string, unknown>) {
              const pos = getPos();
              if (typeof pos !== 'number' || !editor.isEditable) return;
              const { state } = view;
              const at = state.doc.nodeAt(pos);
              if (!at) return;
              const node = state.schema.nodeFromJSON(content);
              const tr = state.tr.replaceWith(pos, pos + at.nodeSize, node);
              // The caret at the end of what came in, ready to type on.
              tr.setSelection(
                TextSelection.near(tr.doc.resolve(pos + node.nodeSize), -1),
              );
              view.dispatch(tr.scrollIntoView());
              view.focus();
            },
            insertTitle() {
              const pos = getPos();
              if (typeof pos !== 'number' || !editor.isEditable) return;
              const { state } = view;
              const at = state.doc.nodeAt(pos);
              const title = state.schema.nodes['title'];
              if (!at || !title || at.firstChild?.type === title) return;
              if (!at.type.validContent(at.content.addToStart(title.create())))
                return;
              const tr = state.tr.insert(pos + 1, title.create());
              tr.setSelection(TextSelection.create(tr.doc, pos + 2));
              view.dispatch(tr.scrollIntoView());
              view.focus();
            },
            replace(attrs: Record<string, unknown>, content?: Fragment) {
              const pos = getPos();
              if (typeof pos !== 'number' || !editor.isEditable) return;
              const { state } = view;
              const at = state.doc.nodeAt(pos);
              if (!at) return;
              const tr = state.tr;
              if (content !== undefined)
                tr.replaceWith(pos + 1, pos + at.nodeSize - 1, content);
              tr.setNodeMarkup(pos, undefined, { ...at.attrs, ...attrs });
              tr.setSelection(NodeSelection.create(tr.doc, pos));
              view.dispatch(tr);
              view.focus();
            },
            change(change: (tr: Transaction, pos: number) => boolean) {
              const pos = getPos();
              if (typeof pos !== 'number' || !editor.isEditable) return false;
              const tr = view.state.tr;
              if (!change(tr, pos) || !tr.docChanged) return false;
              view.dispatch(tr);
              return true;
            },
            history(step: 'undo' | 'redo') {
              if (!editor.isEditable) return false;
              const run = (
                editor.commands as unknown as Record<
                  string,
                  (() => boolean) | undefined
                >
              )[step];
              return run ? run() : false;
            },
            keepCaret() {
              const before = getPos();
              const { selection, doc } = view.state;
              const node =
                typeof before === 'number' ? doc.nodeAt(before) : null;
              // Where the caret was, from the node's start; null when it was not in the node.
              const offset =
                typeof before === 'number' &&
                node &&
                selection instanceof TextSelection &&
                selection.from > before &&
                selection.to < before + node.nodeSize
                  ? {
                      anchor: selection.anchor - before,
                      head: selection.head - before,
                    }
                  : null;
              return () => {
                const pos = getPos();
                if (typeof pos !== 'number' || !editor.isEditable) return;
                const { state } = view;
                const at = state.doc.nodeAt(pos);
                if (!at) return;
                const inside = (n: number) =>
                  Math.max(pos + 1, Math.min(n, pos + at.nodeSize - 1));
                const tr = state.tr.setSelection(
                  offset
                    ? TextSelection.between(
                        state.doc.resolve(inside(pos + offset.anchor)),
                        state.doc.resolve(inside(pos + offset.head)),
                      )
                    : TextSelection.near(state.doc.resolve(pos + 1), 1),
                );
                view.dispatch(tr.scrollIntoView());
                view.focus();
              };
            },
            unwrap() {
              const pos = getPos();
              if (typeof pos !== 'number' || !editor.isEditable) return;
              const { state } = view;
              const at = state.doc.nodeAt(pos);
              if (!at) return;
              const tr = state.tr.replaceWith(
                pos,
                pos + at.nodeSize,
                at.content,
              );
              // The caret at the start of what was inside.
              tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
              view.dispatch(tr.scrollIntoView());
              view.focus();
            },
          },
        },
      ],
    });
    const ref = createComponent(component, {
      environmentInjector: host.injector,
      elementInjector: injector,
      projectableNodes: contentDOM ? [[contentDOM]] : [],
    });
    host.appRef.attachView(ref.hostView);
    // The content element must be in place before ProseMirror draws into it.
    ref.changeDetectorRef.detectChanges();
    const dom = ref.location.nativeElement as HTMLElement;
    dom.dataset['node'] = node.type.name;
    dom.classList.add('doc-block');
    // Only the content is the document: the frame, its words and its controls take no caret.
    // The content stays part of the editor's one editing host (a nested editing host would
    // take the focus from the editor, and with it the selection), so what is beside the path
    // to it is fenced off instead, again after each render.
    let fencing: AfterRenderRef | null = null;
    if (contentDOM) {
      fence(dom, contentDOM);
      fencing = afterEveryRender(() => fence(dom, contentDOM), {
        injector: ref.injector,
      });
    } else {
      dom.setAttribute('contenteditable', 'false');
    }
    const pos = getPos();
    if (typeof pos === 'number' && takeFresh(view, pos))
      dom.classList.add('doc-block-enter');

    return {
      dom,
      contentDOM,
      update(next: ProseMirrorNode) {
        if (next.type !== current().type) return false;
        current.set(next);
        return true;
      },
      selectNode() {
        selected.set(true);
        dom.classList.add('ProseMirror-selectednode');
      },
      deselectNode() {
        selected.set(false);
        dom.classList.remove('ProseMirror-selectednode');
      },
      stopEvent(event: Event) {
        const target = event.target as Node | null;
        if (!target || contentDOM?.contains(target)) return false;
        const element =
          target instanceof Element ? target : target.parentElement;
        return !!element?.closest(CONTROLS);
      },
      ignoreMutation(mutation) {
        if (!contentDOM) return true;
        if (mutation.type === 'selection') return false;
        return !contentDOM.contains(mutation.target);
      },
      destroy() {
        fencing?.destroy();
        noteDeparture(view, current().attrs['id'], dom);
        host.appRef.detachView(ref.hostView);
        ref.destroy();
      },
    };
  };
}

/**
 * Makes everything in `dom` that is not on the way to `content` uneditable: the elements beside
 * that path, at each level. (The blocks' templates put no bare text there.)
 */
function fence(dom: HTMLElement, content: HTMLElement): void {
  for (
    let inner: HTMLElement = content, outer = content.parentElement;
    outer && inner !== dom;
    inner = outer, outer = outer.parentElement
  ) {
    for (const child of Array.from(outer.childNodes)) {
      if (child === inner) continue;
      if (child instanceof HTMLElement) {
        if (child.getAttribute('contenteditable') !== 'false')
          child.setAttribute('contenteditable', 'false');
      }
    }
  }
}
