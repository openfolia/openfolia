import { TranslocoPipe } from '@jsverse/transloco';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  type EventEmitter,
  forwardRef,
  inject,
  output,
  signal,
  type TemplateRef,
  type ViewContainerRef,
  ViewEncapsulation,
} from '@angular/core';

import type { ClassValue } from 'clsx';

import { ZardButtonComponent } from '../button/button.component';
import { htmlParams } from '../core/html-text';
import { injectTranslate, type TranslatedText } from '../i18n/text.pipe';
import { noopFn } from '../ui/noop';

import { ZardAlertDialogHost } from './alert-dialog-host';
import {
  ALERT_DIALOG_DURATION,
  ZardAlertDialogPanelComponent,
} from './alert-dialog-panel.component';
import type { ZardAlertDialogRef } from './alert-dialog-ref';
import {
  ZardAlertDialogDescriptionComponent,
  ZardAlertDialogFooterComponent,
  ZardAlertDialogHeaderComponent,
  ZardAlertDialogMediaComponent,
  ZardAlertDialogTitleComponent,
} from './alert-dialog.component';
import type { ZardAlertDialogSizeVariants } from './alert-dialog.variants';

export type OnClickCallback<T> = (instance: T) => false | void | object;

export class ZardAlertDialogOptions<T> {
  zCancelText?: string | null;
  zClosable?: boolean;
  zCustomClasses?: ClassValue;
  /** Passed to `zOnOk` and `zOnCancel`, e.g. the id of the record being confirmed. */
  zData?: T;
  /**
   * Description, shown as plain text: a name in it (a person, a group, a title) shows as typed,
   * markup included. Use this for every message, with or without parameters.
   */
  zDescription?: string;
  /**
   * A description whose translation needs markup (emphasis, a line break): its key and
   * parameters, translated by the dialog. Every string parameter (nested ones too) is escaped
   * before it goes into the message, and Angular sanitises the result. Only when there is no
   * `zDescription`. The translation puts parameters in text or quoted attributes only, and a
   * parameter it selects on is a plain word (it is escaped too).
   */
  zDescriptionHtml?: TranslatedText;
  /** Animation duration (ms) used when opening and closing. Defaults to 100 (matches CSS transition). */
  zDuration?: number;
  zMaskClosable?: boolean;
  /**
   * Optional template rendered as a media slot above the title (e.g. an icon).
   * When present, the header layout adapts to align media + title side-by-side
   * on `default` size at sm breakpoint.
   */
  zMedia?: TemplateRef<void>;
  /** Extra classes applied to the media slot wrapper (e.g. tinted backgrounds for destructive). */
  zMediaClass?: ClassValue;
  zOkDestructive?: boolean;
  zOkDisabled?: boolean;
  zOkText?: string | null;
  zOnCancel?: EventEmitter<T> | OnClickCallback<T> = noopFn;
  zOnOk?: EventEmitter<T> | OnClickCallback<T> = noopFn;
  /** Visual size of the dialog. `default` is wider on sm+; `sm` keeps the compact width. */
  zSize?: ZardAlertDialogSizeVariants;
  zTitle?: string | TemplateRef<void>;
  zViewContainerRef?: ViewContainerRef;
  zWidth?: string;
}

/**
 * What `ZardAlertDialogService.create()` attaches to the overlay: the shared
 * `z-alert-dialog-panel` with a header and a footer built from the options.
 *
 * @internal Open alert dialogs through the service; compose `z-alert-dialog` for the declarative form.
 */
@Component({
  selector: 'z-alert-dialog-container',
  imports: [
    TranslocoPipe,
    NgTemplateOutlet,
    ZardButtonComponent,
    ZardAlertDialogPanelComponent,
    ZardAlertDialogHeaderComponent,
    ZardAlertDialogMediaComponent,
    ZardAlertDialogTitleComponent,
    ZardAlertDialogDescriptionComponent,
    ZardAlertDialogFooterComponent,
  ],
  template: `
    <z-alert-dialog-panel
      [zSize]="config.zSize ?? 'default'"
      [zWidth]="config.zWidth"
      [zDuration]="duration()"
      [zState]="state()"
      [zLabelledBy]="titleId()"
      [zDescribedBy]="descriptionId()"
      [class]="config.zCustomClasses"
    >
      @if (
        config.zMedia ||
        config.zTitle ||
        config.zDescription ||
        config.zDescriptionHtml
      ) {
        <z-alert-dialog-header>
          @if (config.zMedia) {
            <z-alert-dialog-media [class]="config.zMediaClass">
              <ng-container [ngTemplateOutlet]="config.zMedia" />
            </z-alert-dialog-media>
          }

          @if (config.zTitle) {
            <z-alert-dialog-title
              data-testid="z-alert-title"
              [zTitle]="config.zTitle"
            />
          }

          @if (config.zDescription) {
            <z-alert-dialog-description data-testid="z-alert-description">
              <span>{{ config.zDescription }}</span>
            </z-alert-dialog-description>
          } @else if (descriptionHtml(); as html) {
            <z-alert-dialog-description data-testid="z-alert-description">
              <!-- eslint-disable-next-line openfolia/no-html-text -- the parameters are escaped (htmlParams) and Angular sanitises the rest -->
              <span [innerHTML]="html"></span>
            </z-alert-dialog-description>
          }
        </z-alert-dialog-header>
      }

      <z-alert-dialog-footer>
        @if (config.zCancelText !== null) {
          <button
            type="button"
            data-testid="z-alert-cancel-button"
            z-button
            zType="outline"
            (click)="cancelTriggered.emit()"
          >
            {{ config.zCancelText || ('ui.dialog.cancel' | transloco) }}
          </button>
        }
        @if (config.zOkText !== null) {
          <button
            type="button"
            data-testid="z-alert-ok-button"
            z-button
            [zType]="config.zOkDestructive ? 'destructive' : 'default'"
            [zDisabled]="config.zOkDisabled"
            (click)="okTriggered.emit()"
          >
            {{ config.zOkText || ('ui.dialog.continue' | transloco) }}
          </button>
        }
      </z-alert-dialog-footer>
    </z-alert-dialog-panel>
  `,
  // forwardRef: the decorator is evaluated before the class binding exists, so a bare
  // reference to ZardAlertDialogContainerComponent here throws "Cannot access before initialization"
  // whenever the module is evaluated outside the AOT compiler.
  providers: [
    {
      provide: ZardAlertDialogHost,
      useExisting: forwardRef(() => ZardAlertDialogContainerComponent),
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { style: 'display: contents' },
  exportAs: 'zAlertDialogContainer',
})
export class ZardAlertDialogContainerComponent<
  T,
> implements ZardAlertDialogHost {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly config = inject(ZardAlertDialogOptions<T>);
  private readonly t = injectTranslate();

  readonly okTriggered = output<void>();
  readonly cancelTriggered = output<void>();

  readonly titleId = signal<string | null>(null);
  readonly descriptionId = signal<string | null>(null);

  protected readonly state = signal<'open' | 'closed'>('open');
  /** `zDescriptionHtml` in the active language, its parameters escaped. */
  protected readonly descriptionHtml = computed(() => {
    const description = this.config.zDescriptionHtml;
    return description
      ? this.t(description.key, htmlParams(description.params ?? {}))
      : null;
  });
  protected readonly duration = computed(
    () => this.config.zDuration ?? ALERT_DIALOG_DURATION,
  );

  alertDialogRef?: ZardAlertDialogRef<T>;

  requestClose(): void {
    this.cancelTriggered.emit();
  }

  /** Plays the exit transition. The ref disposes the overlay once it finishes. */
  leave(): void {
    this.state.set('closed');
  }

  getNativeElement(): HTMLElement {
    return this.host.nativeElement;
  }
}
