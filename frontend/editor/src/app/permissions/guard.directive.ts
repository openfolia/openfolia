import {
  afterRenderEffect,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
  Renderer2,
} from '@angular/core';

import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardTooltipDirective } from '@openfolia/ui/tooltip';

import { PermissionService } from './permission.service';
import type { PermissionRule } from './permissions';

/**
 * Applies the permission helper to a native control: `<button [ofGuard]="{ permission: 'x',
 * blockedReason: reason }">`. Hidden controls get `hidden`; blocked ones get `aria-disabled`,
 * lose their click and show the reason in the library's Tooltip (on hover and on keyboard
 * focus), which is also the accessible description (`aria-describedby` while shown, and
 * `aria-description` always). Native `disabled` is avoided on purpose: a disabled button cannot be focused,
 * so keyboard and screen-reader users would never reach the reason.
 */
@Directive({
  selector: '[ofGuard]',
  hostDirectives: [ZardTooltipDirective],
})
export class GuardDirective {
  readonly ofGuard = input.required<PermissionRule>();

  private readonly service = inject(PermissionService);
  private readonly el =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly renderer = inject(Renderer2);
  private disabled = false;
  /** The guard only removes what it set: `hidden` and `aria-disabled` may come from elsewhere. */
  private setHidden = false;
  /**
   * What `aria-disabled` and `aria-description` were (or were last set to by someone else) while the guard
   * blocks the control: they come back when it is allowed again.
   */
  private ownAriaDisabled: string | null = null;
  private ownDescription: string | null = null;
  private readonly tooltip = inject(ZardTooltipDirective, { self: true });
  /** The reason is a translation key; reading it in the effect follows a language switch. */
  private readonly t = injectTranslate();

  constructor() {
    // Capture phase: runs before the control's own (click) handlers on the same element.
    this.el.addEventListener(
      'click',
      (event) => {
        if (this.disabled) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    // A component on the same element (a Zard button) binds `aria-disabled` itself, and may write
    // it again later (when its `zLoading` ends, say). The guard applies its state after rendering
    // and puts `aria-disabled` back whenever someone else removes it while the control is blocked.
    const observer = new MutationObserver(() => {
      const value = this.el.getAttribute('aria-disabled');
      if (this.disabled && value !== 'true') {
        this.ownAriaDisabled = value;
        this.toggle('aria-disabled', 'true');
      }
    });
    observer.observe(this.el, { attributeFilter: ['aria-disabled'] });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
    afterRenderEffect(() => {
      const state = this.service.state(this.ofGuard());
      const wasDisabled = this.disabled;
      this.disabled = state.kind === 'disabled';
      if (state.kind === 'hidden') {
        this.toggle('hidden', '');
        this.setHidden = true;
      } else if (this.setHidden) {
        this.toggle('hidden', null);
        this.setHidden = false;
      }
      if (state.kind === 'disabled') {
        if (!wasDisabled) {
          this.ownAriaDisabled = this.el.getAttribute('aria-disabled');
          this.ownDescription = this.el.getAttribute('aria-description');
        }
        this.toggle('aria-disabled', 'true');
        const reason = this.t(state.reason);
        this.toggle('aria-description', reason);
        this.tooltip.text.set(reason);
      } else if (wasDisabled) {
        this.toggle('aria-disabled', this.ownAriaDisabled);
        this.toggle('aria-description', this.ownDescription);
        this.tooltip.text.set(null);
      }
    });
  }

  private toggle(name: string, value: string | null): void {
    if (value === null) this.renderer.removeAttribute(this.el, name);
    else this.renderer.setAttribute(this.el, name, value);
  }
}
