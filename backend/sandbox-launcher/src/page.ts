// The start page: one HTML document per language holding every state (ready, starting, full,
// error); the page's script (page/page.js) switches between them. Built on the server from the
// settings and the texts, escaped; no inline script or style (the page's policy allows neither).
import { type PageLang, TEXTS, text, type TextKey } from './texts.js';

export interface Film {
  readonly name: FilmName;
  /** Published paths under /_demo/films/. */
  readonly poster: string;
  readonly sources: readonly { readonly src: string; readonly type: string }[];
}

export const FILM_NAMES = [
  'hero',
  'editor',
  'review',
  'manual-builder',
  'releases',
] as const;
export type FilmName = (typeof FILM_NAMES)[number];

/** What every page of the launcher shows around its content: the header's and footer's links. */
export interface ChromeOptions {
  readonly lang: PageLang;
  readonly idleMinutes: number;
  readonly maxMinutes: number;
  readonly perAddress: number;
  readonly perAddressDaily: number;
  /** Each link is shown only when its setting is set. */
  readonly docsUrl: string | undefined;
  readonly homepageUrl: string | undefined;
  readonly imprintUrl: string | undefined;
  readonly privacyUrl: string | undefined;
  readonly portalUrl: string | undefined;
  readonly abuseContact: string | undefined;
}

/** How the visitor's last sandbox ended: they ended it (`closed`), or it ran out (`expired`). */
export type Ended = 'closed' | 'expired';

export interface PageOptions extends ChromeOptions {
  readonly capacity: number;
  readonly free: number;
  readonly films: readonly Film[];
  /** The visitor's last sandbox has ended: the "thanks" dialog opens over the page. */
  readonly ended: Ended | undefined;
  /** The dialog's "Book a demo" (#846); unset, it has none. */
  readonly bookingUrl: string | undefined;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const ICONS = {
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  play: '<path d="M7 4.5v15a.5.5 0 0 0 .76.43l12.5-7.5a.5.5 0 0 0 0-.86L7.76 4.07A.5.5 0 0 0 7 4.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M20.99 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.78 9.79Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/>',
  trash:
    '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
} as const;

function icon(name: keyof typeof ICONS, cls = 'icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

const PEOPLE = [
  {
    initials: 'MS',
    name: 'Mira Sand',
    role: 'people.author.role',
    does: 'people.author.does',
  },
  {
    initials: 'JF',
    name: 'Jonas Feld',
    role: 'people.reviewer.role',
    does: 'people.reviewer.does',
  },
  {
    initials: 'AL',
    name: 'Ada Linde',
    role: 'people.admin.role',
    does: 'people.admin.does',
  },
] as const;

/** The texts the script shows later; the rest are in the markup already. */
const SCRIPT_TEXTS: readonly TextKey[] = [
  'live',
  'live.free',
  'live.full',
  'full.inUse',
  'full.retryIn',
  'full.retrying',
  'error.reference',
  'error.lede',
  'error.title',
  'error.network.lede',
  'limit.daily.title',
  'limit.daily.lede',
  'limit.once.title',
  'limit.once.lede',
  'limit.rate.title',
  'limit.rate.lede',
  'starting.seconds',
  'films.play',
];

export function renderPage(o: PageOptions): string {
  const t = (
    key: TextKey,
    values?: Readonly<Record<string, string | number>>,
  ) => escape(text(o.lang, key, values));
  const scriptTexts = Object.fromEntries(
    SCRIPT_TEXTS.map((key) => [key, TEXTS[o.lang][key]]),
  );
  const config = {
    lang: o.lang,
    capacity: o.capacity,
    daily: o.perAddressDaily,
    texts: scriptTexts,
  };
  const full = o.free === 0;
  const people = PEOPLE.map(
    (p) =>
      `<li class="person"><span class="avatar" aria-hidden="true">${p.initials}</span><span class="who"><span class="name">${p.name}</span><span class="role">${t(p.role)}</span></span><span class="does">${t(p.does)}</span></li>`,
  ).join('');
  const facts = (
    [
      ['clock', 'facts.ready.title', 'facts.ready.text'],
      ['shield', 'facts.browser.title', 'facts.browser.text'],
      ['trash', 'facts.gone.title', 'facts.gone.text'],
    ] as const
  )
    .map(
      ([i, title, body]) =>
        `<li class="fact">${icon(i)}<span><b>${t(title)}</b> ${t(body)}</span></li>`,
    )
    .join('');
  const films = o.films
    .map((film) => {
      const title = text(o.lang, `films.${film.name}` as TextKey);
      const sources = film.sources.map((s) => ({ src: s.src, type: s.type }));
      return `<li class="film${film.name === 'hero' ? ' wide' : ''}"><button type="button" class="poster" data-sources="${escape(JSON.stringify(sources))}" aria-label="${t('films.play', { title })}"><img src="${escape(film.poster)}" alt="" loading="lazy" decoding="async" width="1600" height="900"><span class="play">${icon('play')}</span></button><span class="film-title">${escape(title)}</span></li>`;
    })
    .join('');
  const filmsBlock = films
    ? `<section class="films-block" data-films aria-labelledby="films-label"><h2 id="films-label" class="label">${t('films.label')}</h2><ul class="films" role="list">${films}</ul></section>`
    : '';
  const langOption = (lang: PageLang, label: string) =>
    `<label><input type="radio" name="content-lang" value="${lang}"${lang === o.lang ? ' checked' : ''}><span>${label}</span></label>`;

  return `${top(o, {
    state: full ? 'full' : 'ready',
    title: t('page.title'),
    here: '/',
    head: `<script type="application/json" id="demo-config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>
<script src="/_demo/page.js" defer></script>`,
  })}
<div class="col">
  <div class="eyebrow" data-live><span class="dot${full ? ' warn' : ''}" aria-hidden="true"></span><span data-live-text>${full ? t('live.full') : t('live.free', { free: o.free, capacity: o.capacity })}</span></div>

  <section class="state s-ready" aria-labelledby="ready-title">
    <h1 id="ready-title">${t('ready.title')} <span class="soft">${t('ready.titleSoft')}</span></h1>
    <p class="lede">${t('ready.lede')}</p>
    ${o.ended ? `<p class="notice-line" role="status">${icon('info')}<span>${t('start.ended')}</span></p>` : ''}
    <h2 class="sr-only">${t('people.label')}</h2>
    <ul class="people" role="list">${people}</ul>
    <p class="people-note">${t('people.note')}</p>
    <div class="private">
      <span class="badge">${icon('lock')}</span>
      <div class="private-body">
        <p class="private-title">${t('private.title')}</p>
        <p>${t('private.text', { idle: o.idleMinutes, max: o.maxMinutes })}</p>
        <ul class="facts" role="list">${facts}</ul>
      </div>
    </div>
    <form class="actions" data-start-form>
      <button class="btn" type="submit" data-start disabled>${icon('play')}<span>${t('start.button')}</span></button>
      <fieldset class="lang">
        <legend>${t('start.contentLang')}</legend>
        <span class="seg">${langOption('en', 'English')}${langOption('de', 'Deutsch')}</span>
      </fieldset>
    </form>
    <p class="fine">${t('start.fine', { daily: o.perAddressDaily })}</p>
    <noscript><p class="notice-line">${t('start.noScript')}</p></noscript>
  </section>

  <section class="state s-starting" aria-labelledby="starting-title">
    <h1 id="starting-title">${t('starting.title')}<span class="soft">…</span></h1>
    <p class="lede">${t('starting.lede')}</p>
    <div class="progress-card">
      <div class="bar-track" aria-hidden="true"><i data-progress></i></div>
      <ol class="steps" role="status" aria-live="polite">
        <li data-step="check"><span class="mark">${icon('check')}</span><span class="label">${t('starting.step.check')}<span class="sub">${t('starting.step.check.sub')}</span></span><time data-time></time></li>
        <li data-step="start"><span class="mark">${icon('check')}</span><span class="label">${t('starting.step.start')}<span class="sub">${t('starting.step.start.sub')}</span></span><time data-time></time></li>
        <li data-step="open"><span class="mark">${icon('check')}</span><span class="label">${t('starting.step.open')}</span><time data-time></time></li>
      </ol>
    </div>
    <p class="tip">${icon('lock')}<span>${t('starting.tip')}</span></p>
  </section>

  <section class="state s-full" aria-labelledby="full-title">
    <h1 id="full-title">${t('full.title')} <span class="soft">${t('full.titleSoft')}</span></h1>
    <p class="lede">${films ? t('full.ledeFilms') : t('full.lede')}</p>
    <div class="notice">
      <span class="meter" aria-hidden="true">${'<i></i>'.repeat(Math.min(o.capacity, 12))}</span>
      <span class="grow"><span>${t('full.inUse', { capacity: o.capacity })}</span><small data-retry-text aria-live="polite"></small></span>
      <button class="btn secondary" type="button" data-retry>${icon('refresh')}<span>${t('full.retry')}</span></button>
    </div>
  </section>

  ${filmsBlock}

  <section class="state s-error" aria-labelledby="error-title">
    <div class="err-badge">${icon('alert')}</div>
    <h1 id="error-title" data-error-title>${t('error.title')}</h1>
    <p class="lede" data-error-lede>${t('error.lede', { daily: o.perAddressDaily })}</p>
    <div class="actions">
      <button class="btn" type="button" data-again>${icon('refresh')}<span>${t('error.retry')}</span></button>
      ${films ? `<button class="btn ghost" type="button" data-show-films>${t('error.films')}</button>` : ''}
    </div>
    <p class="ref" data-reference hidden></p>
  </section>
</div>
${o.ended ? endedDialog(o, o.ended, t) : ''}
${bottom(o)}`;
}

/**
 * The "thanks" dialog once a sandbox has ended (#846): opened over the start page by its script
 * (`showModal`: focus moves to its heading, so it is read from the top and the first Tab reaches
 * its first action; Escape closes it; the page behind is inert). "Book a demo" is a plain link to
 * the operator's page; nothing of it is loaded here.
 */
function endedDialog(
  o: PageOptions,
  ended: Ended,
  t: (
    key: TextKey,
    values?: Readonly<Record<string, string | number>>,
  ) => string,
): string {
  const booking = o.bookingUrl
    ? `<a class="btn" href="${escape(o.bookingUrl)}" data-ended-book>${icon('calendar')}<span>${t('ended.book')}</span></a>`
    : '';
  const again = `<button class="btn${booking ? ' secondary' : ''}" type="button" data-ended-again>${icon('play')}<span>${t('ended.again')}</span></button>`;
  const portal = o.portalUrl
    ? `<a class="ended-link" href="${escape(o.portalUrl)}">${icon('book')}<span>${t('ended.portal')}</span></a>`
    : '';
  return `<dialog class="ended" data-ended="${ended}" aria-labelledby="ended-title" aria-describedby="ended-text">
  <div class="ended-body">
    <span class="ended-badge ${ended}" aria-hidden="true">${icon(ended === 'closed' ? 'check' : 'clock')}</span>
    <h2 id="ended-title" tabindex="-1" autofocus>${t('ended.title')}</h2>
    <div id="ended-text" class="ended-text">
      <p>${ended === 'closed' ? t('ended.closed') : t('ended.expired', { idle: o.idleMinutes, max: o.maxMinutes })}</p>
      <p>${booking ? t('ended.booking') : t('ended.again.lede')}</p>
    </div>
    <div class="ended-actions${booking ? ' two' : ''}">${booking}${again}</div>
    ${portal}
    <button class="icon-btn ended-close" type="button" data-ended-close aria-label="${t('ended.close')}">${icon('x')}</button>
  </div>
</dialog>`;
}

function texts(lang: PageLang) {
  return (key: TextKey, values?: Readonly<Record<string, string | number>>) =>
    escape(text(lang, key, values));
}

/** The document's head, the header and the opening of the main column. */
function top(
  o: ChromeOptions,
  page: { state: string; title: string; here: string; head: string },
): string {
  const t = texts(o.lang);
  const other: PageLang = o.lang === 'en' ? 'de' : 'en';
  const langLink = (lang: PageLang) =>
    `<a href="${page.here}?lang=${lang}" hreflang="${lang}" lang="${lang}"${lang === o.lang ? ' aria-current="true"' : ''}>${lang.toUpperCase()}</a>`;
  const docs = o.docsUrl
    ? `<a class="docs" href="${escape(o.docsUrl)}">${t('header.docs')}</a>`
    : '';
  const home = o.homepageUrl ? escape(o.homepageUrl) : `/?lang=${o.lang}`;
  return `<!doctype html>
<html lang="${o.lang}" data-state="${page.state}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${page.title}</title>
<meta name="description" content="${t('page.description')}">
<link rel="icon" href="/_demo/brand/favicon.svg" type="image/svg+xml">
<link rel="alternate" hreflang="${other}" href="${page.here}?lang=${other}">
<link rel="preload" href="/_demo/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/_demo/theme.css">
<link rel="stylesheet" href="/_demo/page.css">
<script src="/_demo/theme.js"></script>
${page.head}
</head>
<body>
<a class="skip" href="#main">${t('page.skip')}</a>
<header class="bar">
  <a class="home" href="${home}" aria-label="${o.homepageUrl ? t('header.homepage') : 'OpenFolia'}">
    <img class="logo logo-light" src="/_demo/brand/openfolia-lockup-horizontal-color-light.svg" alt="OpenFolia" width="134" height="24">
    <img class="logo logo-dark" src="/_demo/brand/openfolia-lockup-horizontal-color-dark.svg" alt="" width="134" height="24">
  </a>
  <nav class="tools" aria-label="${t('header.language')}">
    ${docs}
    <span class="seg" role="group" aria-label="${t('header.language')}">${langLink('en')}${langLink('de')}</span>
    <button class="icon-btn" type="button" data-theme-toggle data-label-dark="${t('header.theme.dark')}" data-label-light="${t('header.theme.light')}" aria-label="${t('header.theme.dark')}" hidden>${icon('moon', 'icon moon')}${icon('sun', 'icon sun')}</button>
  </nav>
</header>
<main id="main" tabindex="-1">`;
}

/** The closing of the main column and the footer: each link only when its setting is set. */
function bottom(o: ChromeOptions): string {
  const t = texts(o.lang);
  const link = (href: string | undefined, label: string) =>
    href ? `<a href="${escape(href)}">${label}</a>` : '';
  const contact = o.abuseContact
    ? `<span>${t('footer.abuse')} <a href="${escape(o.abuseContact.includes('@') && !o.abuseContact.startsWith('https://') ? `mailto:${o.abuseContact}` : o.abuseContact)}">${escape(o.abuseContact.replace(/^https:\/\//, ''))}</a></span>`
    : '';
  return `</main>
<footer class="foot">
  <span>${t('footer.licence')}</span>
  <nav class="foot-links" aria-label="${t('footer.label')}">${link(o.homepageUrl, t('footer.homepage'))}${link(o.portalUrl, t('footer.portal'))}<a href="/_demo/data?lang=${o.lang}">${t('footer.data')}</a>${link(o.imprintUrl, t('footer.imprint'))}${link(o.privacyUrl, t('footer.privacy'))}${contact}</nav>
</footer>
</body>
</html>
`;
}

/**
 * What this demo stores (`/_demo/data`): the page an operator's privacy policy can point to. It
 * states what the code does: a keyed hash of the address for 24 hours, one strictly necessary
 * cookie, the sandbox until it ends, logs without addresses or content.
 */
export function renderDataPage(o: ChromeOptions): string {
  const t = texts(o.lang);
  const items = (
    [
      ['lock', 'data.cookie.title', 'data.cookie.text'],
      ['shield', 'data.address.title', 'data.address.text'],
      ['trash', 'data.content.title', 'data.content.text'],
      ['info', 'data.logs.title', 'data.logs.text'],
    ] as const
  )
    .map(
      ([i, title, body]) =>
        `<li class="store"><span class="badge">${icon(i)}</span><div><h2>${t(title)}</h2><p>${t(body, { idle: o.idleMinutes, max: o.maxMinutes, once: o.perAddress, daily: o.perAddressDaily })}</p></div></li>`,
    )
    .join('');
  return `${top(o, { state: 'data', title: t('data.pageTitle'), here: '/_demo/data', head: '' })}
<div class="col">
  <section class="s-data" aria-labelledby="data-title">
    <h1 id="data-title">${t('data.title')}</h1>
    <p class="lede">${t('data.lede')}</p>
    <ul class="stores" role="list">${items}</ul>
    <p class="fine">${t('data.none')}</p>
    <p class="fine">${t('data.operator')}</p>
    <p class="back"><a href="/?lang=${o.lang}">${t('data.back')}</a></p>
  </section>
</div>
${bottom(o)}`;
}
