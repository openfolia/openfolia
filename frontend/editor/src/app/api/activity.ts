import { DestroyRef, DOCUMENT, inject, Injectable } from '@angular/core';

/** A person counts as using the tab for this long after they last did something in it. */
export const ACTIVE_MS = 60_000;

/** What a person does in a tab; never what the page does by itself (scrolling, focus). */
const INPUT = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchmove'];
/** What assistive technology does for a person, and a page could too: only when it did not. */
const TRUSTED_INPUT = ['click', 'input'];

/**
 * Whether a person uses this tab (#378): opening the page counts, then every key, pointer, wheel
 * and touch. A request made while nobody does is marked (`backgroundInterceptor`), so what an
 * open tab asks by itself never keeps a session alive. What happens in a frame does not reach the
 * page: one that shows a document is watched too (`watch`).
 */
@Injectable({ providedIn: 'root' })
export class Activity {
  private last = Date.now();

  constructor() {
    inject(DestroyRef).onDestroy(this.watch(inject(DOCUMENT)));
  }

  /** Counts what a person does in `document` too, until what it answers is called. */
  watch(document: Document): () => void {
    const used = () => (this.last = Date.now());
    const usedWhenTrusted = (event: Event) => event.isTrusted && used();
    const listeners: [string, EventListener][] = [
      ...INPUT.map((type): [string, EventListener] => [type, used]),
      ...TRUSTED_INPUT.map((type): [string, EventListener] => [
        type,
        usedWhenTrusted,
      ]),
    ];
    // Captured: a handler that stops the event does not hide it.
    const options = { capture: true, passive: true };
    // Through the prototype: a frame's content must not be able to shadow it.
    const { addEventListener, removeEventListener } = EventTarget.prototype;
    for (const [type, listener] of listeners) {
      addEventListener.call(document, type, listener, options);
    }
    return () => {
      for (const [type, listener] of listeners) {
        removeEventListener.call(document, type, listener, options);
      }
    };
  }

  /** Whether a person did something here within the last minute. */
  recent(): boolean {
    return Date.now() - this.last < ACTIVE_MS;
  }
}
