/**
 * The reading view in the browser (#784): the contents mark where the reader is ("you are
 * here", `aria-current="location"`), a marker that slides from entry to entry as the page
 * scrolls, and on narrow screens the contents start closed and close again once an entry is
 * chosen. The running head's guide words, like a reference book's, name what is on the page:
 * they show once the manual's title has scrolled away, with the section in view after it. The
 * page reads the same without it.
 */
export function startReading(doc: Document): void {
  const details = doc.querySelector<HTMLDetailsElement>('[data-toc]');
  const nav = doc.querySelector<HTMLElement>('[data-toc-nav]');
  const marker = doc.querySelector<HTMLElement>('[data-toc-marker]');
  if (!details || !nav || !marker) return;
  const narrow = window.matchMedia('(max-width: 63.99rem)');
  if (narrow.matches) details.open = false;
  nav.addEventListener('click', (event) => {
    if (narrow.matches && (event.target as Element).closest('a'))
      details.open = false;
  });

  const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  const targets = links
    .map((link) => {
      const id = decodeURIComponent(link.hash.slice(1));
      const target = id === '' ? null : doc.getElementById(id);
      return target ? { link, target } : undefined;
    })
    .filter((entry) => entry !== undefined);
  if (targets.length === 0) return;

  const guide = doc.querySelector<HTMLElement>('.runhead__guide');
  const title = doc.getElementById('manual-title');
  const section = guide?.querySelector<HTMLElement>('[data-guide-section]');
  if (guide && title) {
    guide.classList.add('is-following');
    new IntersectionObserver(
      ([entry]) => guide.classList.toggle('is-shown', !entry!.isIntersecting),
      { rootMargin: '-64px 0px 0px 0px' },
    ).observe(title);
  }

  let current: HTMLAnchorElement | undefined;
  const place = () => {
    if (!current || current.offsetParent === null) {
      marker.hidden = true;
      return;
    }
    marker.hidden = false;
    const box = current.getBoundingClientRect();
    const frame = nav.getBoundingClientRect();
    marker.style.transform = `translateY(${box.top - frame.top + nav.scrollTop}px)`;
    marker.style.height = `${box.height}px`;
  };
  const choose = (link: HTMLAnchorElement | undefined) => {
    if (link === current) return;
    current?.removeAttribute('aria-current');
    current = link;
    current?.setAttribute('aria-current', 'location');
    if (section && current) {
      section.textContent = current.textContent?.trim() ?? '';
      section.hidden = false;
    }
    place();
    // The entry stays in view in a long contents (its own scroller only; the page never moves).
    const panel = details;
    if (current && panel.scrollHeight > panel.clientHeight) {
      const top = current.offsetTop;
      if (
        top < panel.scrollTop + 48 ||
        top > panel.scrollTop + panel.clientHeight - 48
      )
        panel.scrollTo({ top: Math.max(0, top - panel.clientHeight / 3) });
    }
  };

  // The current entry is the last whose section starts above a line a third down the window.
  let queued = false;
  const update = () => {
    queued = false;
    const line = window.innerHeight / 3;
    let found = targets[0]!.link;
    for (const { link, target } of targets) {
      if (target.getBoundingClientRect().top <= line) found = link;
      else break;
    }
    // At the very end of the page, the last entry: a short last section never reaches the line.
    if (
      window.innerHeight + window.scrollY >=
      doc.documentElement.scrollHeight - 2
    )
      found = targets.at(-1)!.link;
    choose(found);
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', () => {
    place();
    schedule();
  });
  details.addEventListener('toggle', () => place());
  update();
  // Placed once without sliding in, then it slides.
  requestAnimationFrame(() => marker.classList.add('is-ready'));
}
