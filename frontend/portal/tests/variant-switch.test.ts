import { onlyAsText, switchNoticeText, TEXTS } from '../src/lib/i18n.ts';
import { switchHref, variantSwitches } from '../src/lib/variant-switch.ts';

const ATTRIBUTES = [
  {
    id: 'body',
    label: 'Body',
    values: [
      { id: 'hatchback', label: 'Hatchback' },
      { id: 'estate', label: 'Estate' },
    ],
  },
  {
    id: 'drive',
    label: 'Drive',
    values: [
      { id: 'petrol', label: 'Petrol' },
      { id: 'electric', label: 'Electric' },
    ],
  },
  {
    id: 'market',
    label: 'Market',
    values: [
      { id: 'eu', label: 'EU' },
      { id: 'uk', label: 'UK' },
    ],
  },
];

// Three of eight combinations, as the demo manual publishes them.
const v = (body: string, drive: string, market: string) => ({
  slug: `${body}-${drive}-${market}`,
  values: { body, drive, market },
});
const VARIANTS = [
  v('hatchback', 'petrol', 'eu'),
  v('estate', 'electric', 'eu'),
  v('hatchback', 'electric', 'uk'),
];

const option = (
  current: (typeof VARIANTS)[number],
  attribute: string,
  value: string,
) => {
  const choice = variantSwitches(VARIANTS, current, ATTRIBUTES).find(
    (c) => c.attribute === attribute,
  );
  const found = choice?.options.find((o) => o.value === value);
  if (!found) throw new Error(`no option ${attribute}=${value}`);
  return found;
};

describe('the variant switch', () => {
  it('offers each attribute that tells the variants apart, in the configured order', () => {
    const switches = variantSwitches(VARIANTS, VARIANTS[0]!, ATTRIBUTES);
    expect(
      switches.map((s) => [s.label, s.options.map((o) => o.label)]),
    ).toEqual([
      ['Body', ['Hatchback', 'Estate']],
      ['Drive', ['Petrol', 'Electric']],
      ['Market', ['EU', 'UK']],
    ]);
  });

  it('keeps the other values when that combination is published, and says nothing', () => {
    const variants = [
      v('hatchback', 'petrol', 'eu'),
      v('estate', 'petrol', 'eu'),
    ];
    const estate = variantSwitches(variants, variants[0]!, ATTRIBUTES)[0]
      ?.options[1];
    expect(estate?.target).toBe(variants[1]);
    expect(estate?.changes).toEqual([]);
    const self = option(VARIANTS[1]!, 'body', 'estate');
    expect(self.current).toBe(true);
    expect(self.target).toBe(VARIANTS[1]);
    expect(self.changes).toEqual([]);
  });

  it('names every other attribute an option changes, with the value it changes to', () => {
    const estate = option(VARIANTS[0]!, 'body', 'estate');
    expect(estate.target).toBe(VARIANTS[1]);
    expect(estate.changes).toEqual([
      { attribute: 'drive', attributeLabel: 'Drive', valueLabel: 'Electric' },
    ]);
    const uk = option(VARIANTS[0]!, 'market', 'uk');
    expect(uk.target).toBe(VARIANTS[2]);
    expect(uk.changes).toEqual([
      { attribute: 'drive', attributeLabel: 'Drive', valueLabel: 'Electric' },
    ]);
  });

  it('leads to the variant that keeps the most values, the first on a tie', () => {
    const variants = [
      v('estate', 'electric', 'uk'),
      v('estate', 'petrol', 'uk'),
      v('hatchback', 'petrol', 'eu'),
    ];
    const switches = variantSwitches(variants, variants[2]!, ATTRIBUTES);
    const estate = switches[0]?.options.find((o) => o.value === 'estate');
    expect(estate?.target).toBe(variants[1]);
    expect(estate?.changes.map((c) => c.valueLabel)).toEqual(['UK']);
  });

  it('labels values the configuration does not list by their ID', () => {
    const variants = [v('hatchback', 'petrol', 'eu'), v('van', 'petrol', 'eu')];
    const switches = variantSwitches(variants, variants[0]!, ATTRIBUTES);
    expect(switches.map((s) => s.options.map((o) => o.label))).toEqual([
      ['Hatchback', 'van'],
    ]);
  });

  it('adds what changed to the link only when something else changes', () => {
    expect(switchHref('/en/p/m/x/', 'body', [])).toBe('/en/p/m/x/');
    const estate = option(VARIANTS[0]!, 'body', 'estate');
    expect(switchHref('/en/p/m/x/', 'body', estate.changes)).toBe(
      '/en/p/m/x/?switched=body&changed=drive',
    );
  });
});

describe('the variant switch texts', () => {
  const change = [{ attribute: 'Drive', value: 'Electric' }];
  const two = [...change, { attribute: 'Market', value: 'UK' }];

  it('says what an option changes before the click', () => {
    expect(onlyAsText(TEXTS.en, 'en', ['Electric'])).toBe('only as Electric');
    expect(onlyAsText(TEXTS.en, 'en', ['Electric', 'UK'])).toBe(
      'only as Electric and UK',
    );
    expect(onlyAsText(TEXTS.de, 'de', ['Elektro', 'UK'])).toBe(
      'nur als Elektro und UK',
    );
  });

  it('says what changed after it, in English and German', () => {
    expect(switchNoticeText(TEXTS.en, 'en', 'Estate', change)).toBe(
      'Estate is published as Electric only, so Drive changed to Electric.',
    );
    expect(switchNoticeText(TEXTS.en, 'en', 'Estate', two)).toBe(
      'Estate is published as Electric and UK only, so Drive changed to Electric and Market changed to UK.',
    );
    expect(
      switchNoticeText(TEXTS.de, 'de', 'Kombi', [
        { attribute: 'Antrieb', value: 'Elektro' },
      ]),
    ).toBe(
      'Kombi ist nur als Elektro veröffentlicht, daher wurde Antrieb auf Elektro umgestellt.',
    );
    expect(
      switchNoticeText(TEXTS.de, 'de', 'Kombi', [
        { attribute: 'Antrieb', value: 'Elektro' },
        { attribute: 'Markt', value: 'UK' },
      ]),
    ).toBe(
      'Kombi ist nur als Elektro und UK veröffentlicht, daher wurden Antrieb auf Elektro und Markt auf UK umgestellt.',
    );
  });

  it('never fills a placeholder a label holds', () => {
    expect(
      switchNoticeText(TEXTS.en, 'en', '{values} $&', [
        { attribute: '{value}', value: '$1' },
      ]),
    ).toBe('{values} $& is published as $1 only, so {value} changed to $1.');
  });
});
