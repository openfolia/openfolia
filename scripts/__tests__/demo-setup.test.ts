import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDemoProcess,
  parseCommand,
  startOptions,
  startUrl,
} from '@/scripts/demo/demo.mjs';
import { readDemoContent } from '@/scripts/demo/content.mjs';
import {
  markTipsSeen,
  raiseTyrePressure,
  reviseWheelChange,
  TIPS_FIRST_VISIT,
  TIPS_SEEN,
  TRANSLATIONS,
  waitForOutputs,
  withTexts,
} from '@/scripts/demo/populate.mjs';
import { DEMO_PEOPLE } from '@/scripts/demo/people.mjs';
import { SANDBOX_TIPS } from '@/scripts/demo/bake.mjs';
import { DEFAULT_PORTS } from '@/scripts/demo/paths.mjs';
import { framePage, LOOK } from '@/scripts/demo/stills.mjs';

/** The demo set-up's commands and the changes it makes through the API (#441). */
describe('the demo command line', () => {
  it('takes a command and only the options given', () => {
    expect(parseCommand(['start', '--lang', 'de', '--user', 'admin'])).toEqual({
      command: 'start',
      options: { lang: 'de', user: 'admin' },
      build: true,
    });
    expect(parseCommand(['reset', '--no-build'])).toEqual({
      command: 'reset',
      options: {},
      build: false,
    });
  });

  it('refuses an unknown command, language, person or theme', () => {
    expect(() => parseCommand(['film'])).toThrow(/Usage/);
    expect(() => parseCommand([])).toThrow(/Usage/);
    expect(() => parseCommand(['start', '--lang', 'fr'])).toThrow(/--lang/);
    expect(() => parseCommand(['start', '--user', 'root'])).toThrow(/--user/);
    expect(() => parseCommand(['start', '--theme', 'blue'])).toThrow(/--theme/);
    expect(() => parseCommand(['start', '--bogus'])).toThrow();
  });

  it("never takes the person's own ports, or one port twice", () => {
    for (const port of ['3100', '4310', '4320']) {
      expect(() => parseCommand(['start', '--api-port', port])).toThrow(
        /person's own/,
      );
    }
    expect(() => parseCommand(['start', '--editor-port', '80'])).toThrow(
      /1024 to 65535/,
    );
    expect(() =>
      parseCommand(['start', '--api-port', '5000', '--editor-port', '5000']),
    ).toThrow(/differ/);
    expect(parseCommand(['start', '--api-port', '5000']).options.apiPort).toBe(
      5000,
    );
  });

  it('starts with the defaults, a reset with the running demo’s options', () => {
    expect(startOptions({})).toEqual({
      lang: 'en',
      user: 'author',
      theme: 'light',
      apiPort: DEFAULT_PORTS.api,
      editorPort: DEFAULT_PORTS.editor,
    });
    expect(
      startOptions({ theme: 'dark' }, { lang: 'de', user: 'reviewer' }),
    ).toMatchObject({ lang: 'de', user: 'reviewer', theme: 'dark' });
    expect([3100, 4310, 4320]).not.toContain(DEFAULT_PORTS.api);
    expect([3100, 4310, 4320]).not.toContain(DEFAULT_PORTS.editor);
  });

  it("opens the editor through the start page, as the person's demo user", () => {
    expect(
      startUrl('http://127.0.0.1:4390', {
        lang: 'de',
        user: 'reviewer',
        theme: 'dark',
      }),
    ).toBe(
      'http://127.0.0.1:4390/__start?lang=de&user=demo-reviewer&theme=dark',
    );
  });
});

describe('stopping the demo', () => {
  it('signals a recorded pid only while it is still the demo process', () => {
    expect(
      isDemoProcess({
        pgid: 1,
        command: '/usr/bin/node /repo/scripts/demo/run.mjs',
      }),
    ).toBe(true);
    expect(
      isDemoProcess({
        pgid: 1,
        command: '/usr/bin/node /repo/scripts/demo/run.mjs.bak',
      }),
    ).toBe(false);
    expect(isDemoProcess({ pgid: 1, command: 'node server.js' })).toBe(false);
    expect(isDemoProcess(undefined)).toBe(false);
  });
});

describe('the changes the demo makes', () => {
  const content = readDemoContent();

  it.each([
    ['en', '2.9 bar', '3.1 bar'],
    ['de', '2,9 bar', '3,1 bar'],
    ['fr', '2,9 bar', '3,1 bar'],
  ])(
    'raises one tyre pressure in %s and changes nothing else',
    (lang, before, after) => {
      const data = content.modules[lang]['tyre-pressures'];
      const text = JSON.stringify(raiseTyrePressure(data, lang));
      expect(text).toContain(`"${after}"`);
      expect(JSON.stringify(data)).toContain(`"${before}"`);
      expect(text.replace(`"${after}"`, `"${before}"`)).toEqual(
        JSON.stringify(data),
      );
    },
  );

  it('refuses a block without inline text', () => {
    const data = content.modules.en['tyre-pressures'];
    expect(() => withTexts(data, { hatchback: 'x' })).toThrow(
      /no inline content/,
    );
  });

  it('changes every translation with its source, so none goes out of date', () => {
    expect(TRANSLATIONS).toEqual(content.config.languages.targets);
  });

  it.each(['en', 'de', 'fr'])(
    'revises changing a wheel in %s: two texts, the term kept, and a last step',
    (lang) => {
      const before = content.modules[lang]['changing-a-wheel'];
      const after = reviseWheelChange(before, lang);
      const steps = (m: typeof before) =>
        m.blocks
          .find((b: { id?: string }) => b.id === 'steps')
          .steps.map((s: { id: string }) => s.id);
      expect(steps(after)).toEqual([...steps(before), 'step-retighten']);
      expect(JSON.stringify(after)).toContain('"termId":"wheel-bolt"');
      expect(JSON.stringify(after)).not.toEqual(JSON.stringify(before));
    },
  );
});

describe('the still frame', () => {
  it('puts the recording in the approved window', () => {
    const page = framePage('AAAA');
    const { window: w } = LOOK;
    expect(page).toContain(
      `left:${w.x}px;top:${w.y}px;width:${w.width}px;height:${w.height}px;border-radius:${w.radius}px`,
    );
    expect(page).toContain(LOOK.background);
    expect(w.width / w.height).toBeCloseTo(
      LOOK.recording.width / LOOK.recording.height,
    );
  });
});

describe('the first-run tips', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A fetch that answers every preferences change as the API does, and records it. */
  function preferencesApi(
    answer = (body: { data: { attributes: object } }) => body.data.attributes,
  ) {
    const calls: {
      url: string;
      method: string;
      user: string;
      body: unknown;
    }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        const body = JSON.parse(String(init.body));
        calls.push({
          url,
          method: init.method ?? 'GET',
          user: headers['X-Ccms-User'],
          body,
        });
        return new Response(
          JSON.stringify({
            data: {
              type: 'Preferences',
              id: headers['X-Ccms-User'],
              attributes: {
                showTips: true,
                dismissedTips: [],
                tourDone: false,
                ...answer(body),
              },
            },
          }),
          { status: 200 },
        );
      }),
    );
    return calls;
  }

  it('are marked as seen for every demo person, each as themself, as a skipped tour is', async () => {
    const calls = preferencesApi();
    await markTipsSeen({ apiUrl: 'http://127.0.0.1:3290', token: 't' });
    expect(calls.map((call) => call.user).sort()).toEqual(
      Object.values(DEMO_PEOPLE)
        .map((person) => person.id)
        .sort(),
    );
    for (const call of calls) {
      expect(call).toMatchObject({
        url: 'http://127.0.0.1:3290/me/preferences',
        method: 'PATCH',
        body: {
          data: {
            type: 'Preferences',
            attributes: { tourDone: true, showTips: false },
          },
        },
      });
    }
    expect(TIPS_SEEN.tourDone).toBe(true);
  });

  it('fail the set-up when the API does not keep them', async () => {
    preferencesApi(() => ({ tourDone: false, showTips: true }));
    await expect(
      markTipsSeen({ apiUrl: 'http://127.0.0.1:3290', token: 't' }),
    ).rejects.toThrow(/not marked as asked/);
  });

  it('are a first visit in a sandbox: the tour to come, the tips on (#868)', async () => {
    expect(SANDBOX_TIPS).toEqual({ tourDone: false, showTips: true });
    expect(SANDBOX_TIPS).toBe(TIPS_FIRST_VISIT);
    const calls = preferencesApi();
    await markTipsSeen({
      apiUrl: 'http://127.0.0.1:3290',
      token: 't',
      tips: SANDBOX_TIPS,
    });
    expect(calls).toHaveLength(Object.values(DEMO_PEOPLE).length);
    for (const call of calls) {
      expect(call.body).toEqual({
        data: {
          type: 'Preferences',
          attributes: { tourDone: false, showTips: true },
        },
      });
    }
  });
});

describe('waiting for the release files', () => {
  /** A client whose releases answer the given output states, one list per poll. */
  const releases = (polls: Record<string, string>[]) => {
    let poll = -1;
    let seen = 0;
    return {
      get: async (path: string) => {
        if (seen++ % 2 === 0) poll += 1;
        const id = path.split('/').pop() as string;
        const state = polls[Math.min(poll, polls.length - 1)][id];
        return {
          data: { attributes: { revision: id }, meta: { outputs: { state } } },
        };
      },
    };
  };

  it('waits for a release still planning its outputs, even when another is done', async () => {
    const client = releases([
      { a: 'done', b: 'planning' },
      { a: 'done', b: 'rendering' },
      { a: 'done', b: 'done' },
    ]);
    const outputs = await waitForOutputs(
      client,
      ['a', 'b'],
      60_000,
      () => undefined,
      0,
    );
    expect(outputs).toEqual({ a: { state: 'done' }, b: { state: 'done' } });
  });

  it('settles on a failed release, and gives up after its time', async () => {
    const failed = releases([{ a: 'failed', b: 'done' }]);
    expect(
      await waitForOutputs(failed, ['a', 'b'], 60_000, () => undefined, 0),
    ).toEqual({
      a: { state: 'failed' },
      b: { state: 'done' },
    });
    const log = vi.fn();
    const stuck = releases([{ a: 'planning', b: 'done' }]);
    await waitForOutputs(stuck, ['a', 'b'], 0, log, 0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not ready yet/));
  });
});
