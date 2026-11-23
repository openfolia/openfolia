import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  resource,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { isSnippetType } from '@openfolia/content-model/core';
import { ModuleReferenceCardComponent } from '@openfolia/ui/blocks';
import { injectTranslate } from '@openfolia/ui/i18n';

import { BLOCK_TYPE_NAMES, blockChoice } from './block-choices';
import { DOC_BLOCKS, NODE_VIEW } from './doc-blocks-context';

/**
 * The module reference's node view: a card with the referred module's title (looked up through
 * the page, a skeleton meanwhile), "Shared module", and Open. A reference to a module that can't
 * be found, or not seen, says so in words; a title that could not be looked up offers Retry. A
 * new reference has no module yet: "Choose module" opens the page's module picker
 * (`pickModule`), or stays in view, disabled, with the reason when there is none. The picker
 * either fills in the module (whole, kept in sync) or puts a cross-reference to it, in a line of
 * text, in the block's place (a link), or names one block of it (#223: the card says which, by
 * its type and text, and Open goes to that block; a block the module no longer has is said in
 * words). A reference to a snippet (a module of a type the configuration marks `snippet: true`)
 * is labelled "Snippet".
 */
@Component({
  selector: 'of-module-ref-node',
  imports: [ModuleReferenceCardComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let id = moduleId();
    @if (!id) {
      <of-module-reference-card
        [title]="'editor.docEditor.moduleRef.emptyTitle' | transloco"
        [description]="'editor.docEditor.moduleRef.emptyHint' | transloco"
        [openLabel]="'editor.docEditor.moduleRef.choose' | transloco"
        [actionDisabledReason]="pickDisabledReason()"
        (open)="pick()"
      />
    } @else {
      @switch (lookup().kind) {
        @case ('loading') {
          <of-module-reference-card
            [title]="id"
            [loading]="true"
            [shared]="true"
            [mode]="blockId() ? 'block' : 'module'"
            [description]="
              'editor.docEditor.moduleRef.includedHere' | transloco
            "
            [actionDisabledReason]="openDisabledReason()"
            (open)="open(id)"
          />
        }
        @case ('found') {
          <of-module-reference-card
            [title]="lookup().title"
            [shared]="true"
            [sharedLabel]="sharedLabel()"
            [mode]="blockId() ? 'block' : 'module'"
            [problem]="blockState() === 'missing'"
            [description]="foundDescription()"
            [actionDisabledReason]="openDisabledReason()"
            (open)="open(id)"
          />
        }
        @case ('missing') {
          <of-module-reference-card
            [title]="id"
            [problem]="true"
            [description]="'editor.docEditor.moduleRef.missing' | transloco"
            [actionDisabledReason]="openDisabledReason()"
            (open)="open(id)"
          />
        }
        @case ('error') {
          <of-module-reference-card
            [title]="id"
            [problem]="true"
            [description]="
              'editor.docEditor.moduleRef.lookupFailed' | transloco
            "
            [openLabel]="'editor.docEditor.moduleRef.retry' | transloco"
            (open)="retry()"
          />
        }
      }
    }
  `,
})
export class ModuleRefNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly t = injectTranslate();

  protected readonly moduleId = computed(() => {
    const value = this.view.node().attrs['module'];
    return typeof value === 'string' ? value : '';
  });

  /** The one block of the module the reference names (#223); empty: the whole module. */
  protected readonly blockId = computed(() => {
    const value = this.view.node().attrs['block'];
    return typeof value === 'string' ? value : '';
  });

  /**
   * The module's title and type: looked up again only when the module changes, not when other
   * settings do. Through `moduleContent` when the page has it (it knows the type), else the title.
   */
  private readonly title = resource({
    params: () => this.moduleId() || undefined,
    loader: async ({ params }) => {
      const settings = untracked(this.blocks.settings);
      if (settings.moduleContent) {
        const found = await settings.moduleContent(params);
        return found
          ? { title: found.title, type: found.type ?? '', blocks: found.blocks }
          : null;
      }
      const title = (await settings.moduleTitle?.(params)) ?? null;
      return title === null ? null : { title, type: '', blocks: null };
    },
  });

  /** "Snippet" for a reference to a snippet; the card's own "Shared module" otherwise. */
  protected readonly sharedLabel = computed(() => {
    const config = this.blocks.settings().config;
    const type =
      this.title.status() === 'resolved' ? this.title.value()?.type : '';
    return config && type && isSnippetType(config, type)
      ? this.t('editor.docEditor.moduleRef.snippet')
      : '';
  });

  /** Where the title lookup stands. Without a lookup, the ID stands for the title. */
  protected readonly lookup = computed<
    | { kind: 'loading' | 'missing' | 'error'; title: '' }
    | { kind: 'found'; title: string }
  >(() => {
    const settings = this.blocks.settings();
    if (!settings.moduleTitle && !settings.moduleContent)
      return { kind: 'found', title: this.moduleId() };
    const status = this.title.status();
    if (status === 'error') return { kind: 'error', title: '' };
    if (status !== 'resolved' && status !== 'local')
      return { kind: 'loading', title: '' };
    const found = this.title.value();
    return found
      ? { kind: 'found', title: found.title }
      : { kind: 'missing', title: '' };
  });

  /**
   * The named block (#223) as the module holds it: `found` with its label (its type and text),
   * `missing` when the module has no such block, `unknown` when its blocks could not be read here.
   */
  protected readonly blockState = computed(
    (): 'found' | 'missing' | 'unknown' => {
      const block = this.blockId();
      if (!block || this.lookup().kind !== 'found') return 'unknown';
      const blocks =
        this.title.status() === 'resolved' ? this.title.value()?.blocks : null;
      if (!blocks) return 'unknown';
      return blockChoice(blocks, block) ? 'found' : 'missing';
    },
  );

  /** The line under the card's title: where the content is edited, and which block it is. */
  protected readonly foundDescription = computed(() => {
    const block = this.blockId();
    if (!block) return this.t('editor.docEditor.moduleRef.includedHere');
    const state = this.blockState();
    if (state === 'missing')
      return this.t('editor.docEditor.moduleRef.blockMissing', { block });
    const blocks =
      this.title.status() === 'resolved' ? this.title.value()?.blocks : null;
    const choice = blocks ? blockChoice(blocks, block) : undefined;
    const label = choice
      ? [
          this.t(
            BLOCK_TYPE_NAMES[choice.type] ??
              'editor.moduleEditor.outline.types.other',
          ),
          choice.text,
        ]
          .filter(Boolean)
          .join(': ')
      : block;
    return this.t('editor.docEditor.moduleRef.blockHere', { block: label });
  });

  protected readonly pickDisabledReason = computed(() =>
    this.blocks.settings().pickModule && this.blocks.editable()
      ? ''
      : this.t('editor.docEditor.moduleRef.pickerUnavailable'),
  );

  protected readonly openDisabledReason = computed(() =>
    this.blocks.settings().openModule
      ? ''
      : this.t('editor.docEditor.moduleRef.openUnavailable'),
  );

  protected open(id: string): void {
    const block = this.blockId();
    if (block && this.blockState() !== 'missing')
      this.blocks.settings().openModule?.(id, block);
    else this.blocks.settings().openModule?.(id);
  }

  protected retry(): void {
    this.title.reload();
  }

  protected async pick(): Promise<void> {
    const picker = this.blocks.settings().pickModule;
    if (!picker || !this.blocks.editable()) return;
    const next = await picker(this.moduleId() || null);
    if (!next) return;
    if (next.mode === 'whole' || next.mode === 'block') {
      this.view.setAttrs({
        module: next.module,
        block: next.mode === 'block' ? next.block : null,
      });
      // The button that opened the picker is gone: the focus goes to the card's Open.
      setTimeout(() =>
        this.host.nativeElement.querySelector('button')?.focus(),
      );
      return;
    }
    if (next.mode !== 'link') return;
    // A link: a cross-reference in a line of text instead of the reference block. Its text is
    // left out, so it reads as the module's title wherever it is shown.
    this.view.replaceWith({
      type: 'paragraph',
      attrs: { id: null },
      content: [
        {
          type: 'xref',
          attrs: { module: next.module, block: null, text: null },
        },
      ],
    });
  }
}
