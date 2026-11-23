import { highlightCode, languageOf, type CodeToken } from './code-highlight';

const kinds = (line: CodeToken[] | undefined) =>
  (line ?? []).filter((t) => t.kind !== 'text').map((t) => [t.kind, t.text]);

describe('languageOf', () => {
  it('tells the language by the extension', () => {
    expect(languageOf('manual.typ')).toBe('typst');
    expect(languageOf('parts/Notice.TYP')).toBe('typst');
    expect(languageOf('data.yml')).toBe('yaml');
    expect(languageOf('data.yaml')).toBe('yaml');
    expect(languageOf('data.json')).toBe('json');
    expect(languageOf('logo.svg')).toBe('xml');
    expect(languageOf('notes.txt')).toBe('plain');
    expect(languageOf('README')).toBe('plain');
  });
});

describe('highlightCode', () => {
  it('keeps every character, line by line', () => {
    const text = '#let x = "a\\"b" // c\n\n= Title\n/* open\nstill */ #set\n';
    const lines = highlightCode(text, 'typst');
    expect(lines.map((l) => l.map((t) => t.text).join(''))).toEqual(
      text.split('\n'),
    );
    expect(lines[1]).toEqual([]);
  });

  it('colours Typst: keywords, functions, strings, numbers, comments and headings', () => {
    const [code, call, heading] = highlightCode(
      '#let size = 12pt // body\ntext(fill: red)[x] #image("a.svg")\n== Notes',
      'typst',
    );
    expect(kinds(code)).toEqual([
      ['keyword', '#let'],
      ['number', '12pt'],
      ['comment', '// body'],
    ]);
    expect(kinds(call)).toEqual([
      ['function', 'text'],
      ['function', '#image'],
      ['string', '"a.svg"'],
    ]);
    expect(kinds(heading)).toEqual([['heading', '== Notes']]);
  });

  it('carries a block comment and a raw block over lines', () => {
    const lines = highlightCode('/* a\nb */ #let\n```\nraw #let\n```', 'typst');
    expect(kinds(lines[0])).toEqual([['comment', '/* a']]);
    expect(kinds(lines[1])).toEqual([
      ['comment', 'b */'],
      ['keyword', '#let'],
    ]);
    expect(kinds(lines[3])).toEqual([['string', 'raw #let']]);
  });

  it('colours YAML keys, values and comments', () => {
    const [entry, item] = highlightCode(
      'name: "Classic" # the name\n- size: 12',
      'yaml',
    );
    expect(kinds(entry)).toEqual([
      ['key', 'name'],
      ['string', '"Classic"'],
      ['comment', '# the name'],
    ]);
    expect(kinds(item)).toEqual([
      ['key', 'size'],
      ['number', '12'],
    ]);
  });

  it('colours JSON keys apart from string values', () => {
    expect(
      kinds(highlightCode('{"a": "b", "n": 2, "t": true}', 'json')[0]),
    ).toEqual([
      ['key', '"a"'],
      ['string', '"b"'],
      ['key', '"n"'],
      ['number', '2'],
      ['key', '"t"'],
      ['keyword', 'true'],
    ]);
  });

  it('colours XML tags, attributes and comments', () => {
    expect(
      kinds(highlightCode('<svg width="2"><!-- c --></svg>', 'xml')[0]),
    ).toEqual([
      ['tag', '<svg'],
      ['key', 'width'],
      ['string', '"2"'],
      ['tag', '>'],
      ['comment', '<!-- c -->'],
      ['tag', '</svg>'],
    ]);
  });

  it('leaves plain text as it is', () => {
    expect(highlightCode('#let x', 'plain')).toEqual([
      [{ kind: 'text', text: '#let x' }],
    ]);
  });
});
