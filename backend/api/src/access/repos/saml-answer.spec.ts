import { checkAnswer, signedAssertion } from './saml-answer.js';

/** The bounds of a posted SAML answer (#934). */
describe('checkAnswer', () => {
  const answer = (content: string, declaration = '') =>
    Buffer.from(
      `${declaration}<p:Response xmlns:p="urn:p">${content}</p:Response>`,
    ).toString('base64');
  const values = (n: number, attributes = '') =>
    `<a>${`<v${attributes}>group</v>`.repeat(n)}</a>`;

  it.each([
    ['an answer, with an XML declaration', '<a/>'],
    [
      'a namespace declared at its longest',
      `<a xmlns:o="${'x'.repeat(4096)}" xmlns="${'x'.repeat(4096)}"/>`,
    ],
    [
      'what reads like a declaration in values, which is none',
      `<a>${`<b c=' xmlns:o="${'x'.repeat(4000)}"'/>`.repeat(10)}<d xmlns="${'u'.repeat(300)}">${'<e/>'.repeat(90)}</d></a>`,
    ],
    [
      'a value and a text at their longest',
      `<a b="${'x'.repeat(4096)}">${'x'.repeat(8192)}</a>`,
    ],
    ['line ends XML knows', '<a b="&#10;&#13;\r\n">\r\n&#13;&#x0A;</a>'],
    ['a person in 600 groups', values(600, ' type="xs:string"')],
    [
      'names and values of every shape',
      `<a1 b = ">" xml:lang='a"b'\n xmlns:c="u"\t><c:d.e-f_g\n c:h='_'>_ > &lt;_&gt;</c:d.e-f_g></a1>`,
    ],
    [
      'a person in 200 groups, each value with its namespaces and type',
      `<a xmlns:s="urn:oasis:names:tc:SAML:2.0:assertion">${'<s:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">0f8fad5b-d9cb-469f-a165-70867728950e</s:AttributeValue>'.repeat(200)}</a>`,
    ],
    [
      'two signatures, each of one reference and two transforms',
      '<Signature><Reference><Transform/><Transform/></Reference></Signature>'.repeat(
        2,
      ),
    ],
  ])('takes %s', (_, content) => {
    expect(() =>
      checkAnswer(answer(content, '<?xml version="1.0" encoding="UTF-8"?>\n')),
    ).not.toThrow();
  });

  it.each([
    ['a long one', 'x'.repeat(64 * 1024), /longer than/],
    ['a deep one', `${'<a>'.repeat(32)}${'</a>'.repeat(32)}`, /deeper than/],
    ['many elements and texts', values(800), /nodes/],
    [
      'many attributes on one element',
      `<a ${Array.from({ length: 17 }, (_, i) => `a${i}=""`).join(' ')}/>`,
      /attributes/,
    ],
    [
      'many namespaces on one element',
      `<a ${Array.from({ length: 17 }, (_, i) => `xmlns:a${i}="u"`).join(' ')}/>`,
      /attributes/,
    ],
    ['many attributes in all', values(600, ' a="" b=""'), /attributes/],
    [
      'long namespaces over many elements',
      `<b xmlns:x="${'u'.repeat(700)}">${'<x:a/>'.repeat(100)}</b>`,
      /namespace/,
    ],
    [
      'long namespaces over many attributes',
      `<b xmlns:x="${'u'.repeat(700)}">${'<a x:a=""/>'.repeat(100)}</b>`,
      /namespace/,
    ],
    [
      'a long default namespace over many elements',
      `<b xmlns="${'u'.repeat(700)}">${'<a/>'.repeat(100)}</b>`,
      /namespace/,
    ],
    ['a comment', '<a><!-- --></a>', /comment/],
    ['a processing instruction', '<?a b?>', /processing instruction/],
    ['a second XML declaration', '<?xml version="1.0"?>', /processing/],
    ['a CDATA section', '<![CDATA[a]]>', /CDATA/],
    ...[
      '<_/>',
      '<a:_ xmlns:a="u"/>',
      '<__proto__/>',
      '<_:a xmlns:_="u"/>',
      '<xmlnsa:b xmlns:xmlnsa="u"/>',
      '<xmlns/>',
      '<\u00e9/>',
      '<a\u00e9/>',
      '<a _="x"/>',
      "<a b='>' __proto__='x'/>",
      '<a xmlns:__proto__="u"/>',
      '<a b=">" ><_ /></a>',
      // xmldom would take the second element for an empty one, its content for what follows.
      '<a></a><a>x</a >',
      '<a></a><a>x</a\n>',
      '<p:b xmlns="http://www.w3.org/1999/xhtml"><p:a></p:a><p:a xmlns="u"><script></script></p:a ></p:b>',
      `<p:b xmlns:h="${'u'.repeat(30000)}"><p:a></p:a><p:a xmlns:h="u">${'<h:x/>'.repeat(1000)}</p:a ></p:b>`,
    ].map((content): [string, string, RegExp] => [
      `the tags in ${content.slice(0, 100)}`,
      content,
      /is not plain/,
    ]),
    ...[
      '<h:x xmlns:h="http://www.w3.org/1999/xhtml"/>',
      '<script xmlns="http://www.w3.org/1999/&#120;html">&amp;</script>',
      '<a><b xmlns="http://www.w3.org/1999/xhtml"><textarea/></b></a>',
      '<a xmlns:h="http://www.w3.org/1999/xhtml" h:b=""/>',
    ].map((content): [string, string, RegExp] => [
      `XHTML in ${content}`,
      content,
      /XHTML/,
    ]),
    [
      'XHTML as the reserved prefix',
      '<xml:script xmlns:xml="http://www.w3.org/1999/xhtml"/>',
      /cannot be declared/,
    ],
    ['a third Signature', '<Signature/>'.repeat(3), /Signature/],
    ['a third Reference', '<Reference/>'.repeat(3), /Reference/],
    [
      'a fifth Transform, whatever its namespace',
      '<t:Transform xmlns:t="urn:t"/>'.repeat(5),
      /Transform/,
    ],
    ['a tag in an attribute', '<a b="<_/>"/>', /holds "<"/],
    ...[
      '\u0085',
      '\u2028',
      '\u2029',
      '&#133;',
      '&#8232;',
      '&#008233;',
      '&#x85;',
      '&#X2028;',
      '&#x2029;',
      '&#x0002029;',
      '&#x2029;'.toUpperCase(),
    ].flatMap((separator): [string, string, RegExp][] => [
      [
        `${JSON.stringify(separator)} in text`,
        `<a>${separator}</a>`,
        /line separator/,
      ],
      [
        `${JSON.stringify(separator)} in a value`,
        `<a b="${separator}"/>`,
        /line separator/,
      ],
    ]),
    ['a long value', `<a b="${'x'.repeat(4097)}"/>`, /longer than 4096/],
    ['a long text', `<a>${'x'.repeat(8193)}</a>`, /longer than 8192/],
    [
      'a long text of references',
      `<a>${'&amp;'.repeat(8193)}</a>`,
      /longer than 8192/,
    ],
    ['what is not XML', '<a>', /closes/],
  ])('refuses %s', (_, content, message) => {
    expect(() => checkAnswer(answer(content))).toThrow(message);
  });

  // node-saml's parsers took seconds on these before anything was verified. Only that they are
  // refused fast is shown here; what node-saml costs on what is taken, just within the bounds,
  // `tests/saml-answer-cost.perf.spec.ts` measures.
  const run = 'x'.repeat(60_000);
  const SEPARATOR = /line separator/;
  const VALUE = /attribute value longer than 4096/;
  const DECLARED = /declares a namespace longer than 4096/;
  it.each([
    ['a long line ended by U+2029', `<a>${run}\u2029</a>`, SEPARATOR],
    ['the same as a reference', `<a>${run}&#x2029;</a>`, SEPARATOR],
    ['a long status code', `<StatusCode Value="${run}:"/>`, VALUE],
    [
      'a long prefix list',
      `<InclusiveNamespaces PrefixList="${run} "/>`,
      VALUE,
    ],
    [
      'a long certificate',
      `<X509Certificate>${run}</X509Certificate>`,
      /text longer than 8192/,
    ],
    ['a long namespace declared', `<a xmlns:o="${run}"/>`, DECLARED],
    [
      'a long namespace declared after a value that reads like a declaration',
      `<a b=' xmlns:p="' xmlns:o="${run}"/>`,
      DECLARED,
    ],
    [
      'a long namespace declared, the start of its value read as another',
      `<a b=" xmlns='" xmlns:p="x'${'x'.repeat(60_000)}"/>`,
      DECLARED,
    ],
    ['a long default namespace declared', `<a xmlns="${run}"/>`, DECLARED],
    [
      'namespaces declared on many elements and used on others',
      `<a>${`<b xmlns:o="${'x'.repeat(1000)}"/>`.repeat(30)}<c xmlns="${'u'.repeat(700)}">${'<a/>'.repeat(60)}</c></a>`,
      /namespaces the answer declares/,
    ],
  ])('refuses %s within a few milliseconds', (_, content, why) => {
    const answered = answer(content);
    expect(answered.length).toBeGreaterThan(40_000);
    let fastest = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      expect(() => checkAnswer(answered)).toThrow(why);
      fastest = Math.min(fastest, performance.now() - start);
    }
    expect(fastest).toBeLessThan(20);
  });

  it('takes a byte-order mark', () => {
    expect(() =>
      checkAnswer(answer('', '\uFEFF<?xml version="1.0"?>')),
    ).not.toThrow();
  });

  it('refuses a processing instruction that begins like an XML declaration', () => {
    expect(() => checkAnswer(answer('', '<?xml\u00a0version="1.0"?>'))).toThrow(
      /processing instruction/,
    );
  });

  it('refuses a DTD', () => {
    expect(() => checkAnswer(answer('', '<!DOCTYPE a>'))).toThrow(/DTD/);
  });
});

/** The assertion as our reader reads the signed bytes, when node-saml reads the same (#946). */
describe('signedAssertion', () => {
  const read = (from = '', to = '') =>
    '<a:Assertion xmlns:a="urn:a" ID="1" a:b="2">\n<a:c>text</a:c><a:d></a:d></a:Assertion>'.replace(
      from,
      to,
    );
  const SIGNED = read();
  const response = (content: string) =>
    `<p:Response xmlns:p="urn:p" xmlns:b="urn:b">${content}</p:Response>`;

  it.each([
    ['as signed', read()],
    [
      'with other prefixes, references and order of attributes',
      `<Assertion xmlns="urn:a" xmlns:x="urn:a" x:b="&#50;" ID='1'>\n<x:c>te&#120;t</x:c><d/></Assertion>`,
    ],
  ])('is read %s', (_, xml) => {
    for (const signed of [SIGNED, response(`<p:Status/>${SIGNED}`)]) {
      const assertion = signedAssertion(signed, xml);
      expect(assertion.local).toBe('Assertion');
      expect(assertion.attributes.get('ID')).toBe('1');
    }
  });

  it.each(['&#xD;', '&#xD;\n'])(
    'keeps the line end %j it was signed with',
    (end) => {
      const signed = read('text', `te${end}xt`);
      const assertion = signedAssertion(
        signed,
        read('text', `te${end.replace('&#xD;', '\r')}xt`),
      );
      expect(assertion.children[1]).toMatchObject({
        children: [`te${end.replace('&#xD;', '\r')}xt`],
      });
    },
  );

  it.each([
    ['another text', read('text', 'Text')],
    ['a text of elements', read('text', '<a:e>text</a:e>')],
    ['another blank', read('\n', ' ')],
    ['another element', read('<a:c>text</a:c>', '<a:e>text</a:e>')],
    ['an element more', read('<a:d>', '<a:e/><a:d>')],
    ['an element less', read('<a:d></a:d>', '')],
    ['an element elsewhere', read('</a:c><a:d></a:d>', '<a:d></a:d></a:c>')],
    [
      'elements in another order',
      read('<a:c>text</a:c><a:d></a:d>', '<a:d/><a:c>text</a:c>'),
    ],
    ['another namespace', read('urn:a', 'urn:b')],
    ['an attribute in no namespace', read('a:b', 'b')],
    ['another attribute', read('"2"', '"3"')],
    ['an attribute more', read('a:b', 'c="" a:b')],
  ])('is refused read with %s', (_, xml) => {
    for (const signed of [SIGNED, response(SIGNED)]) {
      expect(() => signedAssertion(signed, xml)).toThrow(/than the one signed/);
    }
  });

  it.each([
    ['&#xD;', ''],
    ['&#xD;', ' '],
    ['&#xD;', '\u0085'],
    ['&#xD;\u0085', '\r\n'],
  ])(
    'is refused read with another text than its line end %j: %j',
    (end, other) => {
      expect(() =>
        signedAssertion(
          read('text', `te${end}xt`),
          read('text', `te${other}xt`),
        ),
      ).toThrow(/than the one signed/);
    },
  );

  it('is refused read with another line end in an attribute', () => {
    expect(() =>
      signedAssertion(read('"2"', '"&#xD;"'), read('"2"', '"&#xA;"')),
    ).toThrow(/than the one signed/);
  });

  it.each([
    ['none', '<p:b/>'],
    ['none of its own children', `<p:b>${SIGNED}</p:b>`],
    ['two', SIGNED + SIGNED],
    ['another of that name', `${SIGNED}<b:Assertion/>`],
  ])('is refused in a response with %s', (_, content) => {
    expect(() => signedAssertion(response(content), read())).toThrow(
      /than the one signed/,
    );
  });
});
