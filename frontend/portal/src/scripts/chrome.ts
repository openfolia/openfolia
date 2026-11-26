/**
 * The frame of every page, in the browser (#784): the thumb index keeps its current tab in
 * view (a site of many products scrolls its tab column), follows the product the reader
 * scrolls to on the start page, and the narrow screens' product switch closes once a product
 * is chosen or the reader clicks elsewhere. Every page works without it.
 */
export function startChrome(doc: Document): void {
  const thumbs = doc.querySelector<HTMLElement>('[data-thumbs] ul');
  // Within the tab column only: the page itself never moves.
  const reveal = (tab: HTMLElement | null | undefined, smooth = false) => {
    if (!thumbs || !tab) return;
    const top = tab.offsetTop - thumbs.offsetTop;
    const bottom = top + tab.offsetHeight;
    // Out of view: brought to the column's middle (the snap then settles on whole tabs).
    const target =
      top < thumbs.scrollTop || bottom > thumbs.scrollTop + thumbs.clientHeight
        ? top - (thumbs.clientHeight - tab.offsetHeight) / 2
        : undefined;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (target !== undefined)
      thumbs.scrollTo({
        top: target,
        behavior: smooth && !still ? 'smooth' : 'auto',
      });
  };
  reveal(thumbs?.querySelector<HTMLElement>('[aria-current="true"]'));
  if (thumbs) {
    const edges = () => {
      const top = thumbs.scrollTop;
      const bottom = top + thumbs.clientHeight;
      for (const item of thumbs.children as HTMLCollectionOf<HTMLElement>) {
        const start = item.offsetTop - thumbs.offsetTop;
        item.classList.toggle(
          'is-cut',
          start < top - 1 || start + item.offsetHeight > bottom + 1,
        );
      }
      thumbs.classList.toggle('is-more-before', thumbs.scrollTop > 2);
      thumbs.classList.toggle(
        'is-more-after',
        thumbs.scrollTop + thumbs.clientHeight < thumbs.scrollHeight - 2,
      );
    };
    thumbs.addEventListener('scroll', edges, { passive: true });
    window.addEventListener('resize', edges);
    edges();
  }

  // Filter panels: open on wide screens, a disclosure on narrow ones, counting what is set.
  const narrow = window.matchMedia('(max-width: 39.99rem)');
  for (const panel of doc.querySelectorAll<HTMLDetailsElement>(
    '[data-filters-panel]',
  )) {
    panel.hidden = false;
    panel.open = !narrow.matches;
    narrow.addEventListener('change', () => (panel.open = !narrow.matches));
    const badge = panel.querySelector<HTMLElement>('[data-filters-count]');
    const count = () => {
      const set = [
        ...panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          'select, input',
        ),
      ].filter((field) => field.value.trim() !== '').length;
      if (badge) {
        badge.hidden = set === 0;
        badge.textContent = String(set);
      }
    };
    panel.addEventListener('input', count);
    panel.addEventListener('change', count);
    // After the page's own scripts set the address's choices.
    requestAnimationFrame(count);
  }

  // A long example in the search field's placeholder, a short one where it would be cut.
  for (const input of doc.querySelectorAll<HTMLInputElement>(
    'input[data-placeholder-short]',
  )) {
    const long = input.placeholder;
    const fit = () => {
      input.placeholder = narrow.matches
        ? (input.dataset['placeholderShort'] ?? long)
        : long;
    };
    narrow.addEventListener('change', fit);
    fit();
  }

  // The product switch and the release switch (#896): menus that close once an entry is chosen,
  // on a click elsewhere, and on Escape (focus back on their button).
  for (const menu of doc.querySelectorAll<HTMLDetailsElement>(
    '[data-prodswitch], [data-relswitch]',
  )) {
    menu.addEventListener('click', (event) => {
      if ((event.target as Element).closest('a')) menu.open = false;
    });
    doc.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
    });
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    });
    // Tabbing out of the menu closes it, as a click elsewhere does.
    menu.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null;
      if (menu.open && next !== null && !menu.contains(next)) menu.open = false;
    });
  }

  // The start page: the tab of the product in view is the current one.
  const sections = [
    ...doc.querySelectorAll<HTMLElement>('[data-product-section]'),
  ];
  if (!thumbs || sections.length === 0 || !('IntersectionObserver' in window))
    return;
  const tabs = new Map(
    [...thumbs.querySelectorAll<HTMLAnchorElement>('[data-product]')].map(
      (a) => [a.dataset['product'] ?? '', a],
    ),
  );
  const visible = new Set<HTMLElement>();
  const mark = () => {
    const top = sections.find((section) => visible.has(section));
    for (const [id, tab] of tabs)
      if (id === top?.dataset['productSection'])
        tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
    if (top) reveal(tabs.get(top.dataset['productSection'] ?? ''), true);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) visible.add(entry.target as HTMLElement);
        else visible.delete(entry.target as HTMLElement);
      mark();
    },
    { rootMargin: '-30% 0px -55% 0px' },
  );
  sections.forEach((section) => observer.observe(section));
}
