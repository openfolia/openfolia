import {
  matchSnippet,
  restAfter,
  type SnippetSuggestion,
} from './snippet-match';

const gloves: SnippetSuggestion = {
  id: 'wear-gloves',
  title: 'Wear gloves',
  text: 'Wear protective gloves when you touch the battery terminals.',
};
const wearShoes: SnippetSuggestion = {
  id: 'wear-shoes',
  title: 'Wear shoes',
  text: 'Wear protective shoes.',
};
const german: SnippetSuggestion = {
  id: 'heat',
  title: 'Hitze',
  text: 'Äußerst heiße Oberfläche.',
};

describe('matchSnippet', () => {
  it('suggests the rest once the first words match the start of a snippet', () => {
    expect(matchSnippet('Wear protective g', [wearShoes, gloves])).toEqual({
      snippet: gloves,
      rest: 'loves when you touch the battery terminals.',
    });
    expect(matchSnippet('wear protective ', [wearShoes, gloves])).toEqual({
      snippet: wearShoes,
      rest: 'shoes.',
    });
  });

  it('waits for two words and a few characters', () => {
    expect(matchSnippet('Wear', [gloves])).toBeNull();
    expect(matchSnippet('Wear ', [gloves])).toBeNull();
    expect(matchSnippet('Wear p', [gloves])).toEqual(
      expect.objectContaining({ snippet: gloves }),
    );
    expect(matchSnippet('   ', [gloves])).toBeNull();
  });

  it('folds as search folds: case, diacritics, ß and white space', () => {
    expect(matchSnippet('ausserst  HEISSE ob', [german])).toEqual({
      snippet: german,
      rest: 'erfläche.',
    });
    expect(matchSnippet('  WEAR   Protective', [gloves])?.rest).toBe(
      ' gloves when you touch the battery terminals.',
    );
  });

  it('matches nothing that differs, or goes past the text', () => {
    expect(matchSnippet('Wear safety gloves', [gloves])).toBeNull();
    expect(matchSnippet('Wear protective shoes. And more', [wearShoes])).toBe(
      null,
    );
    expect(matchSnippet('Wear protective', [])).toBeNull();
  });

  it('still matches a snippet typed out in full, with nothing left', () => {
    expect(matchSnippet('Wear protective shoes.', [wearShoes])?.rest).toBe('');
    expect(matchSnippet('Wear protective shoes. ', [wearShoes])?.rest).toBe('');
  });
});

describe('restAfter', () => {
  it('keeps the snippet’s own spelling in the rest', () => {
    expect(restAfter('Straße frei halten.', 'strass')).toBe('e frei halten.');
    expect(restAfter('Ab  c', 'ab c')).toBe('');
    expect(restAfter('Text', 'other')).toBeNull();
  });
});
