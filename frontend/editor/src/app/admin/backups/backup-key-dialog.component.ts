import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCopy,
  lucideDownload,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { keyFileName, keyFileText } from './backups-model';

/** A backup key just made or rotated, shown this once. */
export interface ShownBackupKey {
  readonly identity: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly rotated: boolean;
}

/**
 * The backup key, shown **once** (#529): when it is made and when it is rotated. Copy puts it on
 * the clipboard, Download saves it as a file `backup restore` reads; the warning says no backup
 * can be restored without it. "Done" waits until it was copied or downloaded, or the box saying it
 * is kept is ticked. It lives only in what the page hands over and in this dialog while it is
 * open: never in the address, storage, a log or a toast. A click outside does not close it.
 */
@Component({
  selector: 'of-backup-key-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardCheckboxComponent,
    NgIcon,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCopy,
      lucideDownload,
      lucideTriangleAlert,
    }),
  ],
  template: `
    <z-dialog
      [(zVisible)]="open"
      [zMaskClosable]="false"
      class="sm:max-w-[36rem]"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          (shown()?.rotated
            ? 'editor.admin.backups.keyDialog.rotatedTitle'
            : 'editor.admin.backups.keyDialog.createdTitle'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.backups.keyDialog.description'
            | transloco: { fingerprint: shown()?.fingerprint ?? '' }
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open() && shown(); as once) {
        <section
          class="border-warning/40 bg-warning-muted flex min-w-0 flex-col gap-3 rounded-xl border p-4"
          aria-labelledby="backup-key-once"
        >
          <p
            id="backup-key-once"
            class="text-foreground m-0 flex items-start gap-2 text-sm font-medium break-words"
          >
            <ng-icon
              name="lucideTriangleAlert"
              class="text-warning mt-0.5 shrink-0"
              aria-hidden="true"
            />
            {{ 'editor.admin.backups.keyDialog.warning' | transloco }}
          </p>
          <code
            id="backup-key"
            data-slot="backup-key"
            class="bg-background border-border block rounded-md border p-3 font-mono text-xs break-all select-all"
            [attr.aria-label]="
              'editor.admin.backups.keyDialog.label' | transloco
            "
            >{{ once.identity }}</code
          >
          <div class="flex flex-wrap items-center gap-2">
            <button
              z-button
              type="button"
              data-slot="backup-key-copy"
              (click)="copy()"
            >
              <ng-icon
                [name]="copied() ? 'lucideCheck' : 'lucideCopy'"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{
                (copied()
                  ? 'editor.admin.backups.keyDialog.copied'
                  : 'editor.admin.backups.keyDialog.copy'
                ) | transloco
              }}
            </button>
            <button
              z-button
              zType="outline"
              type="button"
              data-slot="backup-key-download"
              (click)="download()"
            >
              <ng-icon
                [name]="downloaded() ? 'lucideCheck' : 'lucideDownload'"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.admin.backups.keyDialog.download' | transloco }}
            </button>
            <span class="sr-only" aria-live="polite">{{
              copied()
                ? ('editor.admin.backups.keyDialog.copied' | transloco)
                : ''
            }}</span>
          </div>
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ 'editor.admin.backups.keyDialog.where' | transloco }}
          </p>
          @if (once.rotated) {
            <p
              class="text-muted-foreground m-0 text-xs break-words"
              data-slot="backup-key-rotated-note"
            >
              {{ 'editor.admin.backups.keyDialog.rotatedNote' | transloco }}
            </p>
          }
        </section>
        <z-checkbox
          class="text-sm break-words"
          data-slot="backup-key-kept"
          (checkChange)="kept.set($event)"
          >{{ 'editor.admin.backups.keyDialog.kept' | transloco }}</z-checkbox
        >
      }
      <z-dialog-footer>
        <button
          z-button
          type="button"
          data-slot="backup-key-done"
          [zDisabled]="!(kept() || copied() || downloaded())"
          (click)="open.set(false)"
        >
          {{ 'editor.admin.backups.keyDialog.done' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class BackupKeyDialogComponent {
  private readonly toast = inject(ToastService);

  readonly open = model(false);
  readonly shown = input<ShownBackupKey | null>(null);
  protected readonly copied = signal(false);
  protected readonly downloaded = signal(false);
  protected readonly kept = signal(false);

  constructor() {
    // A new key starts neither copied nor kept.
    effect(() => {
      this.shown();
      untracked(() => {
        this.copied.set(false);
        this.downloaded.set(false);
        this.kept.set(false);
      });
    });
  }

  protected async copy(): Promise<void> {
    const once = this.shown();
    if (!once) return;
    try {
      await navigator.clipboard.writeText(once.identity);
      this.copied.set(true);
    } catch {
      // No clipboard (an insecure origin, a refused permission): select it for copying by hand.
      const code = document.getElementById('backup-key');
      const selection = window.getSelection();
      if (code && selection) selection.selectAllChildren(code);
      this.toast.error(translated('editor.admin.backups.keyDialog.copyFailed'));
    }
  }

  protected download(): void {
    const once = this.shown();
    if (!once) return;
    const blob = new Blob(
      [keyFileText(once.identity, once.fingerprint, once.createdAt)],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = keyFileName(once.fingerprint);
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    // Revoked after the click has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.downloaded.set(true);
  }
}
