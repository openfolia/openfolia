import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert, lucideUpload } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError } from '../../api';
import { apiErrorText } from '../../i18n';
import {
  type DesignFont,
  designFont,
  type Face,
  facesOf,
  type FontFamily,
  type FontFile,
  fontFamilies,
  fontFiles,
  type FontRole,
  withFont,
} from './design-fonts';
import type { PageDesign } from './design-model';
import { SandboxSession } from '../../sandbox/sandbox-session';
import { SandboxNoteComponent } from '../../sandbox/sandbox-note.component';

/** The value of "the standard font" in a role's picker: no family is empty. */
const STANDARD = '';
/** The fonts listed at once: a change set holds at most 100, the designs a few. */
const LISTED = 100;

const ROLE_LABELS: Readonly<Record<FontRole, string>> = {
  body: 'editor.admin.pageDesigns.fonts.body',
  heading: 'editor.admin.pageDesigns.fonts.heading',
};
const FACE_LABELS: Readonly<Record<Face, string>> = {
  regular: 'editor.admin.pageDesigns.fonts.faces.regular',
  bold: 'editor.admin.pageDesigns.fonts.faces.bold',
  italic: 'editor.admin.pageDesigns.fonts.faces.italic',
  boldItalic: 'editor.admin.pageDesigns.fonts.faces.boldItalic',
};

/** What the picker shows of a role's font. */
interface RoleView {
  readonly role: FontRole;
  readonly value: string;
  readonly font: DesignFont | undefined;
  /** The family's file for its regular face, for what it says of its licence. */
  readonly file: FontFile | undefined;
  readonly faces: string;
}

/**
 * The design's fonts (#555): for the body and the headings, the standard font or a family of
 * the uploaded fonts (`GET /assets?filter[type]=font`: those the designs at the change set's
 * branch name and those uploaded into it), with the faces it has and the copyright and licence
 * its file states; and "Upload fonts" (TrueType, OpenType, WOFF, WOFF2) into the change set.
 * Choosing a family names its files for each face (`designFont`); the preview then renders
 * with it.
 */
@Component({
  selector: 'of-design-fonts',
  imports: [
    SandboxNoteComponent,
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    ZardSelectImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideTriangleAlert, lucideUpload })],
  host: { class: 'flex min-w-0 flex-col gap-3', 'data-slot': 'design-fonts' },
  template: `
    @for (r of roles(); track r.role) {
      <div class="flex min-w-0 flex-col gap-1.5" [attr.data-font]="r.role">
        <span class="text-sm font-medium" [id]="'pd-font-' + r.role">{{
          roleLabels[r.role] | transloco
        }}</span>
        <z-select
          class="w-full min-w-0"
          zPosition="popper"
          [attr.data-slot]="'font-pick-' + r.role"
          [zDisabled]="!editable()"
          [zAriaLabel]="
            'editor.admin.pageDesigns.fonts.pick'
              | transloco: { role: (roleLabels[r.role] | transloco) }
          "
          [zValue]="r.value"
          (zSelectionChange)="pick(r.role, $event)"
        >
          <z-select-item [zValue]="standard">{{
            'editor.admin.pageDesigns.fonts.standard' | transloco
          }}</z-select-item>
          @for (f of options(); track f) {
            <z-select-item [zValue]="f">{{ f }}</z-select-item>
          }
        </z-select>
        @if (r.font) {
          <p
            class="text-muted-foreground m-0 text-xs break-words"
            data-slot="font-faces"
          >
            {{
              'editor.admin.pageDesigns.fonts.facesOf'
                | transloco: { faces: r.faces }
            }}
          </p>
          @if (r.file; as file) {
            <div
              class="bg-muted/50 flex min-w-0 flex-col gap-1 rounded-lg p-3 text-xs"
              data-slot="font-licence"
            >
              @if (file.font.copyright) {
                <p class="m-0 break-words" data-slot="font-copyright">
                  {{ file.font.copyright }}
                </p>
              }
              @if (file.font.licence) {
                <p
                  class="text-muted-foreground m-0 line-clamp-4 break-words"
                  data-slot="font-licence-text"
                  [title]="file.font.licence"
                >
                  {{ file.font.licence }}
                </p>
              } @else {
                <p class="text-muted-foreground m-0 break-words">
                  {{ 'editor.admin.pageDesigns.fonts.noLicence' | transloco }}
                </p>
              }
              @if (file.font.licenceUrl) {
                <p class="text-muted-foreground m-0 break-all">
                  {{ file.font.licenceUrl }}
                </p>
              }
            </div>
          } @else if (loaded()) {
            <p
              class="text-warning m-0 flex gap-1.5 text-xs break-words"
              data-slot="font-not-listed"
            >
              <ng-icon
                name="lucideTriangleAlert"
                class="mt-0.5 shrink-0"
                size="14"
                aria-hidden="true"
              />
              {{ 'editor.admin.pageDesigns.fonts.notListed' | transloco }}
            </p>
          }
        }
      </div>
    }
    @if (failed()) {
      <p class="text-destructive m-0 text-xs break-words" role="alert">
        {{ failed() }}
      </p>
    }
    @if (sandbox.on()) {
      <!-- A public sandbox takes no uploads (issue 826): the fonts listed stay to pick from. -->
      <of-sandbox-note [text]="'editor.sandbox.uploadsOffFonts' | transloco" />
    } @else if (changeSetId()) {
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <input
          #file
          type="file"
          class="sr-only"
          tabindex="-1"
          multiple
          accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
          data-slot="font-upload-input"
          aria-labelledby="pd-font-upload"
          (change)="upload(file)"
        />
        <button
          z-button
          zType="outline"
          zSize="sm"
          type="button"
          id="pd-font-upload"
          data-slot="font-upload"
          [disabled]="!editable()"
          [zLoading]="uploading()"
          (click)="file.click()"
        >
          <ng-icon name="lucideUpload" aria-hidden="true" />
          {{ 'editor.admin.pageDesigns.fonts.upload' | transloco }}
        </button>
        <span class="text-muted-foreground min-w-0 text-xs break-words">{{
          'editor.admin.pageDesigns.fonts.uploadHint' | transloco
        }}</span>
      </div>
    }
  `,
})
export class DesignFontsComponent {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly t = injectTranslate();

  /** The design's fonts. */
  readonly fonts = input.required<PageDesign['fonts']>();
  readonly editable = input(false);
  /** The change set fonts are uploaded into; null: none (read only). */
  readonly changeSetId = input<string | null>(null);
  /** The design's fonts, changed. */
  readonly fontsChange = output<PageDesign['fonts']>();

  protected readonly roleLabels = ROLE_LABELS;
  protected readonly standard = STANDARD;

  private readonly files = signal<readonly FontFile[]>([]);
  protected readonly loaded = signal(false);
  protected readonly uploading = signal(false);
  protected readonly failed = signal<string | null>(null);
  private reads = 0;
  /**
   * Files chosen while others upload, each with the change set it was chosen in: taken after
   * them, into that change set, never dropped while the screen is open.
   */
  private readonly queued: { file: File; changeSetId: string }[] = [];

  private readonly families = computed(() => fontFamilies(this.files()));

  /** The families to pick from, those the design names but no listed file has too. */
  protected readonly options = computed(() => {
    const names = new Set(this.families().map((f) => f.family));
    const fonts = this.fonts();
    for (const font of [fonts.body, fonts.heading]) {
      if (font) names.add(font.family);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  });

  protected readonly roles = computed((): RoleView[] => {
    const fonts = this.fonts();
    const byReference = new Map(this.files().map((f) => [f.reference, f]));
    return (['body', 'heading'] as const).map((role) => {
      const font = fonts[role];
      return {
        role,
        value: font?.family ?? STANDARD,
        font,
        file: font ? byReference.get(font.regular) : undefined,
        faces: font
          ? facesOf(font)
              .map((face) => this.t(FACE_LABELS[face]))
              .join(', ')
          : '',
      };
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.queued.length = 0));
    effect(() => {
      const changeSetId = this.changeSetId();
      untracked(() => void this.read(changeSetId));
    });
  }

  protected pick(role: FontRole, value: string | string[]): void {
    const family = Array.isArray(value) ? value[0] : value;
    if (family === undefined || !this.editable()) return;
    const fonts = this.fonts();
    if (family === STANDARD) {
      this.fontsChange.emit(withFont(fonts, role, undefined));
      return;
    }
    const found: FontFamily | undefined = this.families().find(
      (f) => f.family === family,
    );
    const font = found && designFont(found);
    // A family no listed file has (its files are missing) stays as the design names it; the
    // same family picked again takes faces uploaded since.
    if (!font || JSON.stringify(fonts[role]) === JSON.stringify(font)) return;
    this.fontsChange.emit(withFont(fonts, role, font));
  }

  protected async upload(input: HTMLInputElement): Promise<void> {
    const changeSetId = this.changeSetId();
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!changeSetId) return;
    this.queued.push(...files.map((file) => ({ file, changeSetId })));
    if (this.uploading()) return;
    this.uploading.set(true);
    try {
      // Until nothing is left: files chosen while the list is read go after it.
      while (this.queued.length > 0) {
        await this.uploadQueued();
        // The change set shown now: another may have been opened meanwhile.
        await this.read(this.changeSetId());
      }
    } finally {
      this.uploading.set(false);
    }
  }

  private async uploadQueued(): Promise<void> {
    for (let next = this.queued.shift(); next; next = this.queued.shift()) {
      const { file, changeSetId } = next;
      try {
        await firstValueFrom(
          this.api.upload(
            '/change-sets/{changeSetId}/assets',
            { path: { changeSetId }, kind: 'font' },
            file,
          ),
        );
        this.toast.success(
          translated('editor.admin.pageDesigns.fonts.uploaded', {
            name: file.name,
          }),
        );
      } catch (error) {
        const why = apiErrorText(toApiError(error));
        this.toast.error(
          translated('editor.admin.pageDesigns.fonts.uploadFailed', {
            name: file.name,
            why: this.t(why.key, why.params),
          }),
        );
      }
    }
  }

  /** The fonts at the change set's branch and those uploaded into it; the old list stays meanwhile. */
  private async read(changeSetId: string | null): Promise<void> {
    const read = ++this.reads;
    try {
      const doc = await firstValueFrom(
        this.api.get('/assets', {
          query: {
            'filter[type]': 'font',
            ...(changeSetId ? { 'filter[changeSet]': changeSetId } : {}),
            ...pageQuery({ number: 1, size: LISTED }),
          },
        }),
      );
      if (read !== this.reads) return;
      this.files.set(fontFiles(doc.data));
      this.failed.set(null);
    } catch (error) {
      if (read !== this.reads) return;
      const why = apiErrorText(toApiError(error));
      this.failed.set(
        this.t('editor.admin.pageDesigns.fonts.listFailed', {
          why: this.t(why.key, why.params),
        }),
      );
    } finally {
      if (read === this.reads) this.loaded.set(true);
    }
  }
}
