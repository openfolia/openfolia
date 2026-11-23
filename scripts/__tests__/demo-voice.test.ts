import { describe, expect, it } from 'vitest';
import {
  LEAD_MS,
  narrationPlan,
  SENTENCE_PAUSE_MS,
  sentenceBreaks,
  TAIL_MS,
  WORDS_PER_SECOND,
  withPauses,
} from '@/scripts/demo/narration.mjs';
import { voiceRequests } from '@/scripts/demo/voice.mjs';

/** A pause between two sentences in one voice line (#805). */
describe('the pause between two sentences', () => {
  const tag = `<break time="${SENTENCE_PAUSE_MS / 1000}s" />`;
  const count = (text: string) => text.split('<break').length - 1;

  it('puts exactly one break between two sentences in a line', () => {
    expect(withPauses('Jonas gibt frei. Jedes Wort gelesen.')).toBe(
      `Jonas gibt frei. ${tag} Jedes Wort gelesen.`,
    );
    expect(withPauses('Ready? Then go! Now.')).toBe(
      `Ready? ${tag} Then go! ${tag} Now.`,
    );
    // Closed by a quote or a bracket, or with two marks: still one break, after the quote.
    expect(withPauses('Er sagt „Ja.“ Dann geht es weiter.')).toBe(
      `Er sagt „Ja.“ ${tag} Dann geht es weiter.`,
    );
    expect(withPauses('"Why?" Then go.')).toBe(`"Why?" ${tag} Then go.`);
    expect(withPauses('Ready?! Go.')).toBe(`Ready?! ${tag} Go.`);
    expect(withPauses('It loads in 50 ms. Fast.')).toBe(
      `It loads in 50 ms. ${tag} Fast.`,
    );
    expect(withPauses('Das ist Version 1.2. Weiter.')).toBe(
      `Das ist Version 1.2. ${tag} Weiter.`,
    );
  });

  it('adds none at the end of a line, after "…" or after an abbreviation', () => {
    for (const text of [
      'Jonas reads every edit…',
      'Before it goes out, Jonas reads every edit… Then side by side.',
      'Und dann... Weiter.',
      'Etwa z. B. Schrauben, d. h. Muttern.',
      'Zum Beispiel z. B. Rad und Reifen.',
      'Some, e.g. Bolts and nuts.',
      'Siehe Nr. 4 und vgl. Abschnitt 2.',
      'Am 3. Mai kommt die 2. Ausgabe.',
      'Ready? then go.',
      'Release 1.2 is out.',
      'Every check passes, and 1.2 is out.',
    ]) {
      expect(withPauses(text), text).toBe(text);
      expect(sentenceBreaks(text), text).toEqual([]);
    }
  });

  it('sends the pauses only in the line, never in previous_text or next_text', () => {
    const shots = [
      { id: '01a', text: 'One step. A question.', words: 4 },
      { id: '01b', text: 'Jonas approves. Every word read.', words: 5 },
      { id: '02a', text: 'Done. Nothing left.', words: 3 },
    ];
    const [first, second, third] = voiceRequests(shots);
    expect(count(first.text)).toBe(1);
    expect(second).toEqual({
      id: '01b',
      text: `Jonas approves. ${tag} Every word read.`,
      previous: 'One step. A question.',
      next: 'Done. Nothing left.',
    });
    expect(third.previous).toBe('Jonas approves. Every word read.');
  });

  it('grows the estimate by the pause per break', () => {
    const plan = narrationPlan('review', 'de', { dir: '/nonexistent' });
    for (const shot of plan.shots) {
      const breaks = sentenceBreaks(shot.text).length;
      expect(shot.spokenMs).toBe(
        Math.round(
          (shot.words / WORDS_PER_SECOND.de) * 1000 +
            breaks * SENTENCE_PAUSE_MS,
        ),
      );
      expect(shot.ms).toBe(shot.spokenMs + LEAD_MS + TAIL_MS);
    }
    // A fixed number: 03a, nine words and one pause.
    const approve = plan.shots.find((shot) => shot.id === '03a');
    expect(approve?.words).toBe(9);
    expect(approve?.spokenMs).toBe(Math.round((9 / 2.3) * 1000 + 450));
    // Not vacuous: the German Review video has a line with two sentences.
    expect(
      plan.shots.some((shot) => sentenceBreaks(shot.text).length > 0),
    ).toBe(true);
  });
});
