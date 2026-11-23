import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, vi } from 'vitest';

import { ToastService } from './toast.service';
import { ToasterComponent } from './toaster.component';

describe('ToastService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dismisses a toast after its duration, but keeps an error', () => {
    const service = TestBed.inject(ToastService);
    service.success('Saved');
    service.error('Failed');
    expect(service.toasts()).toHaveLength(2);
    vi.advanceTimersByTime(7000);
    expect(service.toasts().map((t) => t.message)).toEqual(['Failed']);
  });

  it('runs the action once and closes the toast', () => {
    const service = TestBed.inject(ToastService);
    const undo = vi.fn();
    const id = service.success('Deleted', {
      actionLabel: 'Undo',
      onAction: undo,
    });
    service.runAction(id);
    service.runAction(id);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(service.toasts()).toHaveLength(0);
  });

  it('says once why a toast went: its action, its time or a close', () => {
    const service = TestBed.inject(ToastService);
    const reasons: string[] = [];
    const onClose = (reason: string) => reasons.push(reason);
    const undone = service.success('A', {
      actionLabel: 'Undo',
      onAction: () => undefined,
      onClose,
    });
    service.success('B', { duration: 1000, onClose });
    const closed = service.success('C', { duration: 0, onClose });
    service.runAction(undone);
    service.runAction(undone);
    vi.advanceTimersByTime(1000);
    service.dismiss(closed);
    service.dismiss(closed);
    expect(reasons).toEqual(['action', 'timeout', 'dismissed']);
  });

  it('renders the action and a kind word, and undo works from the button', () => {
    const service = TestBed.inject(ToastService);
    const undo = vi.fn();
    const fixture = TestBed.createComponent(ToasterComponent);
    service.success('Deleted', { actionLabel: 'Undo', onAction: undo });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Done: Deleted');
    el.querySelector<HTMLButtonElement>('button')!.click();
    fixture.detectChanges();
    expect(undo).toHaveBeenCalled();
    expect(el.querySelector('[data-kind]')).toBeNull();
  });
});
