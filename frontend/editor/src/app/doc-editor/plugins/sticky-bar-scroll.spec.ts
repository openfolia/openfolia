import { stuckBar } from './sticky-bar-scroll';

/** jsdom lays nothing out: each element gets the rectangle the test gives it. */
function place(el: Element, top: number, height: number): void {
  el.getBoundingClientRect = () => new DOMRect(0, top, 300, height);
}

/** A scroller (`main`) holding a card with the bar and the document's scroller after it. */
function page(sticky = true) {
  const main = document.createElement('main');
  main.style.overflowY = 'auto';
  const card = main.appendChild(document.createElement('div'));
  const bar = card.appendChild(document.createElement('div'));
  if (sticky) bar.style.position = 'sticky';
  const canvas = card.appendChild(document.createElement('div'));
  document.body.append(main);
  place(main, 0, 800);
  return { main, bar, canvas };
}

afterEach(() => document.body.replaceChildren());

describe('stuckBar (#886)', () => {
  it('is null while the bar sits in the flow, above the document', () => {
    const { bar, canvas } = page();
    place(bar, 180, 44);
    place(canvas, 224, 1000);
    expect(stuckBar(bar)).toBeNull();
  });

  it('covers from the scroller’s top to the bar’s bottom while the document passes under it', () => {
    const { bar, canvas } = page();
    place(bar, 16, 71);
    place(canvas, -600, 1000);
    expect(stuckBar(bar)).toEqual({ band: 87, gap: 16 });
  });

  it('is null for a bar that is not sticky, or none', () => {
    const { bar, canvas } = page(false);
    place(bar, 16, 71);
    place(canvas, -600, 1000);
    expect(stuckBar(bar)).toBeNull();
    expect(stuckBar(null)).toBeNull();
  });
});
