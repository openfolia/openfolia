import { countText, type TypeaheadConfig } from '../lib/i18n.ts';
import {
  el,
  excerptNodes,
  loadPagefind,
  type Pagefind,
  passageScore,
  passagesOf,
  type ResultData,
  sameSite,
} from './pagefind.ts';

/**
 * The typeahead on the search fields (#845): the running head's and the start page's (any
 * `form[data-typeahead]`). From two characters on, the best passages of this build's Pagefind
 * index appear in a popover under the field, and its last row leads to the search page. It is
 * the ARIA combobox pattern with a list popup: the focus stays in the field, the arrow keys
 * move the selected row (`aria-activedescendant`), Enter opens it, Escape closes the list and
 * a second Escape clears the field; a polite live region says how many matched. While a new
 * search runs the old rows stay, so nothing jumps. Without script, or when the index cannot
 * load, the field is what it was: a form that submits to the search page.
 */
export interface Suggestion {
  readonly title: string;
  readonly manual: string;
  readonly product: string;
  readonly variant: string;
  readonly url: string;
  readonly excerpt: string;
}

/** Rows the popover shows, above "All results". */
export const MAX_SUGGESTIONS = 6;
/** Characters before it searches. */
export const MIN_CHARS = 2;
/** Results read from the index for one search (its best first). */
const READ = 12;
/** Passages one page may give, so one manual does not fill the list. */
const PER_PAGE = 2;
/** Quiet time after a keystroke before it searches. */
export const DEBOUNCE_MS = 120;
/** How long a first search may take before the popover says it is searching. */
const SLOW_MS = 250;

/**
 * The best passages of the results: best page first, then its sections that matched best (the
 * page's own head only after them); a passage found in several variants of a manual shows
 * once, in the best variant.
 */
export function suggestionsFrom(
  results: readonly ResultData[],
  keys: { readonly product: string; readonly variant: string },
  max = MAX_SUGGESTIONS,
): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const data of results) {
    const manual = data.meta['title'] ?? '';
    const product = data.meta[keys.product] ?? '';
    // A section before the page's own head (its title and variant line, no anchor).
    const best = [...passagesOf(data)]
      .map((sub, i) => ({
        sub,
        i,
        section: sub.url.includes('#') ? 1 : 0,
        score: passageScore(sub),
      }))
      .sort((a, b) => b.section - a.section || b.score - a.score || a.i - b.i);
    let taken = 0;
    for (const { sub } of best) {
      if (out.length === max) return out;
      if (taken === PER_PAGE) break;
      const key = `${product}\u0000${manual}\u0000${sub.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      taken++;
      out.push({
        title: sub.title || manual,
        manual,
        product,
        variant: data.meta[keys.variant] ?? '',
        url: sub.url,
        excerpt: sub.excerpt,
      });
    }
  }
  return out;
}

const SVG = 'http://www.w3.org/2000/svg';

/** The search button's arrow (`SearchField.astro`), drawn, not a character. */
function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'typeahead__arrow');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M5 12h14m-6-6 6 6-6 6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** Manual and product, then the variant as the chip the manual lists show it as. */
function meta(row: Suggestion): HTMLElement {
  const line = el(
    'span',
    'typeahead__meta',
    [row.manual, row.product].filter(Boolean).join(' · '),
  );
  if (row.variant) {
    line.append(' ');
    line.append(el('span', 'typeahead__variant', row.variant));
  }
  return line;
}

export interface TypeaheadOptions {
  /** The index (default: this site's Pagefind). */
  readonly load?: (base: string) => Promise<Pagefind>;
  /** Opens a row (default: the browser goes there). */
  readonly go?: (url: string) => void;
}

export function startTypeahead(doc: Document, options: TypeaheadOptions = {}) {
  for (const form of doc.querySelectorAll<HTMLFormElement>(
    'form[data-typeahead]',
  ))
    attach(doc, form, options);
}

function attach(
  doc: Document,
  form: HTMLFormElement,
  { load = loadPagefind, go = (url) => location.assign(url) }: TypeaheadOptions,
): void {
  const input = form.querySelector<HTMLInputElement>('input[name="q"]');
  if (!input?.id) return;
  const c = JSON.parse(form.dataset['typeahead'] ?? '{}') as TypeaheadConfig;
  const keys = { product: c.productKey, variant: c.variantKey };

  const popover = el('div', 'typeahead');
  popover.hidden = true;
  const note = el('p', 'typeahead__note');
  note.hidden = true;
  const list = el('div', 'typeahead__list');
  list.id = `${input.id}-suggestions`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', c.label);
  popover.append(note, list);
  const status = el('span', 'visually-hidden');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  form.append(popover, status);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);

  let options: HTMLAnchorElement[] = [];
  let active = -1;
  let run = 0;
  /** The query the rows answer (none: nothing shown yet). */
  let shown: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let slow: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let failed = false;

  const query = () => input.value.trim();
  const isOpen = () => !popover.hidden;

  const fit = () => {
    // Never past the bottom of what the reader sees (a phone's keyboard included).
    const field = (input.closest('.minisearch, .bigsearch') ??
      input) as Element;
    const room =
      (window.visualViewport?.height ?? window.innerHeight) -
      field.getBoundingClientRect().bottom -
      16;
    popover.style.maxHeight = `${Math.max(176, Math.round(room))}px`;
  };

  const open = () => {
    // Only for the reader still in the field: never for a search that ends after they left.
    if (isOpen() || doc.activeElement !== input) return;
    popover.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    fit();
    // Shown on the next frame, so it fades in.
    frame = requestAnimationFrame(() => popover.classList.add('is-open'));
  };

  const select = (index: number, scroll = true) => {
    options[active]?.removeAttribute('aria-selected');
    active = index;
    const option = options[active];
    if (option) {
      option.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', option.id);
      if (scroll) option.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };

  /** Closes the list, and drops the search on its way, so it never opens it again. */
  const close = () => {
    run++;
    clearTimeout(timer);
    clearTimeout(slow);
    cancelAnimationFrame(frame);
    select(-1);
    popover.hidden = true;
    popover.classList.remove('is-open');
    delete popover.dataset['busy'];
    input.setAttribute('aria-expanded', 'false');
  };

  /** Back to nothing: no rows, no pending search, nothing to read out. */
  const reset = () => {
    close();
    shown = undefined;
    status.textContent = '';
  };

  const allResults = (q: string) => {
    const url = new URL(form.action, location.href);
    url.search = '';
    url.searchParams.set('q', q);
    const option = el('a', 'typeahead__option typeahead__all');
    option.href = url.pathname + url.search;
    option.append(
      el(
        'span',
        'typeahead__all-text',
        c.all.replace('{q}', () => q),
      ),
    );
    option.append(arrowIcon());
    return option;
  };

  const render = (q: string, rows: readonly Suggestion[] | undefined) => {
    const items = (rows ?? []).map((row) => {
      const option = el('a', 'typeahead__option');
      option.href = sameSite(row.url);
      const excerpt = el('span', 'typeahead__excerpt');
      excerpt.append(...excerptNodes(row.excerpt));
      option.append(
        el('span', 'typeahead__title', row.title),
        meta(row),
        excerpt,
      );
      return option;
    });
    options = [...items, allResults(q)];
    options.forEach((option, i) => {
      option.id = `${input.id}-option-${i}`;
      option.setAttribute('role', 'option');
      option.tabIndex = -1;
    });
    active = -1;
    input.removeAttribute('aria-activedescendant');
    list.replaceChildren(...options);
    note.hidden = rows !== undefined && rows.length > 0;
    note.textContent =
      rows === undefined ? c.searching : c.none.replace('{q}', () => q);
    note.classList.toggle('is-none', rows !== undefined);
    popover.scrollTop = 0;
  };

  const search = async (q: string) => {
    const mine = ++run;
    clearTimeout(slow);
    popover.dataset['busy'] = '';
    // A first search that takes a while says so; later ones keep the rows they replace.
    if (shown === undefined)
      slow = setTimeout(() => {
        if (mine !== run) return;
        render(q, undefined);
        open();
      }, SLOW_MS);
    let pagefind: Pagefind;
    try {
      pagefind = await load(c.base);
    } catch {
      if (mine !== run) return;
      // The index is not there: the field goes back to a plain search form.
      failed = true;
      reset();
      for (const name of [
        'role',
        'aria-autocomplete',
        'aria-expanded',
        'aria-controls',
      ])
        input.removeAttribute(name);
      return;
    }
    try {
      const found = await pagefind.search(q, { filters: {} });
      if (found === null || mine !== run) return;
      const results = await Promise.all(
        found.results.slice(0, READ).map((r) => r.data()),
      );
      if (mine !== run) return;
      clearTimeout(slow);
      const rows = suggestionsFrom(results, keys);
      shown = q;
      render(q, rows);
      open();
      if (isOpen())
        status.textContent =
          rows.length === 0
            ? c.none.replace('{q}', () => q)
            : countText(c.count, rows.length, c.lang);
    } catch {
      // One search failed (the index is there): the rows stay, Enter still searches.
    } finally {
      if (mine === run) {
        clearTimeout(slow);
        delete popover.dataset['busy'];
      }
    }
  };

  input.addEventListener('focus', () => {
    // The index loads while the reader starts typing.
    if (!failed) load(c.base).catch(() => undefined);
  });

  input.addEventListener('input', () => {
    if (failed) return;
    clearTimeout(timer);
    const q = query();
    if (q.length < MIN_CHARS) {
      reset();
      return;
    }
    timer = setTimeout(() => void search(q), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (event) => {
    // keyCode 229: Safari's Enter that ends a composition.
    if (failed || event.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!isOpen()) {
          if (query().length < MIN_CHARS) return;
          event.preventDefault();
          if (shown === query()) open();
          else {
            clearTimeout(timer);
            void search(query());
          }
          return;
        }
        event.preventDefault();
        const n = options.length;
        if (event.key === 'ArrowDown') select(active < n - 1 ? active + 1 : 0);
        else select(active <= 0 ? n - 1 : active - 1);
        return;
      }
      case 'Enter': {
        const option = isOpen() ? options[active] : undefined;
        // No row selected: the form goes to the search page, as "All results" does.
        if (!option) return;
        event.preventDefault();
        close();
        go(option.href);
        return;
      }
      case 'Escape':
        if (isOpen()) {
          event.preventDefault();
          close();
        } else if (input.value !== '') {
          event.preventDefault();
          input.value = '';
          reset();
        }
        return;
      case 'Tab':
        close();
    }
  });

  // The focus stays in the field while a row (or the list's scrollbar) is pressed.
  popover.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('pointermove', (event) => {
    const option = (event.target as Element).closest<HTMLAnchorElement>(
      '[role="option"]',
    );
    const index = option ? options.indexOf(option) : -1;
    if (index !== -1 && index !== active) select(index, false);
  });
  list.addEventListener('click', (event) => {
    const plain =
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey;
    if (plain && (event.target as Element).closest('[role="option"]')) close();
  });

  doc.addEventListener('pointerdown', (event) => {
    if (isOpen() && !form.contains(event.target as Node)) close();
  });
  form.addEventListener('focusout', (event) => {
    if (!form.contains(event.relatedTarget as Node | null)) close();
  });
  window.addEventListener('resize', () => isOpen() && fit());
  // Back to this page from the browser's cache: the list it left by is closed.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) close();
  });
}
