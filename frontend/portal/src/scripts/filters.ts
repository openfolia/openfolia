import { countText } from '../lib/i18n.ts';

/**
 * The manual list's filters (product, each variant attribute, the title) and its pages, in the
 * browser. The list is complete without script; the filters and the pager only show once this
 * runs. A row shows when its product matches and at least one of its variants matches every
 * attribute filter; its variant links that do not match hide, and its title opens the first
 * that does. The rows scroll in their own frame; the pager sits under it, always in view. The
 * count is a polite live region. `?product=` preselects a product.
 */
export function filterManuals(doc: Document): void {
  const form = doc.querySelector<HTMLFormElement>('[data-filters]');
  const count = doc.querySelector<HTMLElement>('[data-count]');
  const pager = doc.querySelector<HTMLElement>('[data-pager]');
  const scroller = doc.querySelector<HTMLElement>('[data-list]');
  if (!form || !count || !pager || !scroller) return;
  const texts = JSON.parse(count.dataset['count'] ?? '{}') as {
    count: { one: string; other: string };
    pageOf: string;
  };
  const lang = count.dataset['lang'] ?? doc.documentElement.lang;
  const size = Math.max(1, Number(pager.dataset['size'] ?? '12'));
  const cards = [...doc.querySelectorAll<HTMLElement>('[data-card]')];
  const noMatch = doc.querySelector<HTMLElement>('[data-no-match]');
  const label = pager.querySelector<HTMLElement>('[data-page-label]')!;
  const prev = pager.querySelector<HTMLButtonElement>('[data-prev]')!;
  const next = pager.querySelector<HTMLButtonElement>('[data-next]')!;
  const number = new Intl.NumberFormat(lang);
  // A row shows its first few matching variants, the rest behind "+n more".
  const fold = Number(
    doc.querySelector<HTMLElement>('[data-fold]')?.dataset['fold'] ?? '3',
  );
  const opened = new WeakSet<HTMLElement>();

  const product = new URLSearchParams(location.search).get('product');
  const select = form.querySelector<HTMLSelectElement>(
    'select[name="product"]',
  );
  if (product && select && [...select.options].some((o) => o.value === product))
    select.value = product;

  let page = 0;
  let matching = cards;
  const show = () => {
    const pages = Math.max(1, Math.ceil(matching.length / size));
    page = Math.min(Math.max(page, 0), pages - 1);
    const shown = new Set(matching.slice(page * size, page * size + size));
    for (const card of cards) card.hidden = !shown.has(card);
    pager.hidden = pages < 2;
    label.textContent = texts.pageOf
      .replace('{n}', number.format(page + 1))
      .replace('{m}', number.format(pages));
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  };

  const apply = (keepPlace = false) => {
    const data = new FormData(form);
    const chosen = String(data.get('product') ?? '');
    const query = String(data.get('q') ?? '')
      .trim()
      .toLocaleLowerCase(lang);
    const wanted: [string, string][] = [];
    for (const [name, value] of data.entries())
      if (name.startsWith('variant:') && value !== '')
        wanted.push([name.slice(8), String(value)]);
    matching = cards.filter((card) => {
      let first: string | undefined;
      let any = false;
      const matched: HTMLElement[] = [];
      for (const variant of card.querySelectorAll<HTMLElement>(
        '[data-values]',
      )) {
        const values = JSON.parse(variant.dataset['values'] ?? '{}') as Record<
          string,
          string
        >;
        const match = wanted.every(
          ([attribute, value]) => values[attribute] === value,
        );
        variant.hidden = !match;
        if (match) matched.push(variant);
        if (match && first === undefined)
          first = variant.querySelector('a')?.getAttribute('href') ?? undefined;
        any ||= match;
      }
      foldRow(card, matched);
      const title = card.querySelector<HTMLAnchorElement>('.row__title');
      if (title && first !== undefined) title.href = first;
      return (
        any &&
        (chosen === '' || card.dataset['product'] === chosen) &&
        (query === '' || (card.dataset['title'] ?? '').includes(query))
      );
    });
    if (noMatch) noMatch.hidden = matching.length > 0;
    count.textContent = countText(texts.count, matching.length, lang);
    if (!keepPlace) page = 0;
    show();
    if (!keepPlace) scroller.scrollTop = 0;
  };

  function foldRow(card: HTMLElement, matched: HTMLElement[]): void {
    const more = card.querySelector<HTMLElement>('[data-more]');
    if (!more) return;
    const rest = opened.has(card) ? [] : matched.slice(fold);
    for (const variant of rest) variant.hidden = true;
    more.hidden = rest.length === 0;
    const button = more.querySelector<HTMLButtonElement>('[data-more-button]')!;
    button.textContent = (button.dataset['template'] ?? '+{n}').replace(
      '{n}',
      number.format(rest.length),
    );
  }
  for (const card of cards)
    card.querySelector('[data-more-button]')?.addEventListener('click', () => {
      opened.add(card);
      apply(true);
      // The first of the variants just shown, not the start of the row.
      const shown = card.querySelectorAll<HTMLAnchorElement>(
        '[data-values]:not([hidden]) a',
      );
      (shown[fold] ?? shown[0])?.focus();
    });

  const turn = (by: number) => {
    page += by;
    show();
    scroller.scrollTop = 0;
  };
  prev.addEventListener('click', () => turn(-1));
  next.addEventListener('click', () => turn(1));
  form.addEventListener('input', () => apply());
  form.addEventListener('submit', (event) => event.preventDefault());
  apply(true);
}
