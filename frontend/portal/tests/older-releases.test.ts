import { splitReleases } from '../build/fetch.ts';
import { parseSnapshot, SNAPSHOT_FORMAT } from '../src/lib/snapshot.ts';
import { FROM_SWITCH_PARAM, placeKept } from '../src/scripts/release-switch.ts';

/**
 * Older releases (#896): how the build tells a product's newest release from its older ones and
 * where it puts them, what the pages refuse when they read the snapshot, and the link the release
 * switch follows.
 */

const release = (
  id: string,
  product: string,
  revision: string,
  manuals: string[] = ['m'],
) => ({
  id,
  product,
  productLabel: product,
  revision,
  tag: `release/${product}/${revision}`,
  publishedAt: '2026-01-01T00:00:00Z',
  notes: null,
  manuals: manuals.map((m) => ({
    id: m,
    title: m,
    audience: 'public',
    variants: [
      {
        slug: 'all',
        label: 'All',
        values: {},
        resolved: {},
        moduleAudiences: {},
        pdf: null,
      },
    ],
  })),
});

const snapshot = (over: Record<string, unknown>) => ({
  format: SNAPSHOT_FORMAT,
  audience: 'public',
  audiences: [{ id: 'public', label: 'Public' }],
  lang: 'en',
  dir: 'ltr',
  languages: ['en'],
  variantAttributes: [],
  safetySymbols: [],
  outputLabels: {},
  releases: [release('r2', 'alpha', '2.0')],
  assets: {},
  symbols: {},
  branding: null,
  ...over,
});

describe('older releases', () => {
  it('takes each product’s first (newest) release as its newest, the rest as older ones', () => {
    const lines: string[] = [];
    const { latest, older } = splitReleases(
      [
        release('a3', 'alpha', '3.0'),
        release('b1', 'beta', '1.0'),
        release('a2', 'alpha', '2.0'),
        release('a1', 'alpha', '1.0'),
      ],
      (line) => lines.push(line),
    );
    expect(latest.map((r) => r.id)).toEqual(['a3', 'b1']);
    expect(older.map((r) => [r.id, r.segment])).toEqual([
      ['a2', '2.0'],
      ['a1', '1.0'],
    ]);
    expect(lines).toEqual(['Older releases: alpha/v/2.0, alpha/v/1.0']);
  });

  it('writes nothing new by default: no older releases', () => {
    const { older } = splitReleases(
      [release('a', 'alpha', '1'), release('b', 'beta', '1')],
      () => undefined,
    );
    expect(older).toEqual([]);
    expect(parseSnapshot(snapshot({}))).toMatchObject({
      older: [],
      olderNoindex: true,
    });
  });

  it('reads older releases back, and refuses ones the pages could not place', () => {
    const older = (over: Record<string, unknown> = {}) => ({
      ...release('r1', 'alpha', '1.0'),
      segment: '1.0',
      ...over,
    });
    expect(parseSnapshot(snapshot({ older: [older()] })).older).toHaveLength(1);
    // An older release of a product without a newest one: nowhere to lead.
    expect(() =>
      parseSnapshot(snapshot({ older: [older({ product: 'beta' })] })),
    ).toThrow('has no newest release in the build');
    // Two newest releases of one product would share its addresses.
    expect(() =>
      parseSnapshot(
        snapshot({
          releases: [
            release('r2', 'alpha', '2.0'),
            release('r3', 'alpha', '3.0'),
          ],
        }),
      ),
    ).toThrow('two newest releases of alpha');
    // Two at one address.
    expect(() =>
      parseSnapshot(snapshot({ older: [older(), older({ id: 'r0' })] })),
    ).toThrow('two older releases at alpha/1.0');
    // A segment the build would never write.
    expect(() =>
      parseSnapshot(snapshot({ older: [older({ segment: '../x' })] })),
    ).toThrow();
    // A newest manual `v` would share its address with the older releases' pages.
    expect(() =>
      parseSnapshot(
        snapshot({
          releases: [release('r2', 'alpha', '2.0', ['v'])],
          older: [older()],
        }),
      ),
    ).toThrow('would share its address');
    // Older releases are checked against the audience as the newest are.
    const above = older();
    above.manuals[0]!.audience = 'internal';
    expect(() => parseSnapshot(snapshot({ older: [above] }))).toThrow(
      'above the build',
    );
  });

  it('the switch’s link carries the section and the page’s query, marked as from the switch', () => {
    const here = new URL(
      'https://docs.example.com/en/alpha/guide/?from=1.0&to=2.0#step-3',
    );
    expect(placeKept('/en/alpha/v/1.0/guide/', here, '#of-charging')).toBe(
      `/en/alpha/v/1.0/guide/?from=1.0&to=2.0&${FROM_SWITCH_PARAM}=1#of-charging`,
    );
    // Every value of a repeated key (an update guide's options) is kept.
    expect(
      placeKept(
        '/en/alpha/v/1.0/guide/',
        new URL(
          'https://docs.example.com/en/alpha/guide/?from=1.0&opt=a:x&opt=b:y',
        ),
        '',
      ),
    ).toBe(
      `/en/alpha/v/1.0/guide/?from=1.0&opt=a%3Ax&opt=b%3Ay&${FROM_SWITCH_PARAM}=1`,
    );
    // No section: the page's start.
    expect(
      placeKept('/en/alpha/m/all/', new URL('https://docs.example.com/'), ''),
    ).toBe(`/en/alpha/m/all/?${FROM_SWITCH_PARAM}=1`);
  });
});
