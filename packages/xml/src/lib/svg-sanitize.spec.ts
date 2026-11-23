import { readXml, XmlReadError, type XmlElement } from './xml-read.js';
import { sanitizeSvg, SVG_NAMESPACE } from './svg-sanitize.js';

const svg = (body: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${attrs}>${body}</svg>`;

/** Every element and attribute of a sanitised SVG, read back. */
function parts(text: string): { elements: string[]; attributes: string[] } {
  const elements: string[] = [];
  const attributes: string[] = [];
  const walk = (e: XmlElement) => {
    elements.push(e.local);
    for (const [k, v] of e.attributes) attributes.push(`${k}=${v}`);
    for (const c of e.children) if (typeof c !== 'string') walk(c);
  };
  walk(readXml(text));
  return { elements, attributes };
}

describe('sanitizeSvg', () => {
  it('keeps a drawing as it is: shapes, gradients, local references, text', () => {
    const out = sanitizeSvg(
      svg(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
          '<title>Warning &amp; sign</title>' +
          '<path d="M0 0L10 10" fill="url(#g)" style="stroke: black; stroke-width: 2"/>' +
          '<use xlink:href="#g" x="1"/><text x="1" y="2">5 &lt; 6</text>',
        ' viewBox="0 0 10 10" width="10"',
      ),
    );
    const read = readXml(out);
    expect(read.ns).toBe(SVG_NAMESPACE);
    expect(parts(out).elements).toEqual([
      'svg',
      'defs',
      'linearGradient',
      'stop',
      'title',
      'path',
      'use',
      'text',
    ]);
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('href="#g"');
    expect(out).toContain('style="stroke: black; stroke-width: 2"');
    expect(out).toContain('Warning &amp; sign');
    expect(out).toContain('5 &lt; 6');
  });

  it('leaves out every script, handler, foreign object, style sheet, animation and link out', () => {
    const hostile = svg(
      '<script>alert(1)</script>' +
        '<script xlink:href="https://example.com/x.js"/>' +
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(2)</script><iframe src="https://example.com"/></body></foreignObject>' +
        '<style>@import url(https://example.com/x.css); rect { fill: url(https://example.com/t) }</style>' +
        '<a href="javascript:alert(3)"><rect width="1" height="1"/></a>' +
        '<a xlink:href="https://example.com"><circle r="1"/></a>' +
        '<image href="https://example.com/beacon.png"/>' +
        '<filter id="f"><feImage href="https://example.com/i.png"/></filter>' +
        '<set attributeName="href" to="javascript:alert(4)"/>' +
        '<animate attributeName="onload" values="alert(5)"/>' +
        '<rect onclick="alert(6)" ONLOAD="alert(7)" width="2" height="2" fill="url(https://example.com/f)" stroke="url(&quot;#ok&quot;)"/>' +
        '<use href="https://example.com/sprite.svg#a"/>' +
        '<use xlink:href="data:image/svg+xml;base64,PHN2Zy8+"/>' +
        '<path d="M0 0" style="background: url(javascript:alert(8))"/>' +
        '<path d="M0 0" style="fill: \\75 rl(https://example.com)"/>' +
        '<g><circle r="2" mask="url( https://example.com/m )"/></g>',
      ' onload="alert(9)"',
    );
    const out = sanitizeSvg(hostile);
    const { elements, attributes } = parts(out);
    for (const e of elements) {
      expect(['svg', 'rect', 'circle', 'filter', 'use', 'path', 'g']).toContain(
        e,
      );
    }
    expect(elements).not.toContain('script');
    for (const a of attributes) {
      expect(a).not.toMatch(/^on/i);
      expect(a).not.toMatch(/javascript|example\.com|data:|\\/i);
    }
    expect(out).not.toMatch(
      /alert|example\.com|javascript|<script|foreignObject/i,
    );
    expect(attributes).toContain('stroke=url("#ok")');
  });

  it("keeps a safe style sheet, a link's shapes, and reads past the SVG 1.1 DOCTYPE", () => {
    const out = sanitizeSvg(
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
        svg(
          '<style>.st0{fill:#E30613} g > .st1{fill:url(#g)}</style><rect class="st0" width="1" height="1"/>' +
            '<a href="https://example.com"><circle class="st1" r="1"/></a>',
        ),
    );
    expect(out).toContain(
      '<style>.st0{fill:#E30613} g &gt; .st1{fill:url(#g)}</style>',
    );
    expect(out).toContain('<g><circle class="st1" r="1"></circle></g>');
    expect(out).not.toMatch(/example\.com|DOCTYPE/);
    for (const sheet of [
      '@import url(https://example.com/x.css);',
      '.a{fill:url(https://example.com/f)}',
      '.a{background:image-set("x.png" 1x)}',
      '.a{fill:\\75 rl(x)}',
      ".a{mask-image:-webkit-image-set('//host/a' 1x)}",
      '.a{background:cross-fade("//host/a", red)}',
    ]) {
      expect(sanitizeSvg(svg(`<style>${sheet}</style>`))).not.toContain(
        '<style',
      );
    }
  });

  it('leaves out any value that loads from a string, and keeps one href', () => {
    const out = sanitizeSvg(
      svg(
        `<rect width="1" style="background-image:image-set('//attacker.example/x.png' 1x)" mask="image-set('//h/b' 1x)" filter="url(//h/f)"/>` +
          '<use xlink:href="#a" href="#b"/><use href=" #a"/>',
        ` style="mask-image:image-set(&quot;//h/a&quot; 1x)"`,
      ),
    );
    expect(out).not.toMatch(/image-set|\/\/h|attacker|style|mask=|filter=/);
    expect(out).toContain('<use href="#a"></use><use></use>');
    expect(() => readXml(out)).not.toThrow();
  });

  it('keeps a sheet with quoted font names and comments, and linked text as text', () => {
    const out = sanitizeSvg(
      svg(
        `<style>/* don't */ .st1{font-family:'ArialMT', "Open Sans";} .st0{fill:#E30613;}</style>` +
          '<text class="st1"><a href="https://example.com"><tspan>hi</tspan></a></text>',
      ),
    );
    expect(out).toContain(`.st0{fill:#E30613;}`);
    expect(out).toContain(`font-family:'ArialMT', "Open Sans";`);
    expect(out).toContain('<text class="st1"><tspan>hi</tspan></text>');
    for (const sheet of [
      `.a{background:image-set('x.png' 1x)}`,
      `.a{background:url('//h/x')}`,
      `.a{font-family:'a/b'}`,
    ]) {
      expect(sanitizeSvg(svg(`<style>${sheet}</style>`))).not.toContain(
        '<style',
      );
    }
  });

  it('reads strings and comments as CSS does: neither hides a load in the other', () => {
    for (const value of [
      'a: "/*"; background: url(http://x) /* "*/',
      "/* ' */ background:url(//x) /* ' */",
      'background: u\\72l(http://x)',
      "a: '/*'; fill: url(https://x) /* '*/",
      'fill: red /* unterminated',
      'font-family: "Arial',
      ".a{font-family:'/*'}.b{background:url(https://evil.example/b)}.c{font-family:'*/'}",
      '.a{font-family:"/*"} @import url(https://evil.example/x.css); .c{font-family:"*/"}',
      "font-family:'/*';fill:url(https://evil.example/p.svg#g);x:'*/'",
      'mask:url(/*/../../../tmp/x.svg?*/#m)',
      'mask:url(/*/..//attacker.example/share/x.svg?*/#m)',
      'fill: url(#a',
      'fill: url(\u00a0#a)',
    ]) {
      expect(
        sanitizeSvg(
          svg(
            `<style>${value}</style><rect style="${value.replace(/"/g, '&quot;')}"/>`,
          ),
        ),
        value,
      ).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect></rect></svg>');
    }
  });

  it('refuses a DTD and its entities, and what is no SVG', () => {
    expect(() =>
      sanitizeSvg(
        '<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
      ),
    ).toThrow(XmlReadError);
    expect(() => sanitizeSvg('<html><script>alert(1)</script></html>')).toThrow(
      TypeError,
    );
    expect(() => sanitizeSvg('<svg><script>alert(1)</script></svg>')).toThrow(
      TypeError,
    );
    expect(() => sanitizeSvg('not xml')).toThrow(XmlReadError);
  });
});
