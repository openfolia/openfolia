// @vitest-environment jsdom
/// <reference lib="dom" />
import type { Block, ResolvedManual } from '@openfolia/content-model';
import { resolve } from '../testing/fixture.js';
import { renderManualHtml, type HtmlRenderOptions } from './render.js';
import { CALLOUT_HIGHLIGHTED, highlightCallouts } from './callout-highlight.js';

// Image callouts in the preview (#546): an SVG over the picture with the leader lines and the
// markers, the legend, and references printing the marker's number.

const options: HtmlRenderOptions = { assetUrl: (hash) => `/assets/${hash}` };

function body(manual: ResolvedManual): HTMLElement {
  return new DOMParser().parseFromString(
    `<!doctype html><body>${renderManualHtml(manual, options).html}`,
    'text/html',
  ).body;
}

const photo = (root: HTMLElement) =>
  root.querySelector('#of-charging--photo') as HTMLElement;

/** Each marker's number and place, in the order drawn. */
const markers = (figure: HTMLElement) =>
  [...figure.querySelectorAll('.of-callouts__marker')].map((g) => {
    const circle = g.querySelector('circle');
    return {
      n: g.querySelector('text')?.textContent,
      x: circle?.getAttribute('cx'),
      y: circle?.getAttribute('cy'),
    };
  });

const legend = (figure: HTMLElement) =>
  [...figure.querySelectorAll('.of-callouts__entry')].map((li) =>
    li.textContent?.trim(),
  );

const refs = (root: HTMLElement) =>
  [...root.querySelectorAll('#of-charging--intro .of-callout-ref')].map(
    (span) => span.textContent,
  );

describe('callouts in the HTML', () => {
  it('numbers markers, legend and references by the variant, with no gaps', () => {
    const large = body(resolve('large', 'en').manual);
    expect(markers(photo(large))).toEqual([
      { n: '1', x: '85.00%', y: '10.00%' },
      { n: '2', x: '20.00%', y: '30.00%' },
      { n: '3', x: '50.00%', y: '90.00%' },
    ]);
    expect(legend(photo(large))).toEqual([
      '1 Fan, large model',
      '2 Power switch',
      '3 Socket',
    ]);
    // "The socket (3) and the fan (1)."
    expect(refs(large)).toEqual(['3', '1']);

    const small = body(resolve('small', 'en').manual);
    expect(markers(photo(small))).toEqual([
      { n: '1', x: '20.00%', y: '30.00%' },
      { n: '2', x: '50.00%', y: '90.00%' },
    ]);
    expect(legend(photo(small))).toEqual(['1 Power switch', '2 Socket']);
    // The fan is not on the small model: its reference reads "?", muted.
    expect(refs(small)).toEqual(['2', '?']);
    expect(
      small.querySelector('.of-callout-ref--unresolved')?.textContent,
    ).toBe('?');
  });

  it('draws a leader line from the anchor to the label, in an SVG hidden from screen readers', () => {
    const figure = photo(body(resolve('large', 'en').manual));
    const svg = figure.querySelector('svg.of-callouts__overlay');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('width')).toBe('100%');
    expect(svg?.hasAttribute('viewBox')).toBe(false);
    const line = figure.querySelector('line.of-callouts__leader');
    expect(['x1', 'y1', 'x2', 'y2'].map((a) => line?.getAttribute(a))).toEqual([
      '60.00%',
      '50.00%',
      '85.00%',
      '10.00%',
    ]);
    expect(figure.querySelectorAll('line')).toHaveLength(1);
    expect(
      figure
        .querySelector('[data-callout-style]')
        ?.getAttribute('data-callout-style'),
    ).toBe('square');
    // The picture, the SVG over it, the legend and the caption, in that order.
    expect(
      [...figure.querySelectorAll('img, svg, ol, figcaption')].map((el) =>
        el.tagName.toLowerCase(),
      ),
    ).toEqual(['img', 'svg', 'ol', 'figcaption']);
  });

  it('places the legend below, beside or nowhere', () => {
    const manual = resolve('large', 'en').manual;
    const root = body(manual);
    expect(photo(root).querySelector('.of-callouts--below')).not.toBeNull();
    expect(
      root.querySelector('#of-charging--plain-photo .of-callouts--beside'),
    ).not.toBeNull();
    const image = findImage(manual, 'charging--photo');
    image.calloutLegend = 'none';
    const none = photo(body(manual));
    expect(none.querySelector('.of-callouts--none')).not.toBeNull();
    expect(none.querySelector('ol')).toBeNull();
    expect(markers(none)).toHaveLength(3);
  });

  it('keeps marker positions in right-to-left text: image coordinates never mirror', () => {
    const manual = resolve('large', 'en').manual;
    const rtl: ResolvedManual = {
      ...manual,
      lang: 'ar',
      directions: { ar: 'rtl' },
    } as ResolvedManual;
    expect(markers(photo(body(rtl)))).toEqual(markers(photo(body(manual))));
  });

  it('writes only numbers it formats and configuration keys', () => {
    const manual = resolve('large', 'en').manual;
    const image = findImage(manual, 'charging--photo');
    const fan = image.callouts?.find((c) => c.id === 'fan');
    const switchOn = image.callouts?.find((c) => c.id === 'switch');
    Object.assign(switchOn as object, { anchor: { x: Number.NaN, y: 7 } });
    Object.assign(fan as object, {
      style: '" onload="alert(1)',
    });
    Object.assign(image, { calloutLegend: 'x" onclick="y' });
    const figure = photo(body(manual));
    expect(markers(figure)[0]).toEqual({ n: '1', x: '85.00%', y: '10.00%' });
    expect(markers(figure)).toContainEqual({
      n: '2',
      x: '0.00%',
      y: '100.00%',
    });
    expect(figure.querySelectorAll('[data-callout-style]')).toHaveLength(0);
    expect(figure.querySelector('.of-callouts--below')).not.toBeNull();
  });
});

describe('callout keys and highlighting (#549)', () => {
  /** The keys of every part, by its class. */
  const keys = (root: HTMLElement, selector: string) =>
    [...root.querySelectorAll(selector)].map((el) =>
      el.getAttribute('data-callout'),
    );

  it('ties each marker, leader line, legend entry and reference together by one key', () => {
    const root = body(resolve('large', 'en').manual);
    const figure = photo(root);
    expect(keys(figure, '.of-callouts__marker')).toEqual([
      'charging--photo:fan',
      'charging--photo:switch',
      'charging--photo:socket',
    ]);
    expect(keys(figure, '.of-callouts__entry')).toEqual(
      keys(figure, '.of-callouts__marker'),
    );
    expect(keys(figure, '.of-callouts__leader')).toEqual([
      'charging--photo:fan',
    ]);
    expect(keys(figure, '.of-callouts__anchor')).toEqual([
      'charging--photo:fan',
    ]);
    // A numbered reference is a link to its picture, with its callout's key.
    const links = [
      ...root.querySelectorAll('#of-charging--intro a.of-callout-ref'),
    ];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['#of-charging--photo', '3'],
      ['#of-charging--photo', '1'],
    ]);
    expect(keys(root, '#of-charging--intro .of-callout-ref')).toEqual([
      'charging--photo:socket',
      'charging--photo:fan',
    ]);
  });

  it('leaves a reference the variant does not show as text, without a key', () => {
    const root = body(resolve('small', 'en').manual);
    const unresolved = root.querySelector('.of-callout-ref--unresolved');
    expect(unresolved?.tagName).toBe('SPAN');
    expect(unresolved?.hasAttribute('data-callout')).toBe(false);
  });

  it('writes no key for an ID the model does not allow', () => {
    const manual = resolve('large', 'en').manual;
    const image = findImage(manual, 'charging--photo');
    Object.assign(image.callouts?.[0] as object, { id: 'Bad" x="1' });
    const figure = photo(body(manual));
    expect(keys(figure, '.of-callouts__marker')).toEqual([
      null,
      'charging--photo:switch',
      'charging--photo:socket',
    ]);
  });

  describe('highlightCallouts', () => {
    let stop: () => void = () => undefined;
    afterEach(() => stop());

    const highlighted = () =>
      [...document.querySelectorAll(`.${CALLOUT_HIGHLIGHTED}`)].map(
        (el) =>
          `${el.getAttribute('class')?.split(' ')[0]} ${el.getAttribute('data-callout')}`,
      );

    function setUp() {
      document.body.innerHTML = renderManualHtml(
        resolve('large', 'en').manual,
        options,
      ).html;
      stop = highlightCallouts(document);
    }

    it('highlights every part of the callout under the pointer, and nothing once it moves off', () => {
      setUp();
      const fan = document.querySelector(
        '.of-callouts__marker[data-callout="charging--photo:fan"] text',
      ) as Element;
      fan.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // In document order: the text's reference comes before the picture.
      expect(highlighted()).toEqual([
        'of-callout-ref charging--photo:fan',
        'of-callouts__leader charging--photo:fan',
        'of-callouts__anchor charging--photo:fan',
        'of-callouts__marker charging--photo:fan',
        'of-callouts__entry charging--photo:fan',
      ]);
      // Onto the legend entry of another callout: that one instead.
      const entry = document.querySelector(
        '.of-callouts__entry[data-callout="charging--photo:socket"] .of-callouts__text',
      ) as Element;
      entry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(highlighted()).toEqual([
        'of-callout-ref charging--photo:socket',
        'of-callouts__marker charging--photo:socket',
        'of-callouts__entry charging--photo:socket',
      ]);
      // Onto plain text, then off the page.
      document
        .querySelector('.of-manual__title')
        ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(highlighted()).toEqual([]);
      entry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      entry.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }),
      );
      expect(highlighted()).toEqual([]);
    });

    it('highlights the callout of a reference holding the keyboard focus', () => {
      setUp();
      const [socket] = [
        ...document.querySelectorAll<HTMLElement>('a.of-callout-ref'),
      ];
      socket?.focus();
      expect(highlighted()).toContain(
        'of-callouts__marker charging--photo:socket',
      );
      socket?.blur();
      expect(highlighted()).toEqual([]);
    });

    it('takes the highlight away and stops listening when stopped', () => {
      setUp();
      const [socket] = [
        ...document.querySelectorAll<HTMLElement>('a.of-callout-ref'),
      ];
      socket?.focus();
      stop();
      expect(highlighted()).toEqual([]);
      socket?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(highlighted()).toEqual([]);
    });
  });
});

function findImage(
  manual: ResolvedManual,
  id: string,
): Extract<Block, { type: 'image' }> {
  for (const entry of manual.entries) {
    if (entry.kind !== 'module') continue;
    const found = entry.blocks.find((b) => b.id === id);
    if (found?.type === 'image') return found;
  }
  throw new Error(`no image ${id}`);
}
