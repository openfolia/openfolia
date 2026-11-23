import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HERO_BED, soundPlan } from '@/scripts/demo/assemble.mjs';
import { captionCues, checkCaptions } from '@/scripts/demo/captions.mjs';
import { readNarration } from '@/scripts/demo/narration.mjs';
import {
  ASSISTANT_ASK,
  askAssistant,
  assistantLayer,
  markedText,
  outletsLayer,
  staticFile,
  toolCallText,
} from '@/scripts/demo/outlets.mjs';
import {
  editedTail,
  FRENCH_STEP,
  HERO_EDIT,
  HERO_PARTS,
  HERO_SHOTS,
  PORTAL_SEARCH,
  translatedXliff,
} from '@/scripts/demo/scenes/hero.mjs';

/** The hero's story (#804): its parts, captions, the portal, the assistant and the bed. */
const captionsFile = join(
  import.meta.dirname,
  '..',
  'demo',
  'captions',
  'hero.json',
);
const captions = JSON.parse(readFileSync(captionsFile, 'utf8')) as Record<
  string,
  { en: string; de: string }
>;

describe('the hero’s story', () => {
  it('films every shot once, in the narration’s order, across its parts', () => {
    const filmed = HERO_PARTS.flatMap((part) => part.shots);
    expect(filmed).toEqual(Object.keys(HERO_SHOTS));
    for (const lang of ['en', 'de']) {
      expect(readNarration('hero', lang).map((shot) => shot.id)).toEqual(
        filmed,
      );
    }
  });

  it('opens and closes on the reader portal', () => {
    expect(HERO_PARTS[0]).toMatchObject({ portal: true });
    expect(HERO_PARTS.at(-1)).toMatchObject({ portal: true });
    expect(HERO_PARTS.filter((part) => part.portal)).toHaveLength(2);
  });

  it('has six captions, each a signpost that fits and spans its shots', () => {
    checkCaptions(captions, 'hero.json');
    expect(Object.keys(captions)).toEqual([
      '01a',
      '02a',
      '02b',
      '03a',
      '04a',
      '06a',
    ]);
    for (const texts of Object.values(captions)) {
      for (const text of [texts.en, texts.de]) {
        expect(text.length).toBeLessThanOrEqual(60);
        expect(text).not.toMatch(/\.$/);
      }
    }
    // Every shot two seconds long: each caption runs to the next one's shot.
    const shots = Object.keys(HERO_SHOTS).map((id, i) => ({
      id,
      start: i * 2000,
      end: (i + 1) * 2000,
    }));
    const cues = captionCues(shots, captions, 'de');
    expect(cues.map((cue) => [cue.shot, cue.start, cue.end])).toEqual([
      ['01a', 0, 6],
      ['02a', 6, 8],
      ['02b', 8, 12],
      ['03a', 12, 22],
      ['04a', 22, 28],
      ['06a', 28, 36],
    ]);
  });

  it('checks the saved step for the new words in their place', () => {
    expect(editedTail(HERO_EDIT.en)).toBe('s crosswise to 120 Nm.');
    expect(editedTail(HERO_EDIT.de)).toBe('über Kreuz mit 120 Nm fest.');
    for (const edit of Object.values(HERO_EDIT)) {
      const at = edit.before.length - edit.back;
      expect(
        edit.before.slice(0, at) + edit.typed + edit.before.slice(at),
      ).toBe(edit.after);
    }
  });

  it('types the same words into the portal both times', () => {
    for (const lang of ['en', 'de'] as const) {
      expect(PORTAL_SEARCH[lang].query).toBeTruthy();
      expect(PORTAL_SEARCH[lang].result).toBeTruthy();
    }
  });
});

describe('the French coming back', () => {
  const job = `<xliff version="2.0" srcLang="en" trgLang="fr">
  <file id="changing-a-wheel">
    <unit id="step-lower">
      <segment id="content">
        <source>Lower the vehicle &amp; tighten the bolts to 120 Nm.</source>
      </segment>
    </unit>
  </file>
</xliff>`;

  it('puts the translation into the job’s one unit, escaped', () => {
    const out = translatedXliff(job, 'A < B & "C"');
    expect(out).toContain(
      '</source>\n      <target>A &lt; B &amp; &quot;C&quot;</target>\n      </segment>',
    );
    expect(translatedXliff(job, FRENCH_STEP)).toContain('120 Nm');
  });

  it('refuses a job that does not hold exactly the one unit', () => {
    expect(() => translatedXliff('<xliff/>', 'x')).toThrow(/0 units/);
    expect(() =>
      translatedXliff(job.replace('</file>', '</file>' + job), 'x'),
    ).toThrow(/2 units/);
  });
});

describe('the portal’s files', () => {
  const root = '/srv/portal';

  it('serves a folder by its index and nothing outside the site', () => {
    expect(staticFile(root, '/en/../en/search/?q=a')).toBe(
      '/srv/portal/en/search/',
    );
    // An encoded slash survives the URL's own clean-up: decoded, it climbs out.
    expect(staticFile(root, '/%2E%2E%2Fsecret')).toBeNull();
    expect(staticFile(root, '/../etc/passwd')).toBe('/srv/portal/etc/passwd');
    expect(staticFile(root, '/%E0%A4%A')).toBeNull();
  });
});

describe('the assistant layer', () => {
  const found = {
    total: 1,
    title: 'Changing <a> wheel',
    excerpt:
      'Lower the vehicle and tighten the wheel bolts crosswise to 120 Nm.',
    moduleId: 'changing-a-wheel',
    blockId: 'step-lower',
    release: '1.2',
  };
  const call = {
    tool: 'search',
    args: {
      query: 'tighten wheel bolts',
      lang: 'en',
      ref: 'release/fenna/1.2',
    },
  };

  it('writes the tool call as the assistant sent it', () => {
    expect(toolCallText(call.tool, call.args)).toBe(
      'search({ query: "tighten wheel bolts", lang: "en", ref: "release/fenna/1.2" })',
    );
  });

  it('marks the new words only where the passage has them', () => {
    expect(markedText('to 120 Nm.', '120 Nm')).toMatch(
      /^to <span style="[^"]*demo-mark-in[^"]*">120 Nm<\/span>\.$/,
    );
    expect(markedText('crosswise.', '120 Nm')).toBe('crosswise.');
    expect(markedText('a <b>', null)).toBe('a &lt;b&gt;');
  });

  it('shows the server’s answer as plain text, with its release', () => {
    const layer = assistantLayer(found, { lang: 'en', call, phrase: '120 Nm' });
    expect(layer).toContain('Changing &lt;a&gt; wheel');
    expect(layer).not.toContain('<a>');
    expect(layer).toContain(ASSISTANT_ASK.en.question);
    expect(layer).toContain('Release 1.2');
    expect(layer).toContain('&quot;release/fenna/1.2&quot;');
    const german = assistantLayer(found, { lang: 'de', call, phrase: null });
    expect(german).toContain('Veröffentlichung 1.2');
    expect(german).toContain(ASSISTANT_ASK.de.question);
  });

  it('asks at the release’s tag and answers with its first module', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const answer = await askAssistant(
      async (tool: string, args: Record<string, unknown>) => {
        calls.push([tool, args]);
        if (tool === 'list_releases') {
          return {
            releases: [
              { revision: '1.2', tag: 'release/fenna/1.2' },
              { revision: '1.1', tag: 'release/fenna/1.1' },
            ],
          };
        }
        return {
          total: 2,
          results: [
            { resourceType: 'Term', id: 'wheel-bolt', title: 'wheel bolt' },
            {
              resourceType: 'Module',
              id: 'changing-a-wheel',
              title: 'Changing a wheel',
              excerpt: 'Lower the vehicle…',
              blockId: 'step-lower',
            },
          ],
        };
      },
      { lang: 'en', revision: '1.1' },
    );
    expect(calls[1]).toEqual([
      'search',
      { query: ASSISTANT_ASK.en.query, lang: 'en', ref: 'release/fenna/1.1' },
    ]);
    expect(answer.found).toMatchObject({
      total: 2,
      moduleId: 'changing-a-wheel',
      release: '1.1',
    });
    await expect(
      askAssistant(async () => ({ releases: [] }), {
        lang: 'en',
        revision: '9.9',
      }),
    ).rejects.toThrow(/no release 9.9/);
  });

  it('puts the three outlets side by side', () => {
    const tile = {
      label: 'x',
      lang: 'en',
      picture: 'data:image/png;base64,AA==',
      pageWidth: 595,
      crop: { x: 54, y: 400, width: 487, height: 96 },
      box: { x0: 359, y0: 463, x1: 398, y1: 476 },
    };
    const layer = outletsLayer({
      pictures: {
        pdf: tile,
        portal: { src: 'data:image/png;base64,AA==', width: 700, height: 80 },
      },
      found,
      lang: 'de',
      phrase: '120 Nm',
    });
    expect(layer).toContain('Leserportal');
    expect(layer).toContain('KI-Assistent');
    expect(layer.match(/demo-mark-in 520ms/g)).toHaveLength(2);
  });
});

describe('the hero’s bed', () => {
  const film = { sceneStart: 7.1, endStart: 90.0, total: 96.6 };

  it('comes in under the sting’s fade and leaves before the end card', () => {
    const plan = soundPlan({
      ...film,
      voices: [{ file: 'a.mp3', at: 7.55 }],
      bed: { file: 'bed.mp3', gain: -3.5, spans: [{ from: 7.55, to: 10 }] },
    }) as NonNullable<ReturnType<typeof soundPlan>>;
    expect(plan.inputs).toEqual([
      ...['-i', 'a.mp3'],
      ...['-stream_loop', '-1', '-i', 'bed.mp3'],
    ]);
    const from = film.sceneStart - HERO_BED.lead;
    const length = film.endStart + 0.3 - from;
    expect(plan.filter).toContain(`atrim=0:${length.toFixed(3)}`);
    expect(plan.filter).toContain('volume=-3.5dB');
    expect(plan.filter).toContain(
      `afade=t=out:st=${(length - HERO_BED.fadeOut).toFixed(3)}:d=${HERO_BED.fadeOut}`,
    );
    const ms = Math.round(from * 1000);
    expect(plan.filter).toContain(`adelay=${ms}|${ms}[bed]`);
    // The line's dip, on the bed's own clock.
    expect(plan.filter).toContain(`t-${(7.55 - from).toFixed(3)}`);
    expect(plan.filter).toMatch(/\[v0\]\[bed\]amix=inputs=2/);
  });

  it('levels the voice as the tab videos do, one gain for every line', () => {
    const plan = soundPlan({
      ...film,
      voices: [
        { file: 'a.mp3', at: 7.55 },
        { file: 'b.mp3', at: 12 },
      ],
      voiceGain: -3.6,
    }) as NonNullable<ReturnType<typeof soundPlan>>;
    expect(plan.filter.match(/volume=-3\.6dB,adelay/g)).toHaveLength(2);
  });
});
