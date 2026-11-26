/**
 * The release switch in the browser (#896, `src/components/ReleaseSwitch.astro`). A link to the
 * same page in another release takes the reader's place along: the section they were reading
 * (the address's, then the one the contents marked as in view for a moment before they scrolled
 * back up to the switch; else the one in view), and the page's own choices in its query (an update guide's
 * range), with a mark that it came from the switch. The page it opens drops the mark from the
 * address at once; when that release has no such section, it opens at the start and says so in
 * a dismissible notice, read out politely. Without script the links open the page's start.
 */

/** How long a section stays marked before it counts as the one being read, in ms. */
export const DWELL_MS = 700;

/** The query mark of a link the switch followed. */
export const FROM_SWITCH_PARAM = 'from-release';

/** The link a release option opens: `href` with the reader's section and query (`here`) carried along. */
export function placeKept(href: string, here: URL, section: string): string {
  const url = new URL(href, here);
  // Every value of a repeated key (an update guide's `opt`), unless the link sets that key.
  const own = new Set(url.searchParams.keys());
  for (const [key, value] of here.searchParams)
    if (!own.has(key)) url.searchParams.append(key, value);
  url.searchParams.set(FROM_SWITCH_PARAM, '1');
  if (section !== '') url.hash = section;
  return url.pathname + url.search + url.hash;
}

/**
 * `keepSection: false` keeps the query only: an update guide's step anchors are numbered, so the
 * same anchor in another release can be another step.
 */
export function startReleaseSwitch(
  doc: Document,
  { keepSection = true }: { keepSection?: boolean } = {},
): void {
  showMissingSection(doc);
  if (!doc.querySelector('[data-relswitch]')) return;
  const marked = () =>
    doc.querySelector<HTMLAnchorElement>(
      '[data-toc-nav] a[aria-current="location"]',
    )?.hash ?? '';
  // The section being read: the one the contents mark (`reading.ts`) for a moment while the
  // switch is scrolled away. Sections passed on the way back up to the switch are marked only
  // briefly, so going up to it keeps the place.
  const masthead = doc.querySelector('.masthead');
  // The address's section to begin with: where a link (or this switch) brought the reader.
  let reading = doc.location.hash;
  let dwell: ReturnType<typeof setTimeout> | undefined;
  const follow = () => {
    clearTimeout(dwell);
    const section = marked();
    dwell = setTimeout(() => {
      if (
        section === marked() &&
        masthead &&
        masthead.getBoundingClientRect().bottom <= 0
      )
        reading = section;
    }, DWELL_MS);
  };
  const nav = doc.querySelector('[data-toc-nav]');
  if (nav)
    new MutationObserver(follow).observe(nav, {
      subtree: true,
      attributeFilter: ['aria-current'],
    });
  // A contents entry or link followed: that section, at once.
  window.addEventListener('hashchange', () => {
    clearTimeout(dwell);
    reading = doc.location.hash;
  });
  follow();
  for (const link of doc.querySelectorAll<HTMLAnchorElement>(
    'a[data-release-option][data-keep-place]',
  )) {
    // Read as the reader follows it.
    const keep = () => {
      const here = new URL(doc.location.href);
      link.href = placeKept(
        link.dataset['href'] ?? link.getAttribute('href') ?? '',
        here,
        keepSection ? reading || marked() : '',
      );
    };
    link.dataset['href'] = link.getAttribute('href') ?? '';
    link.addEventListener('click', keep);
    link.addEventListener('auxclick', keep);
    // Also before the context menu or a keyboard copy of the link.
    link.addEventListener('contextmenu', keep);
    link.addEventListener('focus', keep);
  }
}

function showMissingSection(doc: Document): void {
  const url = new URL(doc.location.href);
  if (!url.searchParams.has(FROM_SWITCH_PARAM)) return;
  url.searchParams.delete(FROM_SWITCH_PARAM);
  let id: string;
  try {
    id = decodeURIComponent(url.hash.slice(1));
  } catch {
    // A malformed hash names no section: the page's start.
    id = url.hash.slice(1);
  }
  const missing = id !== '' && doc.getElementById(id) === null;
  if (missing) url.hash = '';
  history.replaceState(history.state, '', url);
  if (!missing) return;

  const notice = doc.querySelector<HTMLElement>('[data-release-notice]');
  const text = notice?.querySelector<HTMLElement>('[data-release-notice-text]');
  const status = doc.querySelector<HTMLElement>('[data-release-status]');
  const close = notice?.querySelector<HTMLButtonElement>(
    '[data-release-notice-close]',
  );
  if (!notice || !text || !status || !close) return;
  notice.hidden = false;
  // Shown on the next frame, so it fades in; read out once the page has settled.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => notice.classList.add('is-open')),
  );
  const announce = setTimeout(
    () => (status.textContent = text.textContent),
    400,
  );
  let open = true;
  const dismiss = () => {
    if (!open) return;
    open = false;
    clearTimeout(announce);
    status.textContent = '';
    const hadFocus = notice.contains(doc.activeElement);
    notice.classList.remove('is-open');
    if (hadFocus)
      doc.querySelector<HTMLElement>('[data-relswitch] summary')?.focus();
    const done = () => (notice.hidden = true);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 200);
  };
  close.addEventListener('click', dismiss);
  notice.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
  });
}
