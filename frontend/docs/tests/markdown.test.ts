import {
  breakableCode,
  cell,
  code,
  mdx,
  table,
} from '../scripts/lib/markdown.mjs';

describe('mdx', () => {
  it('turns what MDX would read as JSX or an expression into text, outside code spans', () => {
    expect(mdx('a <b> {c} \\d')).toBe('a &lt;b&gt; &#123;c&#125; &#92;d');
    expect(mdx('keep `<x>{y}` as code')).toBe('keep `<x>{y}` as code');
  });

  it('keeps a line starting with import or export text, not an ES module', () => {
    expect(mdx('Reads it.\nimport x from "y"\n  export the file')).toBe(
      'Reads it.\n&#105;mport x from "y"\n  &#101;xport the file',
    );
    expect(mdx('important, exports')).toBe('important, exports');
  });

  it('holds after a bare URL, whose autolink would take a backslash escape', () => {
    expect(mdx('http://127.0.0.1:<PORT>')).toBe(
      'http://127.0.0.1:&lt;PORT&gt;',
    );
  });
});

describe('cell', () => {
  it('keeps a table cell on one line, its pipes escaped in code spans too', () => {
    expect(cell('a | b\n  c `x | y`')).toBe('a \\| b c `x \\| y`');
  });
});

describe('code', () => {
  it('fences a value holding backticks with longer ones', () => {
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`a')).toBe('`` `a ``');
  });
});

describe('table', () => {
  it('writes a GFM table', () => {
    expect(table(['A', 'B'], [['1', '2']])).toBe(
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
    );
  });
});

describe('breakableCode', () => {
  it('lets a name break only between its parts', () => {
    expect(breakableCode('moduleTypes[].labels.<key>')).toBe(
      '<code>moduleTypes[]<wbr />.<wbr />labels.<wbr />&lt;key&gt;</code>',
    );
    expect(breakableCode('CCMS_AUTH_MODE')).toBe(
      '<code>CCMS_<wbr />AUTH_<wbr />MODE</code>',
    );
    expect(breakableCode('a{b}&c')).toBe('<code>a&#123;b&#125;&amp;c</code>');
    expect(breakableCode('a|b*c`d\\e')).toBe(
      '<code>a&#124;b&#42;c&#96;d&#92;e</code>',
    );
  });
});
