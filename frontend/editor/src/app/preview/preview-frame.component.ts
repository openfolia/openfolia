import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** Where the page is scrolled to: a block's element (`id`) and how far below the top it sits. */
export interface ScrollAnchor {
  readonly id: string;
  readonly offset: number;
}

/** The renderer's prefix of the IDs it gives blocks and modules (`@openfolia/render-html`). */
const ID_PREFIX = 'of-';

/**
 * A term link's definition is shown while it is hovered or focused (#245, CSS only); Escape hides
 * it again until the pointer or focus moves on, as `dismissTermOnEscape` of `@openfolia/render-html`
 * does where a page runs script: its class names.
 */
const TERM_OPEN = '.of-term:hover, .of-term:focus-within';
const TERM_DISMISSED = 'of-term--dismissed';

/**
 * Image callouts (#549): a callout's marker, leader line, legend entry and references carry one
 * key (`data-callout`); while one of them is hovered or focused, all of them get the highlight
 * class, as `highlightCallouts` of `@openfolia/render-html` does where a page runs script.
 */
const CALLOUT_KEY = 'data-callout';
const CALLOUT_HIGHLIGHTED = 'of-callout--highlighted';

/**
 * The frame document's members, read from the prototypes: an element in the content could shadow
 * a member of the document itself by its name (named access), so the document's own are used.
 */
const documentElementOf = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'documentElement',
)?.get as (this: Document) => Element | null;
const querySelectorOf = Document.prototype.querySelector;
const querySelectorAllOf = Document.prototype.querySelectorAll;
const getElementByIdOf = Document.prototype.getElementById;
const scrollingElementOf = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'scrollingElement',
)?.get as (this: Document) => Element | null;
const rectOf = Element.prototype.getBoundingClientRect;
const closestOf = Element.prototype.closest;
const getAttributeOf = Element.prototype.getAttribute;
const scrollTop = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollTop',
) as PropertyDescriptor & {
  get: (this: Element) => number;
  set: (this: Element, value: number) => void;
};

/**
 * The tallest a fitted frame grows: a page that draws an endless body stays bounded (what lies
 * past it is cut off).
 */
const MAX_HEIGHT = 200_000;

/**
 * The rendered page in a sandboxed frame: `sandbox="allow-same-origin"` and nothing else, so no
 * script runs in it, it opens no window, submits no form and cannot navigate this page. Its
 * document is the one `previewDocument` wrote (a CSP of its own, only the API's stylesheets,
 * images as `blob:` URLs), set as `srcdoc` on the element itself: Angular's `[srcdoc]` binding
 * would run its HTML sanitizer, which drops the stylesheets and the IDs the links lead to.
 *
 * Same origin without scripts lets this component reach into the frame: it follows the theme
 * without loading the page again, and handles links: a `#fragment` scrolls the frame to it, an
 * outside link opens in a new tab without an opener (never inside the frame). A click elsewhere
 * names the block it is in (`blockClick`), and the scroll position can be taken by block
 * (`anchor`) and given to the next page (`restore`), so a page rendered again keeps its place.
 * Hovering or focusing an image callout's marker, legend entry or reference highlights all of
 * them (#549). Every member of the frame's document it uses is read from the prototypes.
 */

@Component({
  selector: 'of-preview-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    // `fit`: as tall as its page, so the page around it scrolls instead.
    '[style.height.px]': 'fit() ? height() : null',
  },
  template: `
    <iframe
      #frame
      class="bg-background block size-full border-0"
      sandbox="allow-same-origin"
      referrerpolicy="no-referrer"
      [attr.title]="label()"
    ></iframe>
  `,
})
export class PreviewFrameComponent {
  /** The document to show (`previewDocument`). */
  readonly document = input.required<string>();
  readonly dark = input(false);
  /** The frame's accessible name. */
  readonly label = input('');
  /** The frame takes its page's height (no scrolling of its own). */
  readonly fit = input(false);
  /** The document has loaded (and its theme and links are set up). */
  readonly loaded = output<void>();
  /** A click in the page outside a link: the ID of the innermost block it is in (no prefix). */
  readonly blockClick = output<string>();

  private readonly frame =
    viewChild.required<ElementRef<HTMLIFrameElement>>('frame');
  /** The page's height, measured (`fit`). */
  protected readonly height = signal<number | null>(null);

  constructor() {
    const destroyRef = inject(DestroyRef);
    let detach: (() => void) | undefined;
    effect(() => {
      const frame = this.frame().nativeElement;
      const html = this.document();
      if (frame.srcdoc !== html) frame.srcdoc = html;
    });
    effect(() => {
      const dark = this.dark();
      this.applyTheme(this.frame().nativeElement.contentDocument, dark);
    });
    effect((onCleanup) => {
      const frame = this.frame().nativeElement;
      const onLoad = () => {
        detach?.();
        const doc = frame.contentDocument;
        if (!doc) return;
        this.applyTheme(doc, this.dark());
        const onClick = (event: MouseEvent) => this.follow(doc, event);
        // Escape, pressed in the frame or (the pointer over a term) on this page.
        const onKey = (event: KeyboardEvent) => {
          if (event.key === 'Escape') dismissTerms(doc);
        };
        const onMove = (event: Event) => undismissTerms(doc, event.target);
        const callouts = calloutHighlight(doc);
        let sizes: ResizeObserver | undefined;
        if (this.fit() && typeof ResizeObserver !== 'undefined') {
          // The body's own height: the root's would grow with the frame it fills.
          const body = (
            Object.getOwnPropertyDescriptor(Document.prototype, 'body')
              ?.get as (this: Document) => HTMLElement | null
          ).call(doc);
          const measure = () => {
            if (!body) return;
            const style = getComputedStyle(body);
            const margins =
              parseFloat(style.marginTop) + parseFloat(style.marginBottom);
            this.height.set(
              Math.min(
                MAX_HEIGHT,
                Math.ceil(rectOf.call(body).height + margins),
              ),
            );
          };
          measure();
          sizes = new ResizeObserver(measure);
          if (body) sizes.observe(body);
        }
        // Through the prototypes: the frame's content must not be able to shadow them.
        EventTarget.prototype.addEventListener.call(
          doc,
          'click',
          onClick as EventListener,
        );
        const listened: [EventTarget, string, EventListener][] = [
          [doc, 'keydown', onKey as EventListener],
          [document, 'keydown', onKey as EventListener],
          [doc, 'mouseover', onMove],
          [doc, 'focusin', onMove],
          [doc, 'mouseover', callouts.over],
          [doc, 'mouseout', callouts.out],
          [doc, 'focusin', callouts.focus],
          [doc, 'focusout', callouts.blur],
        ];
        for (const [target, type, listener] of listened) {
          EventTarget.prototype.addEventListener.call(target, type, listener);
        }
        detach = () => {
          sizes?.disconnect();
          EventTarget.prototype.removeEventListener.call(
            doc,
            'click',
            onClick as EventListener,
          );
          for (const [target, type, listener] of listened) {
            EventTarget.prototype.removeEventListener.call(
              target,
              type,
              listener,
            );
          }
        };
        this.loaded.emit();
      };
      frame.addEventListener('load', onLoad);
      onCleanup(() => frame.removeEventListener('load', onLoad));
    });
    destroyRef.onDestroy(() => detach?.());
  }

  /** The page's document once loaded (same origin, no scripts): for marking what it shows. */
  content(): Document | null {
    return this.frame().nativeElement.contentDocument;
  }

  /** The topmost block in view and its distance from the top; null before a page is there. */
  anchor(): ScrollAnchor | null {
    const doc = this.frame().nativeElement.contentDocument;
    if (!doc) return null;
    const blocks = querySelectorAllOf.call(
      doc,
      `[id^="${ID_PREFIX}"]`,
    ) as NodeListOf<Element>;
    // The first in document order whose bottom is below the top: the one the reader is at.
    for (const element of blocks) {
      const rect = rectOf.call(element);
      if (rect.bottom > 0 && rect.height > 0) {
        const id = getAttributeOf.call(element, 'id') ?? '';
        return { id, offset: Math.round(rect.top) };
      }
    }
    return null;
  }

  /** Scrolls the page so the anchor's block sits where it was; a block no longer there: left as it is. */
  restore(anchor: ScrollAnchor | null): void {
    const doc = this.frame().nativeElement.contentDocument;
    if (!doc || !anchor) return;
    const element = getElementByIdOf.call(doc, anchor.id) as Element | null;
    const scroller = scrollingElementOf.call(doc);
    if (!element || !scroller) return;
    const delta = rectOf.call(element).top - anchor.offset;
    scrollTop.set.call(scroller, scrollTop.get.call(scroller) + delta);
  }

  private applyTheme(doc: Document | null | undefined, dark: boolean): void {
    if (!doc) return;
    const root = documentElementOf.call(doc) as HTMLElement | null;
    root?.classList.toggle('dark', dark);
    (
      querySelectorOf.call(doc, 'meta[name="color-scheme"]') as Element | null
    )?.setAttribute('content', dark ? 'dark' : 'light');
  }

  /** A link in the frame: a fragment scrolls to its target, anything else opens in a new tab. */
  private follow(doc: Document, event: MouseEvent): void {
    const target = event.target;
    const element =
      target && typeof (target as Element).closest === 'function'
        ? (target as Element)
        : (target as Node | null)?.parentElement;
    const link = element ? closestOf.call(element, 'a[href]') : null;
    if (!link) {
      const block = element
        ? (closestOf.call(element, `[id^="${ID_PREFIX}"]`) as Element | null)
        : null;
      const id = block ? (getAttributeOf.call(block, 'id') ?? '') : '';
      // `of-_…`: the renderer's own (the glossary, its entries), never a block.
      if (id.startsWith(ID_PREFIX) && id[ID_PREFIX.length] !== '_')
        this.blockClick.emit(id.slice(ID_PREFIX.length));
      return;
    }
    event.preventDefault();
    const href = getAttributeOf.call(link, 'href') ?? '';
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // Not encoded: the ID as written.
      }
      (getElementByIdOf.call(doc, id) as HTMLElement | null)?.scrollIntoView({
        block: 'start',
      });
      return;
    }
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  }
}

const classListOf = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'classList',
)?.get as (this: Element) => DOMTokenList;
const containsOf = Node.prototype.contains;
const nodeTypeOf = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType')
  ?.get as (this: Node) => number;

/** Hides the definitions of the term links hovered or focused in `doc` (Escape). */
function dismissTerms(doc: Document): void {
  for (const term of querySelectorAllOf.call(
    doc,
    TERM_OPEN,
  ) as NodeListOf<Element>) {
    classListOf.call(term).add(TERM_DISMISSED);
  }
}

/** The pointer or focus moved on to `target`: the terms dismissed elsewhere show again next time. */
function undismissTerms(doc: Document, target: EventTarget | null): void {
  for (const term of querySelectorAllOf.call(
    doc,
    `.${TERM_DISMISSED}`,
  ) as NodeListOf<Element>) {
    // The frame's nodes are of its own realm: no `instanceof Node` here.
    let node: Node | null = null;
    try {
      if (target && typeof nodeTypeOf.call(target as Node) === 'number')
        node = target as Node;
    } catch {
      // Not a node (the getter refuses it): moved off every term.
    }
    if (!node || !containsOf.call(term, node)) {
      classListOf.call(term).remove(TERM_DISMISSED);
    }
  }
}

/** The element `target` is, from the frame's realm (no `instanceof` there); null for anything else. */
function elementOf(target: EventTarget | null): Element | null {
  try {
    if (target && nodeTypeOf.call(target as Node) === 1)
      return target as Element;
  } catch {
    // Not a node (the getter refuses it).
  }
  return null;
}

/** The callout key of the part `target` is in, or null. */
function calloutKeyOf(target: EventTarget | null): string | null {
  const element = elementOf(target);
  const part = element
    ? (closestOf.call(element, `[${CALLOUT_KEY}]`) as Element | null)
    : null;
  return part ? getAttributeOf.call(part, CALLOUT_KEY) || null : null;
}

/**
 * The listeners that highlight a callout's parts in `doc` while one is hovered (the pointer wins)
 * or focused. Keys are compared as strings, never put into a selector.
 */
function calloutHighlight(doc: Document): {
  over: EventListener;
  out: EventListener;
  focus: EventListener;
  blur: EventListener;
} {
  let hovered: string | null = null;
  let focused: string | null = null;
  let shown: string | null = null;
  const draw = () => {
    const key = hovered ?? focused;
    if (key === shown) return;
    shown = key;
    for (const part of querySelectorAllOf.call(
      doc,
      `[${CALLOUT_KEY}]`,
    ) as NodeListOf<Element>) {
      classListOf
        .call(part)
        .toggle(
          CALLOUT_HIGHLIGHTED,
          key !== null && getAttributeOf.call(part, CALLOUT_KEY) === key,
        );
    }
  };
  return {
    over: (event) => {
      hovered = calloutKeyOf(event.target);
      draw();
    },
    // Off the page (the pointer left the frame): nothing is hovered.
    out: (event) => {
      if ((event as MouseEvent).relatedTarget) return;
      hovered = null;
      draw();
    },
    focus: (event) => {
      focused = calloutKeyOf(event.target);
      draw();
    },
    blur: () => {
      focused = null;
      draw();
    },
  };
}
