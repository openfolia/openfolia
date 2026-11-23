// @vitest-environment jsdom
/// <reference lib="dom" />
import type { ResolvedManual } from '@openfolia/content-model';
import { resolve } from '../testing/fixture.js';
import { renderManualHtml, renderModuleHtml } from './render.js';
import { dismissTermOnEscape, TERM_DISMISSED } from './term-tooltips.js';

/** Term links and the glossary (#245). */

const options = { assetUrl: (hash: string) => `/assets/${hash}` };

const manualOf = (lang = 'en'): ResolvedManual => resolve('large', lang).manual;

const parse = (html: string): HTMLElement =>
  new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
    .body;

const $ = (root: Element, selector: string) => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el as HTMLElement;
};

describe('term links', () => {
  it('resolving lists exactly the linked terms the manual has, alphabetical', () => {
    expect(manualOf().terms?.map((t) => [t.id, t.lang, t.preferred])).toEqual([
      ['charger', 'en', 'charger'],
      ['socket', 'en', 'charging socket'],
    ]);
    expect(manualOf().glossary).toBe(true);
  });

  it('links a term to its glossary entry, its definition the link’s description', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const link = $(body, '#of-charging--terms a.of-term__link');
    expect(link.textContent).toBe('charger');
    expect(link.getAttribute('href')).toBe('#of-_term-charger');
    const tip = $(body, `#${link.getAttribute('aria-describedby') ?? ''}`);
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toBe(
      'The device that charges the battery <safely>.',
    );
    expect(tip.previousElementSibling).toBe(link);
    expect(tip.parentElement?.className).toBe('of-term');
    // Its target exists: the glossary entry.
    expect($(body, '#of-_term-charger dfn').textContent).toBe('charger');
  });

  it('keeps marks inside a term link and makes the runs of one link one', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const links = [
      ...body.querySelectorAll('#of-charging--terms .of-term__link'),
    ];
    expect(links.map((l) => l.innerHTML)).toEqual([
      'charger',
      'charging <strong>socket</strong>',
    ]);
    // Each tooltip has an ID of its own.
    const tips = [...body.querySelectorAll('.of-term__definition')].map(
      (t) => t.id,
    );
    expect(new Set(tips).size).toBe(tips.length);
  });

  it('shows a term the manual has no entry for as plain text', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const unknown = $(body, '.of-term--unresolved');
    expect(unknown.textContent).toBe('dock');
    expect(unknown.querySelector('a, [tabindex]')).toBeNull();
  });

  it('lists the glossary last, in the contents too, with each term and its definition', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const glossary = $(body, 'article > section.of-glossary:last-child');
    expect(glossary.id).toBe('of-_glossary');
    expect($(glossary, 'h2').textContent).toBe('Glossary');
    expect(
      [...glossary.querySelectorAll('.of-glossary__entry')].map((e) => [
        e.id,
        e.querySelector('dt')?.textContent,
        e.querySelector('dd')?.textContent,
      ]),
    ).toEqual([
      [
        'of-_term-charger',
        'charger',
        'The device that charges the battery <safely>.',
      ],
      ['of-_term-socket', 'charging socket', 'Where the cable plugs in.'],
    ]);
    const toc = [...body.querySelectorAll('nav.of-toc a')];
    expect(toc.at(-1)?.getAttribute('href')).toBe('#of-_glossary');
    // A space between a term and its definition: extracted text (a search index, a copy) never runs them together (#784).
    expect(
      glossary.querySelector('.of-glossary__entry')?.textContent,
    ).toBe('charger The device that charges the battery <safely>.');
  });

  it('in another language: the term’s own, else the source language’s, marked as such', () => {
    const manual = manualOf('de');
    expect(manual.terms?.map((t) => [t.id, t.lang, t.preferred])).toEqual([
      ['charger', 'en', 'charger'],
      ['socket', 'de', 'Ladebuchse'],
    ]);
    const body = parse(renderManualHtml(manual, options).html);
    const glossary = $(body, '.of-glossary');
    expect($(glossary, 'h2').textContent).toBe('Glossar');
    expect($(glossary, '#of-_term-charger').getAttribute('lang')).toBe('en');
    expect($(glossary, '#of-_term-socket').hasAttribute('lang')).toBe(false);
    // The charging module fell back to English: its tooltip is in its language already.
    const charger = $(body, '#of-charging--terms .of-term__definition');
    expect(charger.hasAttribute('lang')).toBe(false);
    // A term without a definition links without a tooltip.
    const socket = [
      ...body.querySelectorAll('#of-charging--terms .of-term'),
    ][1] as HTMLElement;
    expect(socket.querySelector('.of-term__definition')).toBeNull();
    expect($(socket, 'a.of-term__link').hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  it('without a glossary, a term is focusable text with its tooltip', () => {
    const manual = manualOf();
    const module = renderModuleHtml(manual, 'charging', options);
    const body = parse(module?.html ?? '');
    expect(body.querySelector('.of-glossary')).toBeNull();
    expect(body.querySelector('a.of-term__link')).toBeNull();
    const link = $(body, 'span.of-term__link');
    expect(link.getAttribute('tabindex')).toBe('0');
    expect(
      $(body, `#${link.getAttribute('aria-describedby') ?? ''}`).textContent,
    ).toBe('The device that charges the battery <safely>.');

    const without = renderManualHtml({ ...manual, glossary: false }, options);
    expect(parse(without.html).querySelector('.of-glossary')).toBeNull();
    expect(parse(without.html).querySelector('a.of-term__link')).toBeNull();
  });

  it('a glossary with no linked term is left out', () => {
    const { html } = renderManualHtml({ ...manualOf(), terms: [] }, options);
    expect(parse(html).querySelector('.of-glossary')).toBeNull();
    expect(parse(html).querySelector('.of-term__link')).toBeNull();
  });
});

describe('dismissTermOnEscape', () => {
  it('hides the tooltip under focus on Escape until the focus leaves the term', () => {
    document.body.innerHTML = renderModuleHtml(manualOf(), 'charging', options)
      ?.html as string;
    const stop = dismissTermOnEscape(document);
    const [first, second] = [
      ...document.querySelectorAll<HTMLElement>('span.of-term__link'),
    ];
    first?.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const term = first?.parentElement as HTMLElement;
    expect(term.classList.contains(TERM_DISMISSED)).toBe(true);
    // Moving within it keeps it hidden; moving elsewhere shows it again next time.
    first?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(term.classList.contains(TERM_DISMISSED)).toBe(true);
    second?.focus();
    expect(term.classList.contains(TERM_DISMISSED)).toBe(false);
    // Another key does nothing.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(document.querySelector(`.${TERM_DISMISSED}`)).toBeNull();
    stop();
    second?.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector(`.${TERM_DISMISSED}`)).toBeNull();
  });
});
