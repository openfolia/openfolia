import { injectTranslate } from '../i18n/text.pipe';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucideCircleCheck,
  lucideInfo,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';

import { TextPipe, type Translatable } from '../i18n/text.pipe';
import { ToastService, type ToastKind } from './toast.service';

const icons: Record<ToastKind, string> = {
  success: 'lucideCircleCheck',
  info: 'lucideInfo',
  warning: 'lucideTriangleAlert',
  error: 'lucideCircleAlert',
};
const kindLabels: Record<ToastKind, string> = {
  success: 'ui.toast.kind.success',
  info: 'ui.toast.kind.info',
  warning: 'ui.toast.kind.warning',
  error: 'ui.toast.kind.error',
};

/**
 * One toast as it looks: inverted (the foreground colour as its background), so it stands out in
 * light and dark alike, with the kind's icon and a hidden word naming the kind, the message, an
 * optional action and a dismiss button. `of-toaster` renders the live ones; a showcase can
 * render one on its own.
 */
@Component({
  selector: 'of-toast',
  imports: [TextPipe, TranslocoPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleAlert,
      lucideCircleCheck,
      lucideInfo,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  host: {
    class:
      'bg-foreground text-background flex items-center gap-2.5 rounded-lg py-2.5 ps-3.5 pe-2 text-sm shadow-lg',
    '[attr.role]': "kind() === 'error' ? 'alert' : 'status'",
    '[attr.data-kind]': 'kind()',
  },
  template: `
    <ng-icon
      [name]="icon()"
      class="shrink-0"
      size="16"
      strokeWidth="1.5"
      aria-hidden="true"
    />
    <p class="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
      <span class="sr-only">{{ kindLabel() | transloco }}: </span
      >{{ message() | ofText }}
    </p>
    @if (actionLabel()) {
      <button
        type="button"
        class="hover:bg-background/15 focus-visible:ring-background/60 shrink-0 rounded-md px-1.5 py-0.5 font-medium outline-none focus-visible:ring-2"
        (click)="action.emit()"
      >
        {{ actionLabel() | ofText }}
      </button>
    }
    <button
      type="button"
      class="text-background/70 hover:bg-background/15 hover:text-background focus-visible:ring-background/60 flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
      [attr.aria-label]="'ui.toast.dismiss' | transloco"
      (click)="dismiss.emit()"
    >
      <ng-icon name="lucideX" size="14" aria-hidden="true" />
    </button>
  `,
})
export class ToastComponent {
  readonly kind = input<ToastKind>('info');
  readonly message = input.required<Translatable>();
  readonly actionLabel = input<Translatable | undefined>(undefined);
  readonly action = output<void>();
  readonly dismiss = output<void>();

  protected readonly icon = computed(() => icons[this.kind()]);
  protected readonly kindLabel = computed(() => kindLabels[this.kind()]);
}

/** Renders the toasts of `ToastService`; mount it once, near the root of the app. */
@Component({
  selector: 'of-toaster',
  imports: [ToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'pointer-events-none fixed max-h-[calc(100dvh-2rem)] overflow-y-auto end-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2',
    role: 'region',
    'aria-live': 'polite',
    '[attr.aria-label]': 'label()',
  },
  template: `
    @for (toast of service.toasts(); track toast.id) {
      <of-toast
        class="pointer-events-auto"
        animate.enter="of-toast-enter"
        animate.leave="of-toast-leave"
        [kind]="toast.kind"
        [message]="toast.message"
        [actionLabel]="toast.actionLabel"
        (action)="service.runAction(toast.id)"
        (dismiss)="service.dismiss(toast.id)"
      />
    }
  `,
})
export class ToasterComponent {
  protected readonly service = inject(ToastService);
  private readonly t = injectTranslate();
  protected readonly label = computed(() => this.t('ui.toast.region'));
}
