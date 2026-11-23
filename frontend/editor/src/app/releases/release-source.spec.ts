import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ReleaseSource } from './release-source';
import { config, manual, paged } from './testing/releases';

/** Lets the awaits after an answered request run: a fixed number of microtask turns, no timers. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup() {
  TestBed.configureTestingModule({
    providers: [ReleaseSource, provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    source: TestBed.inject(ReleaseSource),
    http: TestBed.inject(HttpTestingController),
  };
}

/** The manuals request waiting for `ref`, exactly one. */
const manualsAt = (http: HttpTestingController, ref: string): TestRequest =>
  http.expectOne(
    (r) => r.url === '/api/manuals' && r.params.get('ref') === ref,
  );

/** The configuration request waiting, exactly one. */
const configRead = (http: HttpTestingController): TestRequest =>
  http.expectOne((r) => r.url === '/api/config');

const configDoc = (source: string) => ({
  data: {
    type: 'ProjectConfig',
    id: 'main',
    attributes: { ...config(), languages: { source, targets: [] } },
  },
});

const titles = (source: ReleaseSource) =>
  source.manualsAtTag().map((m) => m.attributes.title);

describe('ReleaseSource', () => {
  afterEach(() => {
    // A test that failed half-way leaves its requests open: the next one still starts afresh.
    try {
      TestBed.inject(HttpTestingController).verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('reads the manuals at a tag, and the configuration with them', async () => {
    const { source, http } = setup();
    const read = source.readManualsAt('release/north/2.1');
    configRead(http).flush(configDoc('en'));
    manualsAt(http, 'release/north/2.1').flush(
      paged([manual('operating', 'Operating manual')]),
    );
    await read;
    await settle();
    expect(titles(source)).toEqual(['Operating manual']);
    expect(source.config()?.languages.source).toBe('en');
  });

  it('never lets a manuals read started for the previous person land after forget()', async () => {
    const { source, http } = setup();
    // The first person opens a release: the read is still running.
    void source.readManualsAt('release/north/2.1');
    const before = manualsAt(http, 'release/north/2.1');
    configRead(http).flush(configDoc('en'));

    // Another person acts now (sign-out and sign-in, or a demo switch) and reads the same tag.
    source.forget();
    void source.readManualsAt('release/north/2.1');
    const after = manualsAt(http, 'release/north/2.1');
    configRead(http).flush(configDoc('en'));

    // The first person's read answers last-but-one: nothing of it is kept.
    before.flush(paged([manual('secret', 'Only the first person sees this')]));
    await settle();
    expect(titles(source)).toEqual([]);

    after.flush(paged([manual('operating', 'Operating manual')]));
    await settle();
    expect(titles(source)).toEqual(['Operating manual']);
  });

  it('keeps nothing from a manuals read that answers after forget(), with no read since', async () => {
    const { source, http } = setup();
    void source.readManualsAt('release/north/2.1');
    configRead(http).flush(configDoc('en'));
    const before = manualsAt(http, 'release/north/2.1');

    source.forget();
    before.flush(paged([manual('secret', 'Only the first person sees this')]));
    await settle();
    expect(titles(source)).toEqual([]);
  });

  it('never lets a configuration read started before forget() land after it', async () => {
    const { source, http } = setup();
    void source.readConfig();
    const before = configRead(http);

    source.forget();
    const next = source.readConfig();
    const after = configRead(http);

    before.flush(configDoc('xx'));
    await settle();
    expect(source.config()).toBeNull();

    after.flush(configDoc('en'));
    expect((await next)?.languages.source).toBe('en');
    expect(source.config()?.languages.source).toBe('en');
  });

  it('hands a caller waiting on a configuration read from before forget() nothing', async () => {
    const { source, http } = setup();
    const waiting = source.readConfig();
    const before = configRead(http);
    source.forget();
    before.flush(configDoc('xx'));
    expect(await waiting).toBeNull();
    expect(source.config()).toBeNull();
  });

  it('a configuration read that failed before forget() does not drop the one started after it', async () => {
    const { source, http } = setup();
    void source.readConfig();
    const before = configRead(http);
    source.forget();
    const next = source.readConfig();
    const after = configRead(http);

    before.flush('down', { status: 503, statusText: 'Unavailable' });
    await settle();
    // Asked again now, the read still running is shared: no second request.
    void source.readConfig();
    http.expectNone((r) => r.url === '/api/config');

    after.flush(configDoc('en'));
    expect((await next)?.languages.source).toBe('en');
  });

  it('never shows the previous tag’s manuals for the tag read now', async () => {
    const { source, http } = setup();
    void source.readManualsAt('release/north/2.0');
    configRead(http).flush(configDoc('en'));
    manualsAt(http, 'release/north/2.0').flush(
      paged([manual('old', 'Manual at 2.0')]),
    );
    await settle();
    expect(titles(source)).toEqual(['Manual at 2.0']);

    // Another release is chosen: its tag's manuals are not there yet, and 2.0's are not shown.
    void source.readManualsAt('release/north/2.1');
    expect(titles(source)).toEqual([]);
    manualsAt(http, 'release/north/2.1').flush(
      paged([manual('new', 'Manual at 2.1')]),
    );
    await settle();
    expect(titles(source)).toEqual(['Manual at 2.1']);
  });

  it('drops a read for the tag before when it answers after the switch', async () => {
    const { source, http } = setup();
    void source.readManualsAt('release/north/2.0');
    configRead(http).flush(configDoc('en'));
    const older = manualsAt(http, 'release/north/2.0');

    void source.readManualsAt('release/north/2.1');
    const newer = manualsAt(http, 'release/north/2.1');

    older.flush(paged([manual('old', 'Manual at 2.0')]));
    await settle();
    expect(titles(source)).toEqual([]);

    newer.flush(paged([manual('new', 'Manual at 2.1')]));
    await settle();
    expect(titles(source)).toEqual(['Manual at 2.1']);
  });

  it('drops an older read of a tag chosen again, so only the latest read of it lands', async () => {
    const { source, http } = setup();
    void source.readManualsAt('release/north/2.0');
    configRead(http).flush(configDoc('en'));
    const first = manualsAt(http, 'release/north/2.0');
    void source.readManualsAt('release/north/2.1');
    const between = manualsAt(http, 'release/north/2.1');
    void source.readManualsAt('release/north/2.0');
    const again = manualsAt(http, 'release/north/2.0');

    first.flush(paged([manual('first', 'First answer')]));
    between.flush(paged([manual('between', 'Manual at 2.1')]));
    await settle();
    expect(titles(source)).toEqual([]);

    again.flush(paged([manual('again', 'Latest answer')]));
    await settle();
    expect(titles(source)).toEqual(['Latest answer']);
  });

  it('a failed read clears the list for its tag and is tried again next time', async () => {
    const { source, http } = setup();
    void source.readManualsAt('release/north/2.0');
    configRead(http).flush(configDoc('en'));
    manualsAt(http, 'release/north/2.0').flush(
      paged([manual('old', 'Manual at 2.0')]),
    );
    await settle();

    const failing = source.readManualsAt('release/north/2.1');
    manualsAt(http, 'release/north/2.1').flush('down', {
      status: 503,
      statusText: 'Unavailable',
    });
    await failing;
    expect(titles(source)).toEqual([]);

    void source.readManualsAt('release/north/2.1');
    manualsAt(http, 'release/north/2.1').flush(
      paged([manual('new', 'Manual at 2.1')]),
    );
    await settle();
    expect(titles(source)).toEqual(['Manual at 2.1']);
  });

  it('a read of the same tag that failed after forget() keeps nothing and asks again', async () => {
    const { source, http } = setup();
    void source.readManualsAt('release/north/2.1');
    configRead(http).flush(configDoc('en'));
    manualsAt(http, 'release/north/2.1').flush(
      paged([manual('secret', 'Only the first person sees this')]),
    );
    await settle();
    expect(titles(source)).toEqual(['Only the first person sees this']);

    source.forget();
    expect(titles(source)).toEqual([]);
    const failing = source.readManualsAt('release/north/2.1');
    configRead(http).flush(configDoc('en'));
    manualsAt(http, 'release/north/2.1').flush('down', {
      status: 503,
      statusText: 'Unavailable',
    });
    await failing;
    expect(titles(source)).toEqual([]);
  });
});
