import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import type { JSONContent } from '@tiptap/core';
import {
  ConversionError,
  fromEditor,
  toEditor,
} from '@openfolia/content-editor-model';

// The full entry, with zod: this file parses its sample configuration with the schema at run time.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { ProjectConfig } from '@openfolia/content-model';
import { labelsIn } from '@openfolia/content-model/core';

import { BlockEditorComponent } from './block-editor.component';
import type {
  DocBlockSettings,
  ModuleContent,
} from './blocks/doc-blocks-context';
import { injectTranslate } from '@openfolia/ui/i18n';
import { TranslocoPipe } from '@jsverse/transloco';
import type { Translate } from './editor-commands';
import { SAMPLE_MODULE, SAMPLE_REFERENCED } from './sample-module';

/** The playground's configuration: the text attributes the sample uses, nothing else of note. */
const PLAYGROUND_CONFIG = labelsIn(
  ProjectConfig.parse({
    languages: { source: 'en', targets: [] },
    moduleTypes: [{ id: 'concept', label: 'Concept' }],
    audiences: [{ id: 'all', label: 'Everyone' }],
    textAttributes: [
      { id: 'product-name', label: 'Product name' },
      { id: 'version', label: 'Version' },
    ],
  }),
  'en',
);

/** What the "Content model" section shows: the module, or why the document isn't one. */
export type ModelView =
  { ok: true; json: string } | { ok: false; title: string; message: string };

/** The document as the content model: `fromEditor`'s module, or its error with the block. */
export function modelView(doc: JSONContent, t: Translate): ModelView {
  try {
    return { ok: true, json: JSON.stringify(fromEditor(doc), null, 2) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const block = error instanceof ConversionError ? error.blockId : null;
    return {
      ok: false,
      title:
        block === null
          ? t('editor.docEditor.panel.modelError')
          : t('editor.docEditor.panel.modelBlockError', { block }),
      message,
    };
  }
}

/**
 * The block editor playground, in development builds only (like `/showcase`): the editor seen
 * and tried while it is built, on a sample module loaded through `toEditor`, with the document
 * beside it as ProseMirror JSON and as the content model (`fromEditor`), updated as you type.
 */
@Component({
  selector: 'of-doc-editor-page',
  imports: [BlockEditorComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bg-background text-foreground flex h-dvh flex-col gap-4 p-4 md:p-6',
  },
  template: `
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="text-xl font-semibold">
        {{ 'editor.docEditor.page.title' | transloco }}
      </h1>
      <p class="text-muted-foreground text-sm">
        {{ 'editor.docEditor.page.subtitle' | transloco }}
      </p>
    </header>
    <div class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      <of-block-editor
        class="min-h-80 flex-1 lg:min-w-0"
        [label]="'editor.docEditor.page.documentLabel' | transloco"
        [value]="initial"
        [blocks]="settings"
        (changed)="doc.set($event)"
      />
      <aside
        aria-labelledby="doc-panel-title"
        class="bg-card border-border flex min-h-0 flex-col rounded-xl border lg:w-96"
      >
        <div
          class="border-border flex items-baseline justify-between gap-2 border-b px-4 py-3"
        >
          <h2 id="doc-panel-title" class="text-sm font-medium">
            {{ 'editor.docEditor.panel.title' | transloco }}
          </h2>
          <span class="text-muted-foreground text-xs">{{ blockCount() }}</span>
        </div>
        <section
          aria-labelledby="doc-model-title"
          class="flex min-h-0 flex-1 flex-col"
        >
          <h3
            id="doc-model-title"
            class="text-muted-foreground px-4 pt-3 text-xs font-medium"
          >
            {{ 'editor.docEditor.panel.model' | transloco }}
          </h3>
          @let view = model();
          @if (view.ok) {
            <pre
              tabindex="0"
              aria-labelledby="doc-model-title"
              data-testid="doc-model"
              class="m-0 min-h-32 flex-1 overflow-auto px-4 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
              >{{ view.json }}</pre>
          } @else {
            <div
              role="status"
              data-testid="doc-model-error"
              class="border-destructive/40 bg-destructive/10 text-foreground mx-4 my-2 rounded-md border px-3 py-2 text-xs break-words"
            >
              <p class="font-medium">{{ view.title }}</p>
              <p class="text-muted-foreground mt-1 font-mono">
                {{ view.message }}
              </p>
            </div>
          }
        </section>
        <section
          aria-labelledby="doc-json-title"
          class="border-border flex min-h-0 flex-1 flex-col border-t"
        >
          <h3
            id="doc-json-title"
            class="text-muted-foreground px-4 pt-3 text-xs font-medium"
          >
            {{ 'editor.docEditor.panel.json' | transloco }}
          </h3>
          <pre
            tabindex="0"
            aria-labelledby="doc-json-title"
            data-testid="doc-json"
            class="m-0 min-h-32 flex-1 overflow-auto px-4 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
            >{{ json() }}</pre>
        </section>
      </aside>
    </div>
  `,
})
export class DocEditorPage {
  private readonly t = injectTranslate();
  protected readonly initial: JSONContent = toEditor(SAMPLE_MODULE);
  /** The configuration's text attributes, and the module the sample refers to (for its cross-references). */
  protected readonly settings: DocBlockSettings = {
    config: PLAYGROUND_CONFIG,
    lang: 'en',
    moduleContent: (id) =>
      Promise.resolve<ModuleContent | null>(
        id === SAMPLE_REFERENCED.id
          ? {
              title: SAMPLE_REFERENCED.meta.title,
              blocks: SAMPLE_REFERENCED.blocks,
            }
          : null,
      ),
  };
  /** The document as the editor last handed it on. */
  protected readonly doc = signal<JSONContent>(this.initial);
  protected readonly json = computed(() => JSON.stringify(this.doc(), null, 2));
  protected readonly model = computed(() => modelView(this.doc(), this.t));
  protected readonly blockCount = computed(() =>
    this.t('editor.docEditor.panel.blockCount', {
      count: this.doc().content?.length ?? 0,
    }),
  );
}
