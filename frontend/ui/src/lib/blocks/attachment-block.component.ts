import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucideFile,
  lucideFileArchive,
  lucideFileAudio,
  lucideFileBraces,
  lucideFileCode,
  lucideFileImage,
  lucideFileSpreadsheet,
  lucideFileText,
  lucideFileVideo,
  lucideFileX,
  lucideLoaderCircle,
  lucidePencil,
} from '@ng-icons/lucide';

import { ZardTooltipImports } from '../tooltip/tooltip.imports';

/**
 * Where an attachment block's file stands: there (`ready`), not found or not visible (`missing`),
 * or not chosen yet (`empty`).
 */
export type AttachmentBlockState = 'ready' | 'missing' | 'empty';

/** The kinds of file an attachment block has an icon for. */
export type AttachmentIcon =
  | 'archive'
  | 'data'
  | 'code'
  | 'text'
  | 'sheet'
  | 'image'
  | 'audio'
  | 'video'
  | 'file';

const ARCHIVES = new Set([
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/java-archive',
  'application/vnd.android.package-archive',
]);
const DATA = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/toml',
  'text/xml',
]);
const SHEETS = new Set([
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
]);
const CODE = new Set(['text/html', 'text/javascript', 'application/x-sh']);

/** The icon for a file of `mediaType`: by its kind, else a plain file. */
export function attachmentIcon(mediaType: string): AttachmentIcon {
  const type = mediaType.toLowerCase();
  if (ARCHIVES.has(type)) return 'archive';
  if (DATA.has(type)) return 'data';
  if (SHEETS.has(type)) return 'sheet';
  if (CODE.has(type)) return 'code';
  if (type === 'application/pdf' || type.startsWith('text/')) return 'text';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'file';
}

const ICONS: Record<AttachmentIcon, string> = {
  archive: 'lucideFileArchive',
  data: 'lucideFileBraces',
  code: 'lucideFileCode',
  text: 'lucideFileText',
  sheet: 'lucideFileSpreadsheet',
  image: 'lucideFileImage',
  audio: 'lucideFileAudio',
  video: 'lucideFileVideo',
  file: 'lucideFile',
};

/**
 * A file attached to a document, in the image block's frame: an icon by the file's type, its
 * name, its file name, type and size on one line under it, and its description. A file that
 * can't be found says so in words, in place of the facts; one not chosen yet says that. The
 * actions sit on the name's line, as the image block's do: Download (`downloadLabel`, emits
 * `download`; `downloading` shows that it is under way and keeps it from being pressed twice) and
 * Edit (`actionLabel`, emits `action`). A `…DisabledReason` keeps its action in view, disabled,
 * and says why. Long names and file names wrap; they never widen the page.
 */
@Component({
  selector: 'of-attachment-block',
  imports: [TranslocoPipe, NgIcon, ...ZardTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideDownload,
      lucideFile,
      lucideFileArchive,
      lucideFileAudio,
      lucideFileBraces,
      lucideFileCode,
      lucideFileImage,
      lucideFileSpreadsheet,
      lucideFileText,
      lucideFileVideo,
      lucideFileX,
      lucideLoaderCircle,
      lucidePencil,
    }),
  ],
  host: {
    class:
      'flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-2 text-card-foreground',
    '[attr.data-state]': 'state()',
  },
  template: `
    <div
      class="bg-muted text-muted-foreground grid size-11 shrink-0 place-items-center rounded-lg"
      data-slot="attachment-icon"
      [attr.data-icon]="state() === 'ready' ? kind() : 'missing'"
      aria-hidden="true"
    >
      <ng-icon [name]="iconName()" size="20" />
    </div>
    <div class="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">
      <p
        class="text-foreground m-0 text-sm font-medium"
        data-slot="attachment-name"
      >
        {{ name() || ('ui.blocks.attachment.unnamed' | transloco) }}
      </p>
      @if (state() === 'ready') {
        <p class="text-muted-foreground m-0" data-slot="attachment-facts">
          {{ facts() }}
        </p>
      } @else {
        <p class="text-destructive m-0" data-slot="attachment-facts">
          {{
            problem() ||
              ((state() === 'missing'
                ? 'ui.blocks.attachment.missing'
                : 'ui.blocks.attachment.empty'
              ) | transloco)
          }}
        </p>
      }
      @if (description()) {
        <p
          class="text-muted-foreground m-0 mt-0.5"
          data-slot="attachment-description"
        >
          {{ description() }}
        </p>
      }
    </div>
    <div class="flex shrink-0 items-center gap-1 self-start pt-0.5">
      @if (downloadLabel()) {
        <button
          type="button"
          class="text-foreground inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
          data-slot="attachment-download"
          [attr.aria-disabled]="downloadBlocked() ? 'true' : null"
          [attr.aria-busy]="downloading() ? 'true' : null"
          [zTooltip]="downloadDisabledReason()"
          (click)="downloadBlocked() || download.emit()"
        >
          @if (downloading()) {
            <ng-icon
              class="animate-spin motion-reduce:animate-none"
              name="lucideLoaderCircle"
              size="12"
              aria-hidden="true"
            />
          } @else {
            <ng-icon name="lucideDownload" size="12" aria-hidden="true" />
          }
          {{ downloadLabel() }}
        </button>
      }
      @if (actionLabel()) {
        <button
          type="button"
          class="text-foreground inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
          data-slot="attachment-action"
          [attr.aria-disabled]="actionDisabledReason() ? 'true' : null"
          [zTooltip]="actionDisabledReason()"
          (click)="actionDisabledReason() || action.emit()"
        >
          <ng-icon name="lucidePencil" size="12" aria-hidden="true" />
          {{ actionLabel() }}
        </button>
      }
    </div>
  `,
})
export class AttachmentBlockComponent {
  readonly state = input<AttachmentBlockState>('ready');
  /** The name readers see, in the document's language. */
  readonly name = input('');
  readonly description = input('');
  /** The name the file is saved under (`config.zip`). */
  readonly fileName = input('');
  /** The file's media type: picks the icon. */
  readonly mediaType = input('');
  /** The type as people read it (`ZIP archive`); the media type when empty. */
  readonly typeLabel = input('');
  /** The size as people read it (`48 kB`). */
  readonly sizeLabel = input('');
  /** Replaces the default words for `missing` and `empty`. */
  readonly problem = input('');
  /** Download's label; empty: no Download. */
  readonly downloadLabel = input('');
  /** Why Download can't be used now; non-empty disables it and shows the reason as its tooltip. */
  readonly downloadDisabledReason = input('');
  /** A download is under way: Download shows it and can't be pressed again meanwhile. */
  readonly downloading = input(false);
  /** The action's label (Edit); empty: no action. */
  readonly actionLabel = input('');
  /** Why the action can't be used now; non-empty disables it and shows the reason as its tooltip. */
  readonly actionDisabledReason = input('');
  readonly download = output<void>();
  readonly action = output<void>();

  protected readonly kind = computed(() => attachmentIcon(this.mediaType()));

  protected readonly iconName = computed(() =>
    this.state() === 'ready' ? ICONS[this.kind()] : 'lucideFileX',
  );

  protected readonly facts = computed(() =>
    [this.fileName(), this.typeLabel() || this.mediaType(), this.sizeLabel()]
      .filter(Boolean)
      .join(' · '),
  );

  protected readonly downloadBlocked = computed(
    () => !!this.downloadDisabledReason() || this.downloading(),
  );
}
