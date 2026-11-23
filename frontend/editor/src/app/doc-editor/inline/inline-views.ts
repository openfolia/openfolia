import {
  Extension,
  Node,
  type Editor,
  type Extensions,
  type NodeViewRenderer,
} from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
// The full entry, with zod: this file checks links and module IDs with their schemas at run time.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { isLinkHref, ModuleId } from '@openfolia/content-model';

import {
  documentCallouts,
  refState,
  type EditorVariant,
} from '../blocks/callouts';
import { docBlocksOf, type ShownConfig } from '../blocks/doc-blocks-context';
import { placeholderLabel } from './placeholders';
import {
  atomRequest,
  blockIds,
  blockTargets,
  docBlockIds,
  canInsertInline,
  docTargets,
  isInlineAtom,
  openInlineEdit,
  requestAtSelection,
  type XrefTarget,
  type XrefTargetKind,
} from './inline-edit';

// The inline atoms as the editor shows them: a cross-reference and a text attribute as chips with
// their target's or attribute's name, a callout reference (#547) as its callout's number in the
// chosen variant, a key combination as key caps. A cross-reference whose
// target is gone and an attribute the configuration does not have are inline issues: a dashed
// outline and the problem as the chip's description, never colour alone. Clicking a chip (or
// Enter on a selected one) opens its popover; Mod+K opens the link's. A link opens in a new tab
// only with Ctrl or Cmd held, never on a plain click, and only to an address the model takes.

export type Translate = (
  key: string,
  params?: Record<string, unknown>,
) => string;

/** What the chips show for one atom, handed to its node view through a decoration. */
export interface ChipInfo {
  readonly label: string;
  /** The problem, in the UI language; empty when there is none. */
  readonly issue: string;
  /** Still looking the target up. */
  readonly pending?: boolean;
  /** Read before the label, not shown ("Callout reference" before a callout's number). */
  readonly prefix?: string;
}

type Lookup =
  | { readonly status: 'pending' }
  | { readonly status: 'missing' }
  | { readonly status: 'error' }
  | {
      readonly status: 'found';
      readonly title: string;
      readonly targets: ReadonlyMap<string, XrefTarget>;
      /** Every block and item ID in it: any of them is a valid target. */
      readonly ids: ReadonlySet<string>;
    };

const KIND_KEYS: Readonly<Record<XrefTargetKind, string>> = {
  section: 'editor.docEditor.xref.kind.section',
  figure: 'editor.docEditor.xref.kind.figure',
  table: 'editor.docEditor.xref.kind.table',
  procedure: 'editor.docEditor.xref.kind.procedure',
  step: 'editor.docEditor.xref.kind.step',
};

/** A target's words, else its kind's ("Table"). */
export function targetLabel(target: XrefTarget, t: Translate): string {
  return target.label || t(KIND_KEYS[target.kind]);
}

/** What the chips around the document need to know, besides the document. */
export interface ChipContext {
  readonly config: ShownConfig | null;
  /** Another module, as looked up so far. */
  readonly lookup: (module: string) => Lookup;
  readonly t: Translate;
  /** The variant callouts are numbered in; null: every callout counts. */
  readonly variant?: EditorVariant | null;
}

/** The chip's label and issue for each cross-reference, text attribute and placeholder, by position. */
export function chipInfos(
  doc: ProseMirrorNode,
  context: ChipContext,
): Map<number, ChipInfo> {
  const { t } = context;
  const out = new Map<number, ChipInfo>();
  const own = String(doc.attrs['moduleId'] ?? '');
  const meta = doc.attrs['meta'] as { title?: unknown } | null;
  const ownTitle = typeof meta?.title === 'string' ? meta.title : own;
  let ownTargets: Map<string, XrefTarget> | null = null;
  let ownIds: Set<string> | null = null;
  // A configuration without the list (a partial one, as tests hand in) checks nothing.
  const listed = context.config?.textAttributes;
  const configured = Array.isArray(listed)
    ? new Map(listed.map((a) => [a.id, a.label]))
    : null;
  let callouts: ReturnType<typeof documentCallouts> | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === 'calloutRef') {
      callouts ??= documentCallouts(doc, context.variant ?? null);
      const state = refState(
        callouts,
        String(node.attrs['block'] ?? ''),
        String(node.attrs['callout'] ?? ''),
      );
      const prefix = t('editor.docEditor.calloutRef.chip');
      out.set(
        pos,
        state.status === 'numbered'
          ? { label: String(state.number), issue: '', prefix }
          : {
              label: '?',
              prefix,
              issue: t(
                state.status === 'hidden'
                  ? 'editor.docEditor.calloutRef.hidden'
                  : 'editor.docEditor.calloutRef.missing',
              ),
            },
      );
      return false;
    }
    if (node.type.name === 'placeholder') {
      // A page design's data field (#393): its name, or its key flagged when it is none.
      const key = String(node.attrs['key'] ?? '');
      const label = placeholderLabel(key);
      out.set(pos, {
        label: label ? t(label) : `{${key}}`,
        issue: label ? '' : t('editor.docEditor.placeholder.unknown', { key }),
      });
      return false;
    }
    if (node.type.name === 'attribute') {
      const name = String(node.attrs['name'] ?? '');
      const label = configured?.get(name);
      out.set(pos, {
        label: label ?? name,
        issue:
          configured && label === undefined
            ? t('editor.docEditor.attribute.unknown', { name })
            : '',
      });
      return false;
    }
    if (node.type.name !== 'xref') return true;
    const module = String(node.attrs['module'] ?? '');
    const block =
      typeof node.attrs['block'] === 'string' ? node.attrs['block'] : null;
    const runs = node.attrs['text'];
    const text = Array.isArray(runs)
      ? runs
          .map((r: unknown) =>
            r && typeof (r as { text?: unknown }).text === 'string'
              ? (r as { text: string }).text
              : '',
          )
          .join('')
      : '';
    const broken = (key: string): ChipInfo => ({
      label: text || block || module,
      issue: t(key, { module }),
    });
    if (module === own) {
      if (!block) {
        out.set(pos, { label: text || ownTitle, issue: '' });
        return false;
      }
      ownTargets ??= new Map(docTargets(doc).map((x) => [x.block, x]));
      ownIds ??= docBlockIds(doc);
      const target = ownTargets.get(block);
      out.set(
        pos,
        target
          ? { label: text || targetLabel(target, t), issue: '' }
          : ownIds.has(block)
            ? { label: text || block, issue: '' }
            : broken('editor.docEditor.xref.missingTarget'),
      );
      return false;
    }
    const found = context.lookup(module);
    switch (found.status) {
      case 'pending':
        out.set(pos, { label: text || module, issue: '', pending: true });
        break;
      case 'error':
        out.set(pos, { label: text || module, issue: '' });
        break;
      case 'missing':
        out.set(pos, broken('editor.docEditor.xref.missingModule'));
        break;
      case 'found': {
        if (!block) {
          out.set(pos, { label: text || found.title, issue: '' });
          break;
        }
        const target = found.targets.get(block);
        out.set(
          pos,
          target
            ? { label: text || targetLabel(target, t), issue: '' }
            : found.ids.has(block)
              ? { label: text || block, issue: '' }
              : broken('editor.docEditor.xref.missingTarget'),
        );
        break;
      }
    }
    return false;
  });
  return out;
}

const chipsKey = new PluginKey<DecorationSet>('docEditorInlineChips');

/** Tells the chips to read the settings again (a configuration that arrived, a lookup that ended). */
export function refreshChips(view: EditorView): void {
  if (!view.isDestroyed)
    view.dispatch(view.state.tr.setMeta(chipsKey, 'refresh'));
}

const ISSUE_CLASS = 'doc-editor-issue doc-editor-issue-warning';

function chipDecorations(
  doc: ProseMirrorNode,
  infos: Map<number, ChipInfo>,
): DecorationSet {
  const out: Decoration[] = [];
  for (const [pos, info] of infos) {
    const node = doc.nodeAt(pos);
    if (!node) continue;
    out.push(
      Decoration.node(
        pos,
        pos + node.nodeSize,
        info.issue ? { class: ISSUE_CLASS } : {},
        { chip: info },
      ),
    );
  }
  return DecorationSet.create(doc, out);
}

/** The chip info a node view is handed in its decorations. */
function chipOf(decorations: readonly Decoration[]): ChipInfo | null {
  for (const d of decorations) {
    const chip = (d.spec as { chip?: ChipInfo }).chip;
    if (chip) return chip;
  }
  return null;
}

const CHIP_CLASS =
  'doc-editor-chip cursor-pointer rounded-sm bg-accent px-1 text-accent-foreground';

/** A cross-reference's, text attribute's, placeholder's or callout reference's chip: its label, its issue as a description. */
const chipView =
  (
    name: 'xref' | 'attribute' | 'placeholder' | 'calloutRef',
  ): NodeViewRenderer =>
  ({ node, decorations, view }) => {
    const doc = view.dom.ownerDocument;
    const dom = doc.createElement('span');
    dom.dataset['node'] = name;
    dom.setAttribute('contenteditable', 'false');
    dom.className =
      name === 'calloutRef'
        ? `${CHIP_CLASS} doc-editor-callout-ref tabular-nums motion-safe:transition-shadow motion-safe:duration-150`
        : CHIP_CLASS;
    // What the label is, for screen readers ("Callout reference 2").
    const prefix = doc.createElement('span');
    prefix.className = 'sr-only';
    dom.append(prefix);
    const label = doc.createElement('span');
    const issue = doc.createElement('span');
    issue.className = 'sr-only';
    dom.append(label, issue);
    let current = node;
    const draw = (n: ProseMirrorNode, decos: readonly Decoration[]) => {
      const chip = chipOf(decos);
      const fallback =
        name === 'attribute'
          ? String(n.attrs['name'] ?? '')
          : name === 'calloutRef'
            ? '?'
            : name === 'placeholder'
              ? `{${String(n.attrs['key'] ?? '')}}`
              : String(n.attrs['module'] ?? '');
      label.textContent = chip?.label || fallback;
      if (name === 'calloutRef') {
        // Its callout, for the hover highlighting (#549, `callout-hover.ts`).
        dom.dataset['calloutBlock'] = String(n.attrs['block'] ?? '');
        dom.dataset['callout'] = String(n.attrs['callout'] ?? '');
      }
      prefix.textContent = chip?.prefix ? `${chip.prefix} ` : '';
      const problem = chip?.issue ?? '';
      // Read after the label ("Install: the target is gone"); shown on hover too.
      issue.textContent = problem ? `: ${problem}` : '';
      if (problem) dom.title = problem;
      else dom.removeAttribute('title');
      dom.toggleAttribute('aria-busy', chip?.pending === true);
    };
    draw(node, decorations);
    return {
      dom,
      update(next: ProseMirrorNode, decos: readonly Decoration[]) {
        if (next.type !== current.type) return false;
        current = next;
        draw(next, decos);
        return true;
      },
      ignoreMutation: () => true,
    };
  };

/** A key combination as key caps, one per key, joined by "+". */
const kbdView: NodeViewRenderer = ({ node, view }) => {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement('kbd');
  dom.dataset['node'] = 'kbd';
  dom.setAttribute('contenteditable', 'false');
  dom.className = 'doc-editor-keys cursor-pointer';
  let current = node;
  const draw = (n: ProseMirrorNode) => {
    dom.replaceChildren();
    const keys = Array.isArray(n.attrs['keys'])
      ? (n.attrs['keys'] as unknown[]).map(String)
      : [];
    keys.forEach((key, i) => {
      if (i > 0) {
        const plus = doc.createElement('span');
        plus.className = 'text-muted-foreground px-0.5';
        plus.textContent = '+';
        dom.append(plus);
      }
      const cap = doc.createElement('kbd');
      cap.className = 'doc-editor-key';
      cap.textContent = key;
      dom.append(cap);
    });
  };
  draw(node);
  return {
    dom,
    update(next: ProseMirrorNode) {
      if (next.type !== current.type) return false;
      current = next;
      draw(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};

/**
 * The content model's extensions with the inline atoms drawn as chips and key caps. Without
 * this (a test editor, a server) they keep the model's own HTML.
 */
export function withInlineViews(extensions: Extensions): Extensions {
  return extensions.map((extension) => {
    if (!(extension instanceof Node)) return extension;
    // A placeholder is a chip with no popover: chosen from the `{` menu, never edited in place.
    if (extension.name === 'placeholder')
      return extension.extend({ addNodeView: () => chipView('placeholder') });
    if (!isInlineAtom(extension.name)) return extension;
    const view = extension.name === 'kbd' ? kbdView : chipView(extension.name);
    return extension.extend({ addNodeView: () => view });
  });
}

export interface InlineEditingOptions {
  translate: Translate;
  /** Opens the toolbar's Insert menu (Mod+Shift+Enter); false when there is none. */
  onInsertMenu: () => boolean;
}

/** Whether the click asks for a new tab: Ctrl, or Cmd on a Mac. */
const wantsNewTab = (event: MouseEvent) => event.ctrlKey || event.metaKey;

/**
 * Opens a link's address in a new tab, without an opener, and only an address the model takes
 * (anything else in the document was refused on its way in, but the check is cheap).
 */
export function openLink(view: EditorView, href: unknown): boolean {
  if (!isLinkHref(href)) return false;
  view.dom.ownerDocument.defaultView?.open(
    href,
    '_blank',
    'noopener,noreferrer',
  );
  return true;
}

/** The address of the link at a click's target, if it is in one of this editor's links. */
function linkAt(view: EditorView, target: EventTarget | null): string | null {
  const element =
    target instanceof Element
      ? target
      : target instanceof globalThis.Node
        ? target.parentElement
        : null;
  const anchor = element?.closest('a[data-mark="link"]');
  if (!anchor || !view.dom.contains(anchor)) return null;
  // The document's own value, not the DOM's: a refused address has no `href` there at all.
  const pos = view.posAtDOM(anchor, 0);
  const mark = view.state.schema.marks['link']?.isInSet(
    view.state.doc
      .resolve(Math.min(pos + 1, view.state.doc.content.size))
      .marks(),
  );
  return typeof mark?.attrs['href'] === 'string' ? mark.attrs['href'] : null;
}

/**
 * The inline types' behaviour: the chips' labels and issues (from the document, the
 * configuration and the other modules the page looks up), their popovers, the marks' shortcuts
 * and the links' Ctrl/Cmd+click.
 */
export const InlineEditing = Extension.create<InlineEditingOptions>({
  name: 'inlineEditing',
  addOptions() {
    return { translate: (key) => key, onInsertMenu: () => false };
  },
  addKeyboardShortcuts() {
    const editor = this.editor;
    const insertMenu = this.options.onInsertMenu;
    return {
      'Mod-Shift-Enter': () => editor.isEditable && insertMenu(),
      'Mod-k': () => openInlineEdit(editor, requestAtSelection(editor.state)),
      'Mod-,': () => editor.commands.toggleMark('sub'),
      'Mod-.': () => editor.commands.toggleMark('sup'),
      'Mod-Shift-u': () => editor.commands.toggleMark('ui'),
      // A line break within the text (not in a title, which is one line, nor in code, where
      // Enter is one).
      'Shift-Enter': () => {
        const { state } = editor;
        const type = state.schema.nodes['hardBreak'];
        if (!type || !canInsertInline(state, 'hardBreak')) return false;
        editor.view.dispatch(
          state.tr.replaceSelectionWith(type.create()).scrollIntoView(),
        );
        return true;
      },
      Enter: () => {
        const { selection } = editor.state;
        if (
          !(selection instanceof NodeSelection) ||
          !isInlineAtom(selection.node.type.name)
        )
          return false;
        return openInlineEdit(
          editor,
          atomRequest(editor.state.doc, selection.from),
        );
      },
    };
  },
  addProseMirrorPlugins() {
    const editor: Editor = this.editor;
    const t = this.options.translate;
    const lookups = new Map<string, Lookup>();
    let viewRef: EditorView | null = null;
    const lookup = (module: string): Lookup => {
      const known = lookups.get(module);
      if (known) return known;
      // Only a module ID the model takes is ever looked up (a pasted one may be anything).
      if (!ModuleId.safeParse(module).success) return { status: 'missing' };
      const read = docBlocksOf(editor)?.settings().moduleContent;
      if (!read) return { status: 'error' };
      lookups.set(module, { status: 'pending' });
      read(module).then(
        (content) => {
          lookups.set(
            module,
            content
              ? {
                  status: 'found',
                  title: content.title,
                  targets: new Map(
                    blockTargets(content.blocks).map((x) => [x.block, x]),
                  ),
                  ids: blockIds(content.blocks),
                }
              : { status: 'missing' },
          );
          if (viewRef) refreshChips(viewRef);
        },
        () => {
          lookups.set(module, { status: 'error' });
          if (viewRef) refreshChips(viewRef);
        },
      );
      return { status: 'pending' };
    };
    const compute = (doc: ProseMirrorNode) =>
      chipDecorations(
        doc,
        chipInfos(doc, {
          config: docBlocksOf(editor)?.settings().config ?? null,
          variant: docBlocksOf(editor)?.settings().variant ?? null,
          lookup,
          t,
        }),
      );
    return [
      new Plugin<DecorationSet>({
        key: chipsKey,
        state: {
          init: (_, state) => compute(state.doc),
          apply: (tr, value, _old, state) => {
            const meta = tr.getMeta(chipsKey) as string | undefined;
            if (meta === 'refresh') {
              // A failed lookup is tried again when the page asks (Retry, another configuration).
              for (const [module, found] of lookups)
                if (found.status === 'error') lookups.delete(module);
            }
            return tr.docChanged || meta ? compute(state.doc) : value;
          },
        },
        view: (view) => {
          viewRef = view;
          return {
            destroy: () => {
              viewRef = null;
            },
          };
        },
        props: {
          decorations: (state) => chipsKey.getState(state),
          handleClickOn: (view, _pos, node, nodePos, event, direct) => {
            if (!direct || !isInlineAtom(node.type.name) || !view.editable)
              return false;
            if (wantsNewTab(event)) return false;
            view.dispatch(
              view.state.tr.setSelection(
                NodeSelection.create(view.state.doc, nodePos),
              ),
            );
            return openInlineEdit(editor, atomRequest(view.state.doc, nodePos));
          },
          handleDOMEvents: {
            // A link never opens on a plain click (the caret goes there), and in a new tab only
            // with Ctrl or Cmd held; a middle click opens nothing either.
            click: (view, event) => {
              const href = linkAt(view, event.target);
              if (href === null) return false;
              event.preventDefault();
              if (!wantsNewTab(event)) return false;
              openLink(view, href);
              return true;
            },
            auxclick: (view, event) => {
              if (linkAt(view, event.target) === null) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});
