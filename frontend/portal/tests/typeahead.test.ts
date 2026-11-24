// @vitest-environment jsdom
import type { Mock } from 'vitest';
import { TEXTS, typeaheadConfig } from '../src/lib/i18n.ts';
import type { Pagefind, ResultData } from '../src/scripts/pagefind.ts';
import {
  DEBOUNCE_MS,
  startTypeahead,
  suggestionsFrom,
} from '../src/scripts/typeahead.ts';

/** The typeahead on the search fields (#845): its rows and the combobox's keyboard. */
const KEYS = { product: 'Product', variant: 'Variant' };

const page = (
  manual: string,
  variant: string,
  subs: [title: string, hash: string, score: number][],
): ResultData => ({
  url: `/en/alpha/${variant}/`,
  meta: { title: manual, Product: 'Alpha', Variant: variant },
  excerpt: 'page',
  sub_results: subs.map(([title, hash, score]) => ({
    title,
    url: `/en/alpha/${variant}/${hash}`,
    excerpt: `<mark>${title}</mark> text`,
    weighted_locations: [{ balanced_score: score }],
  })),
});

describe('suggestionsFrom', () => {
  it('takes the best sections of each page, a passage once over the variants', () => {
    const rows = suggestionsFrom(
      [
        page('Operating', 'Large', [
          ['Operating', '', 50],
          ['Welcome', '#welcome', 1],
          ['Charging', '#charging', 9],
          ['Glossary', '#glossary', 5],
        ]),
        page('Operating', 'Small', [['Charging', '#charging', 9]]),
        page('Service', 'Large', [['Charging', '#charging', 2]]),
      ],
      KEYS,
    );
    expect(rows.map((r) => [r.manual, r.variant, r.title])).toEqual([
      ['Operating', 'Large', 'Charging'],
      ['Operating', 'Large', 'Glossary'],
      ['Service', 'Large', 'Charging'],
    ]);
    expect(rows[0]).toMatchObject({
      product: 'Alpha',
      url: '/en/alpha/Large/#charging',
    });
  });

  it('stops at the maximum', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      page(`Manual ${i}`, 'Large', [['A', '#a', 1]]),
    );
    expect(suggestionsFrom(results, KEYS)).toHaveLength(6);
  });
});

describe('the combobox', () => {
  let input: HTMLInputElement;
  let form: HTMLFormElement;
  let went: string[];
  let search: Mock<Pagefind['search']>;
  let fail: boolean;

  const results = [
    page('Operating', 'Large', [
      ['Charging', '#charging', 9],
      ['Welcome', '#welcome', 1],
    ]),
  ];
  const fake: Pagefind = {
    options: async () => undefined,
    search: (query, options) => search(query, options),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = () => undefined;
    document.body.innerHTML = '';
    form = document.createElement('form');
    form.action = '/en/search/';
    form.dataset['typeahead'] = JSON.stringify(
      typeaheadConfig(TEXTS.en, 'en', '/en/'),
    );
    input = document.createElement('input');
    input.id = 'head-q';
    input.name = 'q';
    form.append(input);
    document.body.append(form);
    went = [];
    fail = false;
    search = vi.fn<Pagefind['search']>(async () => ({
      results: results.map((data) => ({ data: async () => data })),
    }));
    startTypeahead(document, {
      load: async () => {
        if (fail) throw new Error('no index');
        return fake;
      },
      go: (url) => went.push(url),
    });
    input.focus();
  });
  afterEach(() => vi.useRealTimers());

  const type = async (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
  };
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event;
  };
  const listbox = () => document.getElementById('head-q-suggestions')!;
  const options = () => [
    ...listbox().querySelectorAll<HTMLAnchorElement>('[role="option"]'),
  ];
  const status = () => form.querySelector('[role="status"]')!.textContent;

  it('is a combobox that controls its list', () => {
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBe('head-q-suggestions');
    expect(listbox().getAttribute('role')).toBe('listbox');
  });

  it('searches from two characters on, once the reader pauses', async () => {
    await type('c');
    expect(search).not.toHaveBeenCalled();
    input.value = 'ch';
    input.dispatchEvent(new Event('input'));
    await type('cha');
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('cha', { filters: {} });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining('Charging'),
      expect.stringContaining('Welcome'),
      'All results for “cha”',
    ]);
    // The excerpt is text and a mark, the meta line names manual, product and variant.
    expect(options()[0]!.querySelector('mark')?.textContent).toBe('Charging');
    expect(options()[0]!.querySelector('.typeahead__meta')?.textContent).toBe(
      'Operating · Alpha Large',
    );
    expect(options()[2]!.getAttribute('href')).toBe('/en/search/?q=cha');
    expect(status()).toBe('2 matches. Choose one with the arrow keys.');
  });

  it('moves through the rows with the arrow keys and opens the selected one', async () => {
    await type('charging');
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe('head-q-option-0');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    press('ArrowDown');
    press('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('head-q-option-2');
    press('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('head-q-option-0');
    press('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('head-q-option-2');
    press('ArrowUp');
    expect(options()[2]!.hasAttribute('aria-selected')).toBe(false);
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(went).toEqual(['http://localhost:3000/en/alpha/Large/#welcome']);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves Enter without a selected row to the form', async () => {
    await type('charging');
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(went).toEqual([]);
  });

  it('closes on Escape, and a second Escape clears the field', async () => {
    await type('charging');
    press('ArrowDown');
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(input.value).toBe('charging');
    // The arrow key opens the same rows again, without a new search.
    press('ArrowDown');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(search).toHaveBeenCalledTimes(1);
    press('Escape');
    press('Escape');
    expect(input.value).toBe('');
    expect(status()).toBe('');
  });

  it('says when nothing matches, and still offers the search page', async () => {
    search.mockResolvedValueOnce({ results: [] });
    await type('xylophone');
    expect(options()).toHaveLength(1);
    expect(form.querySelector('.typeahead__note')?.textContent).toBe(
      'No passage matches “xylophone”.',
    );
    expect(status()).toBe('No passage matches “xylophone”.');
  });

  it('keeps the old rows while a new search runs', async () => {
    await type('charging');
    let finish: (value: { results: [] }) => void = () => undefined;
    search.mockReturnValueOnce(
      new Promise<{ results: [] }>((resolve) => (finish = resolve)),
    );
    await type('chargin');
    expect(form.querySelector('.typeahead')?.hasAttribute('data-busy')).toBe(
      true,
    );
    expect(options()).toHaveLength(3);
    finish({ results: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(options()).toHaveLength(1);
    expect(form.querySelector('.typeahead')?.hasAttribute('data-busy')).toBe(
      false,
    );
  });

  it('stays closed when Escape comes before the search ends', async () => {
    input.value = 'charging';
    input.dispatchEvent(new Event('input'));
    press('Escape');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    let finish: (value: { results: [] }) => void = () => undefined;
    search.mockReturnValueOnce(
      new Promise<{ results: [] }>((resolve) => (finish = resolve)),
    );
    await type('chargin');
    press('Escape');
    finish({ results: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(status()).toBe('');
  });

  it('never opens for a reader who left the field', async () => {
    let finish: (value: { results: [] }) => void = () => undefined;
    search.mockReturnValueOnce(
      new Promise<{ results: [] }>((resolve) => (finish = resolve)),
    );
    input.value = 'charging';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    input.blur();
    finish({ results: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the newest search when an older one ends last', async () => {
    type Found = Awaited<ReturnType<Pagefind['search']>>;
    let first: (value: Found) => void = () => undefined;
    search.mockReturnValueOnce(
      new Promise<Found>((resolve) => (first = resolve)),
    );
    await type('xylophone');
    search.mockResolvedValueOnce({ results: [] });
    await type('xylophones');
    first({ results: results.map((data) => ({ data: async () => data })) });
    await vi.advanceTimersByTimeAsync(0);
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toBe('All results for “xylophones”');
  });

  it('keeps the field a combobox when one search fails', async () => {
    search.mockRejectedValueOnce(new Error('boom'));
    await type('charging');
    expect(input.getAttribute('role')).toBe('combobox');
    await type('chargin');
    expect(options()).toHaveLength(3);
  });

  it('closes on a click elsewhere', async () => {
    await type('charging');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('falls back to a plain search form when the index cannot load', async () => {
    fail = true;
    await type('charging');
    expect(input.hasAttribute('role')).toBe(false);
    expect(input.hasAttribute('aria-expanded')).toBe(false);
    expect(form.querySelector<HTMLElement>('.typeahead')?.hidden).toBe(true);
    expect(press('Enter').defaultPrevented).toBe(false);
  });
});
