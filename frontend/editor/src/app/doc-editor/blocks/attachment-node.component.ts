import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { formatFileSize } from '@openfolia/content-model/core';
import {
  AttachmentBlockComponent,
  type AttachmentBlockState,
} from '@openfolia/ui/blocks';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { fileTypeName } from '../../attachments/attachment-model';
import {
  DOC_BLOCKS,
  NODE_VIEW,
  type AttachmentChoice,
} from './doc-blocks-context';
import { oneLine } from './image-content';

/**
 * The attachment block's node view: an icon by the file's type, its name, its file name, type and
 * size, and its description (`of-attachment-block`, in the image block's frame). Download saves
 * the file through the page (`downloadAttachment`: always as a file, never shown); a file that is
 * not there says so in the block, a download that failed says so in a toast with Retry. Edit (or a
 * double click) opens the page's attach-file dialog (`pickAttachment`) with the block's file, name
 * and description and puts back what comes out in one step that Undo takes back. Read-only, or
 * without a dialog, there is no Edit.
 */
@Component({
  selector: 'of-attachment-node',
  imports: [AttachmentBlockComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', '(dblclick)': 'editOn($event)' },
  template: `
    <of-attachment-block
      [state]="state()"
      [name]="choice().name"
      [description]="choice().description"
      [fileName]="choice().fileName"
      [mediaType]="choice().mediaType"
      [typeLabel]="typeLabel()"
      [sizeLabel]="sizeLabel()"
      [downloadLabel]="downloadLabel()"
      [downloading]="downloading()"
      [actionLabel]="actionLabel()"
      (download)="download()"
      (action)="edit()"
    />
  `,
})
export class AttachmentNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);
  private readonly language = inject(LanguageService);
  private readonly toast = inject(ToastService);
  private readonly t = injectTranslate();

  /** The block as the dialog sees it. */
  protected readonly choice = computed((): AttachmentChoice => {
    const { asset, name, description, fileName, mediaType, size } =
      this.view.node().attrs;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    return {
      asset: text(asset),
      name: text(name),
      description: text(description),
      fileName: text(fileName),
      mediaType: text(mediaType),
      size: typeof size === 'number' ? size : 0,
    };
  });

  /** The last download found no such file (asked again when the file changes). */
  private readonly gone = linkedSignal({
    source: () => this.choice().asset,
    computation: () => false,
  });

  protected readonly downloading = signal(false);

  protected readonly state = computed((): AttachmentBlockState => {
    if (!this.choice().asset) return 'empty';
    return this.gone() ? 'missing' : 'ready';
  });

  protected readonly typeLabel = computed(
    () => fileTypeName(this.choice().mediaType) ?? '',
  );

  protected readonly sizeLabel = computed(() =>
    formatFileSize(this.choice().size, this.language.locale()),
  );

  protected readonly downloadLabel = computed(() =>
    this.choice().asset && this.blocks.settings().downloadAttachment
      ? this.t('editor.docEditor.attachment.download')
      : '',
  );

  protected readonly actionLabel = computed(() =>
    this.blocks.editable() && this.blocks.settings().pickAttachment
      ? this.t('editor.docEditor.attachment.edit')
      : '',
  );

  protected async download(): Promise<void> {
    const save = this.blocks.settings().downloadAttachment;
    const { asset, fileName } = this.choice();
    if (!save || !asset || this.downloading()) return;
    this.downloading.set(true);
    try {
      const saved = await save(asset, fileName);
      this.gone.set(!saved);
    } catch {
      this.toast.error(translated('editor.docEditor.attachment.failed'), {
        actionLabel: translated('editor.docEditor.attachment.retry'),
        onAction: () => void this.download(),
      });
    } finally {
      this.downloading.set(false);
    }
  }

  /** A double click on the block edits it; one on its buttons (Download, Edit) does not. */
  protected editOn(event: MouseEvent): void {
    if ((event.target as Element | null)?.closest('button')) return;
    void this.edit();
  }

  protected async edit(): Promise<void> {
    const pick = this.blocks.settings().pickAttachment;
    if (!pick || !this.blocks.editable()) return;
    const next = await pick(this.choice());
    if (!next) return;
    const description = oneLine(next.description);
    this.view.replace({
      asset: next.asset,
      name: oneLine(next.name),
      description: description || null,
      fileName: next.fileName,
      mediaType: next.mediaType,
      size: next.size,
    });
  }
}
