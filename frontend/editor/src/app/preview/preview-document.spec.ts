import {
  isSymbolUrl,
  previewDocument,
  previewImageUrls,
  previewPolicy,
} from './preview-document';

const HASH = 'a'.repeat(64);
const origin = {
  pageUrl: 'https://editor.example/api/modules/en/charging/preview',
  apiRoot: 'https://editor.example/api',
};

/** A page as the API writes it, with `body` inside. */
const page = (body: string, head = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Charging</title>
<link rel="stylesheet" href="../../../preview/theme.css">
<link rel="stylesheet" href="../../../preview/theme-dark.css" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="../../../preview/render-html.css">
${head}
</head>
<body>${body}</body>
</html>`;

const parse = (html: string) =>
  new DOMParser().parseFromString(html, 'text/html');

describe('previewImageUrls', () => {
  it('lists the API’s own asset URLs, absolute, each once, with their ref', () => {
    const html = page(
      `<img src="../../../assets/${HASH}?ref=change-sets%2Fx"><img src="../../../assets/${HASH}?ref=change-sets%2Fx">` +
        `<img src="https://elsewhere.example/assets/${HASH}"><img src="../../../assets/not-a-hash"><img src="/other/${HASH}">`,
    );
    expect(previewImageUrls(html, origin)).toEqual([
      `https://editor.example/api/assets/${HASH}?ref=change-sets%2Fx`,
    ]);
  });

  it('takes an image uploaded into a change set, without any query, and nothing else under it', () => {
    const cs = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const html = page(
      `<img src="../../../change-sets/${cs}/assets/${HASH}?ref=x">` +
        `<img src="../../../change-sets/${cs}/modules/en/x/working-copy">` +
        `<img src="../../../change-sets/not-an-id/assets/${HASH}">` +
        `<img src="../../../change-sets/${cs}/assets/../../../users">`,
    );
    expect(previewImageUrls(html, origin)).toEqual([
      `https://editor.example/api/change-sets/${cs}/assets/${HASH}`,
    ]);
  });
});

describe('safety symbols in the preview', () => {
  it('reads a symbol’s artwork at the page’s ref, and nothing else under the route', () => {
    const html = page(
      '<img class="of-safety__symbol" src="../../../symbols/w001?ref=main" alt="General warning">' +
        '<img src="../../../symbols/w001?ref=main">' +
        '<img src="../../../symbols/Bad_Id">' +
        '<img src="../../../symbols/w001/../../users">' +
        '<img src="../../../symbols/w002">',
    );
    const urls = previewImageUrls(html, origin);
    expect(urls).toEqual([
      'https://editor.example/api/symbols/w001?ref=main',
      'https://editor.example/api/symbols/w002',
    ]);
    expect(urls.map((u) => isSymbolUrl(u, origin.apiRoot))).toEqual([
      true,
      true,
    ]);
    expect(
      isSymbolUrl(`https://editor.example/api/assets/${HASH}`, origin.apiRoot),
    ).toBe(false);
  });

  it('shows the artwork from the bytes read, its label as the text alternative', () => {
    const html = previewDocument(
      page(
        '<div class="of-safety__symbols"><img class="of-safety__symbol" src="../../../symbols/w001?ref=main" alt="General warning"></div>',
      ),
      origin,
      {
        dark: false,
        images: new Map([
          ['https://editor.example/api/symbols/w001?ref=main', 'blob:png'],
        ]),
      },
    );
    const img = parse(html).querySelector('img.of-safety__symbol');
    expect(img?.getAttribute('src')).toBe('blob:png');
    expect(img?.getAttribute('alt')).toBe('General warning');
  });
});

describe('previewDocument', () => {
  it('keeps the page’s direction, only ltr or rtl (#458)', () => {
    const at = (dir: string) =>
      parse(
        previewDocument(
          page('<article class="of-content">نص</article>').replace(
            '<html lang="en">',
            `<html lang="ar" dir="${dir}">`,
          ),
          origin,
          { dark: false, images: new Map() },
        ),
      ).documentElement;
    expect(at('rtl').getAttribute('dir')).toBe('rtl');
    expect(at('rtl').getAttribute('lang')).toBe('ar');
    expect(at('ltr').getAttribute('dir')).toBe('ltr');
    expect(at('auto').hasAttribute('dir')).toBe(false);
    expect(at('rtl" onload="x').hasAttribute('onload')).toBe(false);
  });

  it('keeps the content, the language and the API’s stylesheets, under a strict policy', () => {
    const html = previewDocument(
      page(
        `<article class="of-content of-module" id="of-charging"><h1>Charging</h1><img class="of-figure__image" alt="Charger" style="width:50%" src="../../../assets/${HASH}"></article>`,
      ),
      origin,
      {
        dark: true,
        images: new Map([
          [`https://editor.example/api/assets/${HASH}`, 'blob:x/1'],
        ]),
      },
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const doc = parse(html);
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
    expect(doc.documentElement.classList.contains('dark')).toBe(true);
    expect(
      [...doc.querySelectorAll('link')].map((l) => l.getAttribute('href')),
    ).toEqual([
      'https://editor.example/api/preview/theme.css',
      'https://editor.example/api/preview/render-html.css',
    ]);
    expect(
      doc
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content'),
    ).toBe(previewPolicy('https://editor.example'));
    const img = doc.querySelector('img');
    expect(img?.getAttribute('src')).toBe('blob:x/1');
    expect(img?.getAttribute('style')).toBe('width:50%');
    expect(doc.getElementById('of-charging')?.className).toBe(
      'of-content of-module',
    );
    expect(doc.querySelector('title')).toBeNull();
  });

  it('leaves out an image it was given no bytes for', () => {
    const doc = parse(
      previewDocument(
        page(`<img alt="x" src="../../../assets/${HASH}">`),
        origin,
        {
          dark: false,
          images: new Map(),
        },
      ),
    );
    expect(doc.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(doc.documentElement.classList.contains('dark')).toBe(false);
  });

  it('drops anything that could run, load or submit, whatever the page holds', () => {
    const hostile = page(
      `<script>alert(1)</script>
       <p onclick="alert(1)" id="p">Text <a href="javascript:alert(1)">bad</a>
         <a href="#of-x">here</a> <a href="https://example.org/" target="_top">out</a>
         <a href=" java\tscript:alert(1)">tab</a> <a href="data:text/html,x">data</a></p>
       <iframe src="https://evil.example/"></iframe>
       <object data="x"></object><embed src="x">
       <form action="https://evil.example/"><input name="q"><button>Go</button></form>
       <base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">
       <style>body{background:url(https://evil.example/)}</style>
       <link rel="stylesheet" href="https://evil.example/x.css">
       <img src="https://evil.example/x.png" srcset="https://evil.example/y.png 2x" onerror="alert(1)">
       <svg><a xlink:href="javascript:alert(1)"><text>svg</text></a><use href="#x"/><image href="https://evil.example/i.png"/></svg>
       <video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video>
       <template><script>alert(1)</script></template>`,
      `<script>alert(2)</script><link rel="stylesheet" href="https://evil.example/head.css"><link rel="stylesheet" href="../../../preview/render-html.css?x=1"><base href="https://evil.example/">`,
    );
    const html = previewDocument(hostile, origin, {
      dark: false,
      images: new Map(),
    });
    const doc = parse(html);
    for (const selector of [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'base',
      'style',
      'video',
      'template',
      'use',
      'image',
    ]) {
      expect([selector, doc.querySelectorAll(selector).length]).toEqual([
        selector,
        0,
      ]);
    }
    // Only the policy, the referrer, the charset and the colour scheme.
    expect(
      [...doc.querySelectorAll('meta')].map(
        (m) =>
          m.getAttribute('http-equiv') ?? m.getAttribute('name') ?? 'charset',
      ),
    ).toEqual([
      'charset',
      'Content-Security-Policy',
      'referrer',
      'color-scheme',
    ]);
    expect(
      [...doc.querySelectorAll('link')].map((l) => l.getAttribute('href')),
    ).toEqual([
      'https://editor.example/api/preview/theme.css',
      'https://editor.example/api/preview/render-html.css',
    ]);
    for (const element of doc.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.name.includes(':')).toBe(false);
        expect(['srcset', 'poster', 'action', 'data']).not.toContain(
          attribute.name,
        );
      }
    }
    expect(
      [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    ).toEqual([null, '#of-x', 'https://example.org/', null, null]);
    expect(doc.querySelector('svg')).toBeNull();
    expect(doc.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(html).not.toMatch(/evil\.example|javascript:|alert\(/);
  });

  it('turns no checked text into markup when the frame parses the document again', () => {
    // Text inside `xmp` on the first parse becomes markup inside MathML on the next one.
    const html = previewDocument(
      page(
        `<p>Before</p><math><mtext><table><mglyph><xmp></math><meta http-equiv=refresh content="0;url=https://evil.example/"><img src=x onerror=alert(1)></xmp></mglyph></table></mtext></math><p>After</p>`,
      ),
      origin,
      { dark: false, images: new Map() },
    );
    const reread = parse(html);
    expect(reread.querySelector('math, xmp')).toBeNull();
    expect(reread.body.querySelectorAll('meta, img')).toHaveLength(0);
    expect(reread.body.textContent).toContain('Before');
    // What is written reads back as itself.
    const again = parse(`<!doctype html><body>${reread.body.innerHTML}`).body
      .innerHTML;
    expect(again).toBe(reread.body.innerHTML);
  });

  it('draws an image’s callout overlay anew, only its parts, attributes and numbers (#546)', () => {
    const overlay =
      '<svg class="of-callouts__overlay" width="100%" height="100%" aria-hidden="true" focusable="false">' +
      '<line class="of-callouts__leader" data-callout="m--photo:fan" x1="60.00%" y1="50.00%" x2="85.00%" y2="10.00%"></line>' +
      '<circle class="of-callouts__anchor" data-callout="m--photo:fan" cx="60.00%" cy="50.00%" r="2.5"></circle>' +
      '<g class="of-callouts__marker" data-callout="m--photo:fan" data-callout-style="square"><circle cx="85.00%" cy="10.00%" r="10"></circle><text x="85.00%" y="10.00%" text-anchor="middle" dominant-baseline="central">1</text></g>' +
      '</svg>';
    const html = previewDocument(
      page(
        `<div class="of-callouts__picture"><img src="https://editor.example/api/assets/${HASH}">${overlay}</div>`,
      ),
      origin,
      { dark: false, images: new Map() },
    );
    const doc = parse(html);
    const svg = doc.querySelector('.of-callouts__picture > svg');
    expect(svg?.outerHTML).toBe(overlay);
    // What is written reads back as itself.
    expect(
      parse(`<!doctype html><body>${doc.body.innerHTML}`).body.innerHTML,
    ).toBe(doc.body.innerHTML);
  });

  it('drops from a callout overlay whatever the renderer does not write', () => {
    const hostile =
      '<svg class="of-callouts__overlay" onload="alert(1)" style="x">' +
      '<line class="of-callouts__leader" x1="javascript:alert(1)" y1="1%" onclick="alert(1)" constructor="x" __proto__="y" data-callout="a:b&quot;]"></line>' +
      '<g class="of-callouts__marker" data-callout="A:x"><text x="1%">1<tspan>x</tspan></text><a href="javascript:alert(1)"><circle r="1"></circle></a><g><circle r="1"></circle></g></g>' +
      '<foreignObject><img src=x onerror=alert(1)></foreignObject><script>alert(1)</script><use href="#x"></use><text>99</text>' +
      '</svg>';
    const doc = parse(
      previewDocument(
        page(
          `<div class="of-callouts__picture">${hostile}</div><svg class="of-callouts__overlay"><circle r="1"></circle></svg>`,
        ),
        origin,
        { dark: false, images: new Map() },
      ),
    );
    const svgs = doc.querySelectorAll('svg');
    // The overlay outside a picture is dropped like any SVG.
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.outerHTML).toBe(
      '<svg class="of-callouts__overlay" width="100%" height="100%" aria-hidden="true" focusable="false">' +
        '<line class="of-callouts__leader" y1="1%"></line>' +
        '<g class="of-callouts__marker"><text x="1%"></text></g>' +
        '</svg>',
    );
    expect(doc.body.innerHTML).not.toMatch(/alert|javascript|onload|style=/);
  });

  it('drops a name that could shadow the frame document’s own members', () => {
    const html = previewDocument(
      page(
        '<p><img name="addEventListener" alt="x"><a name="documentElement" href="#a">a</a></p>',
      ),
      origin,
      { dark: false, images: new Map() },
    );
    expect(parse(html).body.querySelectorAll('[name]')).toHaveLength(0);
  });

  it('writes a policy with no script and only the API’s styles, fonts and blob images', () => {
    const policy = previewPolicy('https://editor.example');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain('style-src https://editor.example');
    expect(policy).toContain('img-src blob:');
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toMatch(/'unsafe-eval'|\*|style-src 'unsafe-inline'/);
  });
});
