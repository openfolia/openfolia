import {
  InjectionToken,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import type { Editor } from '@tiptap/core';
import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import {
  type Block,
  type Condition,
  formatCondition,
  isCondition,
  resolveOutputLabels,
  type SafetySeverity,
} from '@openfolia/content-model/core';
import type { VariantCondition } from '@openfolia/ui/blocks';
import type { ShownConfig } from '../../i18n/ui-texts';

import type { SnippetSuggestion } from '../snippets/snippet-match';
import type { EditorVariant } from './callouts';
import type { SnippetSaveRequest } from '../snippets/save-snippet';
import type { TermChoice, WritingAids } from '../writing/writing-aids';

// What the documentation blocks' node views (safety notice, variant block, module reference,
// image) need from the page around the editor: the project's configuration (signal words, symbols,
// variant attributes), the document's language, a way to find a referenced module's title and to
// open it, a way to show an image, and the pickers. Everything organisation-specific comes from
// the configuration.

/** An image block as the image picker hands it over (and is handed it, to edit one). */
export interface ImageChoice {
  /** The image: `sha256:<hash>`. */
  readonly asset: string;
  /** The alt text in the module's language: one line, required. */
  readonly alt: string;
  /** The caption (the block's title) as plain text; empty for none. */
  readonly caption: string;
  /** The width as a percentage of the text column; null leaves it to the output. */
  readonly width: number | null;
}

/** An attachment block as the attach-file dialog hands it over (and is handed it, to edit one). */
export interface AttachmentChoice {
  /** The file: `sha256:<hash>`. */
  readonly asset: string;
  /** The name readers see, in the module's language: one line, required. */
  readonly name: string;
  /** The description in the module's language: one line; empty for none. */
  readonly description: string;
  /** The name the file is saved under (`config.zip`). */
  readonly fileName: string;
  /** The stored file's media type. */
  readonly mediaType: string;
  /** The stored file's size in bytes. */
  readonly size: number;
}

/**
 * The page's side of the documentation blocks. Every field is optional: without a configuration
 * the shipped signal words and the raw IDs show; without a picker its button stays in view,
 * disabled, with the reason.
 */
export type { ShownConfig };

export interface DocBlockSettings {
  /**
   * The project's configuration (`GET /config`), its labels in the interface language (#731,
   * `labelsInUi`).
   */
  readonly config?: ShownConfig | null;
  /** The document's language: the signal words are in it (they follow the manual, not the UI). */
  readonly lang?: string;
  /** A referenced module's title; null when there is no such module, or none the person may see. */
  readonly moduleTitle?: (moduleId: string) => Promise<string | null>;
  /** Opens a referenced module (the module editor's route), at `block` when one is named (#223). */
  readonly openModule?: (moduleId: string, block?: string) => void;
  /**
   * The variant picker: resolves to the variant block's new condition, `remove` (the block's
   * frame goes, its content stays) or null when the person cancelled. Without it the block's
   * "Add variant" button is disabled with the reason.
   */
  readonly pickVariant?: (
    current: Condition | null,
  ) => Promise<VariantPick | null>;
  /**
   * The module reference picker: resolves to the module to refer to and how, or null when the
   * person cancelled. Without it an empty reference's "Choose module" button is disabled with the
   * reason.
   */
  readonly pickModule?: (
    current: string | null,
    options?: ModulePickOptions,
  ) => Promise<ModulePick | null>;
  /**
   * Another module's title and blocks (for a cross-reference into it: its targets, and whether
   * the one it names is still there); null when there is no such module, or none the person may
   * see; rejects when it could not be read. Without it, cross-references into other modules are
   * not checked.
   */
  readonly moduleContent?: (moduleId: string) => Promise<ModuleContent | null>;
  /**
   * The image picker (the insert-image dialog): resolves to the image block's image, alt text,
   * caption and width, or null when the person cancelled. Without it, inserting an image is
   * disabled with the reason, and an image block offers no Edit.
   */
  readonly pickImage?: (
    current: ImageChoice | null,
    /** A file dropped or pasted into the document: the picker starts uploading it, chosen. */
    file?: File,
  ) => Promise<ImageChoice | null>;
  /**
   * An address to show an image at (an object URL), or null when there is no such image or the
   * person may not see it; rejects when it could not be read (the block offers Retry).
   */
  readonly imageSource?: (asset: string) => Promise<string | null>;
  /**
   * An address to show a safety symbol's artwork at (an object URL of a PNG, never of an SVG), or
   * null when it has none; rejects when it could not be read. Without it, or without artwork, a
   * symbol shows its label, marked as without artwork.
   */
  readonly symbolSource?: (id: string) => Promise<string | null>;
  /**
   * The attach-file dialog: resolves to the attachment block's file, name and description, or
   * null when the person cancelled. Without it, inserting an attachment is disabled with the
   * reason, and an attachment block offers no Edit.
   */
  readonly pickAttachment?: (
    current: AttachmentChoice | null,
  ) => Promise<AttachmentChoice | null>;
  /**
   * Saves the attached file to the person's device under `fileName` (always as a file, never
   * shown); resolves to false when there is no such file or the person may not see it, rejects
   * when it could not be read. Without it the block offers no Download.
   */
  readonly downloadAttachment?: (
    asset: string,
    fileName: string,
  ) => Promise<boolean>;
  /**
   * The snippets to suggest while typing: those the person may read, in the document's language,
   * the edited module left out. Without them nothing is suggested.
   */
  readonly snippets?: readonly SnippetSuggestion[];
  /**
   * The writing aids (#247): the writing checks and the terms of the document's language. None:
   * nothing is checked or offered while typing.
   */
  readonly writing?: WritingAids | null;
  /**
   * The term picker (#247): resolves to the term chosen (its preferred variant in the document's
   * language), or null when the person cancelled. Without it "/" Term is not offered.
   */
  readonly pickTerm?: () => Promise<TermChoice | null>;
  /**
   * "Save as snippet" (#309): the selected blocks become a snippet module and a reference takes
   * their place. Without it the action is not offered.
   */
  readonly saveSnippet?: SnippetSaver;
  /**
   * The variant the editor numbers image callouts in (#547): the one the live preview's variant
   * picker shows. Null or absent: every callout counts, whatever its condition.
   */
  readonly variant?: EditorVariant | null;
}

/** The page's side of "Save as snippet". */
export interface SnippetSaver {
  /** Why no snippet can be saved now (a translation key: no draft revision, no snippet type), or null. */
  readonly blocked: string | null;
  /**
   * Asks for the snippet's title, type and ID and creates it with these blocks; once it exists,
   * `request.place` puts the reference in. A creation that fails leaves the document alone.
   */
  readonly save: (request: SnippetSaveRequest) => void;
}

/**
 * How the module picker is opened: `linkOnly` for a cross-reference (nothing is included);
 * `snippet` for a snippet (only snippets listed; as a reference or as a copy).
 */
export interface ModulePickOptions {
  readonly linkOnly?: boolean;
  readonly snippet?: boolean;
}

/** Another module as a cross-reference into it needs it: its title, its type and its blocks. */
export interface ModuleContent {
  readonly title: string;
  /** Its module type, when known (a snippet's reference is labelled so). */
  readonly type?: string;
  readonly blocks: readonly Block[];
}

/** What the variant picker answers: a new condition, or `remove` to take the condition away. */
export type VariantPick = Condition | 'remove';

/**
 * A module chosen in the module picker: included whole (the reference block, kept in sync), one
 * block of it included (#223, `block`: the reference block names it, kept in sync), linked to (a
 * cross-reference in a line of text, in place of the reference block) or, for a snippet, copied
 * (its blocks with new IDs; nothing links back).
 */
export type ModulePick =
  | { readonly module: string; readonly mode: 'whole' | 'link' | 'copy' }
  | { readonly module: string; readonly mode: 'block'; readonly block: string };

/** What every documentation block's node view reads (one per editor). */
export interface DocBlocksContext {
  readonly settings: Signal<DocBlockSettings>;
  /** Whether the document can be changed: the blocks' controls are hidden when it can't. */
  readonly editable: Signal<boolean>;
  /**
   * Whether images offer their callout editor (#547); absent: they do. Not in a page design
   * region (#393): its images carry no callouts.
   */
  readonly callouts?: Signal<boolean>;
  /**
   * The callout hovered or focused anywhere in the editor (#549): a marker on its picture, its row
   * in the callout panel, or a reference chip in the text (under the pointer, or selected with the
   * keyboard). Every part of that callout is highlighted. Absent: no highlighting.
   */
  readonly calloutHover?: WritableSignal<CalloutKey | null>;
  /**
   * A callout to show from outside the image (a style suggestion on its legend, #573): its image
   * opens its callout panel with that callout selected, and scrolls it into view. A new request
   * (`seq`) shows it again. Absent: never asked.
   */
  readonly calloutShow?: Signal<CalloutShowRequest | null>;
}

/** A request to show one callout in its image's callout panel. */
export interface CalloutShowRequest extends CalloutKey {
  /** Counts up with each request, so the same callout can be shown twice. */
  readonly seq: number;
}

/** One image's callout, by the image block's ID and the callout's (#549). */
export interface CalloutKey {
  readonly block: string;
  readonly callout: string;
}

/** Whether two callout keys name the same callout. */
export function sameCallout(
  a: CalloutKey | null | undefined,
  b: CalloutKey | null | undefined,
): boolean {
  return !!a && !!b && a.block === b.block && a.callout === b.callout;
}

/**
 * Sets the hovered callout to `key` (`null`: none) on behalf of one source, which only ever
 * clears a highlight it set itself: leaving a marker does not take away the highlight a chip
 * has just put on.
 */
export function hoverCallout(
  hover: WritableSignal<CalloutKey | null> | undefined,
  key: CalloutKey | null,
  previous: CalloutKey | null,
): void {
  if (!hover) return;
  if (key) {
    if (!sameCallout(hover(), key)) hover.set(key);
  } else if (previous && sameCallout(hover(), previous)) {
    hover.set(null);
  }
}

export const DOC_BLOCKS = new InjectionToken<DocBlocksContext>('DOC_BLOCKS');

/** One node view's node, as its Angular component sees it. */
export interface NodeViewApi {
  /** The node as it is now. */
  readonly node: Signal<ProseMirrorNode>;
  /** Whether the node is selected as a whole. */
  readonly selected: Signal<boolean>;
  /** Changes the node's attributes, in one step that Undo takes back. */
  setAttrs(attrs: Record<string, unknown>): void;
  /** Puts other content (ProseMirror JSON) in the node's place, in one step that Undo takes back. */
  replaceWith(content: Record<string, unknown>): void;
  /**
   * Changes the node's attributes and, unless `content` is undefined, its content, in one step
   * that Undo takes back; the node is selected and the editor has the focus.
   */
  replace(attrs: Record<string, unknown>, content?: Fragment): void;
  /**
   * Puts an empty title first in the node (a procedure's), with the caret in it, in one step that
   * Undo takes back; nothing when the node has one already.
   */
  insertTitle(): void;
  /** Puts the node's content in its place (the frame goes), in one step that Undo takes back. */
  unwrap(): void;
  /**
   * Notes where the caret is in the node now, before a dialog takes the focus. The function it
   * returns puts the caret back there (at the start of the node's content when it was elsewhere)
   * and gives the editor the focus again: after the dialog's answer is applied (#793).
   */
  keepCaret(): () => void;
  /**
   * Writes a change into a transaction on the node at its position (`pos`) and dispatches it
   * when `change` says it changed something: one step that Undo takes back. The selection stays.
   * False when nothing changed, or the document can't be changed.
   */
  change(change: (tr: Transaction, pos: number) => boolean): boolean;
  /** The editor's Undo or Redo (a field of the node view's own hands them on). */
  history(step: 'undo' | 'redo'): boolean;
}

export const NODE_VIEW = new InjectionToken<NodeViewApi>('NODE_VIEW');

/** The context of each editor that has documentation blocks, for commands run on the editor. */
const contexts = new WeakMap<Editor, DocBlocksContext>();

/** Names the context of the documentation blocks in `editor` (the block editor does, once made). */
export function setDocBlocksContext(
  editor: Editor,
  context: DocBlocksContext,
): void {
  contexts.set(editor, context);
}

/** The context of the documentation blocks in `editor`, if it has one. */
export function docBlocksOf(editor: Editor): DocBlocksContext | null {
  return contexts.get(editor) ?? null;
}

/** The safety levels, from the most to the least severe. */
export const SAFETY_LEVELS: readonly SafetySeverity[] = [
  'danger',
  'warning',
  'caution',
  'notice',
];

/** The signal word of each level in the document's language: configured, else shipped. */
export function signalWords(
  settings: DocBlockSettings,
): Record<SafetySeverity, string> {
  const { labels } = resolveOutputLabels(
    settings.lang ?? 'en',
    settings.config?.outputLabels ?? {},
  );
  return {
    danger: labels.danger,
    warning: labels.warning,
    caution: labels.caution,
    notice: labels.notice,
  };
}

/** A level from an attribute value: an unknown one reads as the schema's default. */
export function safetyLevel(value: unknown): SafetySeverity {
  return SAFETY_LEVELS.includes(value as SafetySeverity)
    ? (value as SafetySeverity)
    : 'warning';
}

/** The kinds of an admonition, as the content model has them. */
export const ADMONITION_KINDS = ['note', 'tip', 'important'] as const;
export type AdmonitionKindId = (typeof ADMONITION_KINDS)[number];

/** A kind from an attribute value: an unknown one reads as a note (the schema's default). */
export function admonitionKind(value: unknown): AdmonitionKindId {
  return ADMONITION_KINDS.includes(value as AdmonitionKindId)
    ? (value as AdmonitionKindId)
    : 'note';
}

/** Each admonition kind's word in the document's language: configured, else shipped. */
export function admonitionLabels(
  settings: DocBlockSettings,
): Record<AdmonitionKindId, string> {
  const { labels } = resolveOutputLabels(
    settings.lang ?? 'en',
    settings.config?.outputLabels ?? {},
  );
  return { note: labels.note, tip: labels.tip, important: labels.important };
}

/** The configured safety symbols, and a label for each ID (the ID itself when not configured). */
export function symbolLabel(settings: DocBlockSettings, id: string): string {
  return settings.config?.safetySymbols.find((s) => s.id === id)?.label ?? id;
}

const CMP_SIGNS = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' } as const;

type Simple = Extract<Condition, { op: 'in' } | { op: 'cmp' }>;

/**
 * A condition as chips, one per variant attribute: any listed value of an attribute matches, and
 * every attribute must match (an `all` of simple tests). Names and values show with their
 * configured labels. A condition of another shape (`any`, `not`, nested) shows as its expression
 * in one chip named `ruleLabel`. Null when there is no valid condition yet (a new block).
 */
export function conditionChips(
  when: unknown,
  config: ShownConfig | null | undefined,
  ruleLabel: string,
): VariantCondition[] | null {
  if (!isCondition(when)) return null;
  const condition = when;
  const parts = condition.op === 'all' ? condition.of : [condition];
  const simple = parts.every(
    (part): part is Simple => part.op === 'in' || part.op === 'cmp',
  );
  if (!simple)
    return [{ attribute: ruleLabel, values: [formatCondition(condition)] }];
  const byAttribute = new Map<string, string[]>();
  for (const part of parts as Simple[]) {
    const values = byAttribute.get(part.attr) ?? [];
    if (part.op === 'in') {
      const options = config?.variantAttributes.find((a) => a.id === part.attr);
      const labels =
        options?.kind === 'enum'
          ? part.values.map(
              (v) => options.values.find((o) => o.id === v)?.label ?? v,
            )
          : part.values;
      values.push(...labels);
    } else {
      values.push(`${CMP_SIGNS[part.cmp]} ${part.value}`);
    }
    byAttribute.set(part.attr, values);
  }
  return [...byAttribute].map(([attr, values]) => ({
    attribute:
      config?.variantAttributes.find((a) => a.id === attr)?.label ?? attr,
    values,
  }));
}
