import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAX_SECTION_DEPTH } from '@openfolia/content-model/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { translated } from '@openfolia/ui/i18n';
import { ZardSelectImports } from '@openfolia/ui/select';

import { setMaxHeadingLevel } from './config-model';
import { SettingsContext } from './settings-context';

/** Settings › Headings: how deep headings may go in a module. */
@Component({
  selector: 'of-settings-headings',
  imports: [TranslocoPipe, ZardSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block max-w-4xl min-w-0' },
  template: `
    @if (ctx.config(); as c) {
      <div
        class="border-border flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 border-y py-3"
      >
        <span class="min-w-0 flex-1 basis-40 text-sm break-words">{{
          'editor.admin.settings.headings.max' | transloco
        }}</span>
        <z-select
          class="w-full sm:w-56"
          zPosition="popper"
          [zAriaLabel]="'editor.admin.settings.headings.max' | transloco"
          [zDisabled]="!ctx.editable()"
          [zValue]="'' + c.maxHeadingLevel"
          (zSelectionChange)="set($any($event))"
        >
          @for (n of levels; track n) {
            <z-select-item [zValue]="'' + n">{{
              'editor.admin.settings.headings.level' | transloco: { level: n }
            }}</z-select-item>
          }
        </z-select>
      </div>
    }
  `,
})
export class HeadingsTopicPage {
  protected readonly ctx = inject(SettingsContext);
  protected readonly levels = Array.from(
    { length: MAX_SECTION_DEPTH },
    (_, i) => i + 1,
  );

  protected set(value: string): void {
    const c = this.ctx.config();
    const level = Number(value);
    if (!c || !Number.isInteger(level) || level === c.maxHeadingLevel) return;
    this.ctx.save(
      setMaxHeadingLevel(c, level),
      translated('editor.admin.settings.changes.headings', { level }),
    );
  }
}
