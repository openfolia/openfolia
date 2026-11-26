import { SAML } from '@node-saml/node-saml';
import { checkAnswer } from '../src/access/repos/saml-answer.js';
import { SamlIdentityProvider } from '../src/access/repos/saml-identity-provider.js';
import { type MockSamlIdp, startMockSamlIdp } from './saml/mock-idp.js';

/**
 * What node-saml and its parsers cost on an answer before any signature is verified (#946), shape
 * by shape: long runs of one character ended by each line terminator and by other characters, in
 * each part of an answer read unverified, at the longest a value or text may be and past it. Not
 * part of the suite (`SAML_COST=1` runs it, for about a quarter of an hour; `SAML_COST=taken` times
 * only what `checkAnswer` takes, in a minute or two). It prints the shapes that took node-saml more
 * than 100 ms, whether `checkAnswer` refuses them, and the worst of each part. Then whole answers
 * at the bounds, and whole sign-ins through the provider (#951): how long they take, and how long
 * the server's event loop was held meanwhile (`-t "through the provider"` alone, in seconds).
 */
describe.skipIf(!process.env['SAML_COST'])('SAML answer cost', () => {
  let idp: MockSamlIdp;
  let cert: string;
  beforeAll(async () => {
    idp = await startMockSamlIdp({
      audience: 'sp',
      acsUrl: 'http://sp.test/acs',
      accounts: { pat: {} },
    });
    const metadata = await (await fetch(idp.metadataUrl)).text();
    cert = /<ds:X509Certificate>([^<]*)</.exec(metadata)![1]!;
  });
  afterAll(() => idp.close());

  // Past the bounds, and at them: an attribute value, a text.
  const RUNS = [56_000, 4_000, 8_000];
  const fillers = ['x', ' ', 'a:', ':', '#', '-', 'a ', '=', '\t', '&amp;'];
  const ends = [
    '',
    '\n',
    '\r',
    '&#13;',
    '\u0085',
    ' ',
    ' ',
    '&#x2029;',
    '&#8233;',
    '&#x85;',
    '&#x2028;',
    ':',
    '#',
    '<',
  ];
  /** Where a long value goes: `v` is it, written into the signed answer. */
  const places: Record<string, (xml: string, v: string) => string> = {
    'response text': (xml, v) =>
      xml.replace('<samlp:Status>', `<samlp:E>${v}</samlp:E>$&`),
    'response attribute': (xml, v) =>
      xml.replace('<samlp:Response ', `$&o="${v}" `),
    'status code': (xml, v) =>
      xml
        .replace(/<saml:Assertion .*<\/saml:Assertion>/s, '')
        .replace('urn:oasis:names:tc:SAML:2.0:status:Success', v),
    'status message': (xml, v) =>
      xml
        .replace(/<saml:Assertion .*<\/saml:Assertion>/s, '')
        .replace('status:Success', 'status:Requester')
        .replace(
          '</samlp:Status>',
          `<samlp:StatusMessage>${v}</samlp:StatusMessage>$&`,
        ),
    'response issuer': (xml, v) => xml.replace(/<saml:Issuer>/, `$&${v}`),
    'signed info': (xml, v) => xml.replace('<SignedInfo>', `$&<E>${v}</E>`),
    'signature value': (xml, v) => xml.replace('<SignatureValue>', `$&${v}`),
    certificate: (xml, v) => xml.replace('<X509Certificate>', `$&${v}`),
    'prefix list': (xml, v) =>
      xml.replace(
        '<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>',
        `<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"><InclusiveNamespaces xmlns="http://www.w3.org/2001/10/xml-exc-c14n#" PrefixList="${v}"/></Transform>`,
      ),
    'reference uri': (xml, v) => xml.replace(/URI="#/, `$&${v}`),
    // xmldom looks for each new name's end tag through the whole answer.
    'many names, then a long value': (xml, v) =>
      xml.replace(
        '<samlp:Status>',
        `${Array.from({ length: 1000 }, (_, i) => `<e${i}></e${i}>`).join('')}<samlp:E>${v}</samlp:E>$&`,
      ),
    // xml-crypto looks up each declared prefix in the prefix list.
    'a long prefix list, and many prefixes declared': (xml, v) =>
      xml
        .replace(
          '<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>',
          `<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"><InclusiveNamespaces xmlns="http://www.w3.org/2001/10/xml-exc-c14n#" PrefixList="${Array.from(
            { length: 2000 },
            (_, i) => `p${i}`,
          )
            .join(' ')
            .slice(0, v.length)}"/></Transform>`,
        )
        .replace(
          '<samlp:Status>',
          `${`<samlp:E ${Array.from({ length: 13 }, (_, i) => `xmlns:p${i}="u"`).join(' ')}/>`.repeat(150)}$&`,
        ),
    'namespace declared': (xml, v) =>
      xml.replace('<samlp:Response ', `$&xmlns:o="${v}" `),
    'default namespace declared': (xml, v) =>
      xml.replace('<samlp:Status>', `<samlp:E xmlns="${v}"/>$&`),
    'namespaces declared on many elements': (xml, v) =>
      xml.replace(
        '<samlp:Status>',
        `${`<samlp:E xmlns:o="${v.slice(0, 1000)}"/>`.repeat(Math.floor(v.length / 1000))}$&`,
      ),
  };

  it('prints the cost of each shape', async () => {
    const only = process.env['SAML_COST_PLACE'];
    for (const [place, put] of Object.entries(places)) {
      if (only && place !== only) continue;
      let worst = { ms: 0, shape: '' };
      for (const [filler, end, run] of fillers.flatMap((filler) =>
        ends.flatMap((end) => RUNS.map((run) => [filler, end, run] as const)),
      )) {
        {
          const value =
            filler.repeat(Math.floor(run / filler.length)) +
            (end === '<' ? '' : end);
          const answer = idp.answer({
            login: 'pat',
            tamper: (xml) => put(xml, value),
          });
          let refused = 'taken';
          try {
            checkAnswer(answer);
          } catch (error) {
            refused = `refused (${(error as Error).message.slice(0, 40)})`;
          }
          if (process.env['SAML_COST'] === 'taken' && refused !== 'taken') {
            continue;
          }
          const saml = new SAML({
            entryPoint: 'http://idp.test',
            idpIssuer: idp.entityId,
            idpCert: [cert],
            issuer: 'sp',
            audience: 'sp',
            callbackUrl: 'http://sp.test/acs',
            wantAssertionsSigned: true,
            wantAuthnResponseSigned: false,
          });
          const start = performance.now();
          await saml
            .validatePostResponseAsync({ SAMLResponse: answer })
            .catch(() => undefined);
          const ms = performance.now() - start;
          if (ms > 100) {
            console.log(
              `${place} | ${JSON.stringify(filler)} x ${run} + ${JSON.stringify(end)} | ${Math.round(ms)} ms | ${refused}`,
            );
          }
          if (ms > worst.ms) {
            worst = {
              ms,
              shape: `${JSON.stringify(filler)} x ${run}+${JSON.stringify(end)}`,
            };
          }
        }
      }
      console.log(
        `${place}: worst ${Math.round(worst.ms)} ms (${worst.shape})`,
      );
    }
  }, 1_800_000);

  /** Whole answers at the bounds, each timed once, with one trusted certificate and with two. */
  const RESPONSE_SIGNATURE = (xml: string, transforms: string) => {
    const signature = /<Signature .*<\/Signature>/s.exec(xml)![0];
    const id = / ID="([^"]*)"/.exec(xml)![1]!;
    return xml.replace(
      '</saml:Issuer>',
      `$&${signature
        .replace(/URI="#[^"]*"/, `URI="#${id}"`)
        .replace(
          /<Transforms>.*<\/Transforms>/s,
          `<Transforms>${transforms}</Transforms>`,
        )}`,
    );
  };
  const EXC = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  const shapes: Record<string, (xml: string) => string> = {
    // Distinct names, parsed again per signature, transform and certificate.
    'many names in both signed elements, two transforms each': (xml) => {
      const twice = `<Transform Algorithm="${EXC}"/><Transform Algorithm="${EXC}"/>`;
      let out = RESPONSE_SIGNATURE(xml, twice).replace(
        /(<saml:Assertion .*?<Transforms>).*?(<\/Transforms>)/s,
        `$1${twice}$2`,
      );
      const names = Array.from(
        { length: 1380 },
        (_, i) => `<e${i}></e${i}>`,
      ).join('');
      out = out.replace('</saml:Assertion>', `${names}$&`);
      const pad = Math.max(0, 64 * 1024 - 500 - out.length);
      return out.replace(
        '</saml:Assertion>',
        `<saml:P>${'x'.repeat(Math.min(pad, 8000))}</saml:P>`.repeat(
          Math.floor(pad / 8020),
        ) + '$&',
      );
    },
    // xml-crypto looks up each declared prefix in the prefix lists of a transform.
    'long prefix lists, and many prefixes declared under them': (xml) => {
      const lists = `<Transform Algorithm="${EXC}">${`<InclusiveNamespaces xmlns="${EXC}" PrefixList="${'a '.repeat(2048)}"/>`.repeat(8)}</Transform>`;
      const declared = Array.from(
        { length: 110 },
        (_, e) =>
          `<samlp:E ${Array.from({ length: 13 }, (_, i) => `xmlns:b${e}x${i}="u"`).join(' ')}/>`,
      ).join('');
      return RESPONSE_SIGNATURE(xml, lists).replace(
        '<samlp:Status>',
        `${declared}$&`,
      );
    },
    // The same where the signed info is canonicalised, before its signature is checked.
    'long prefix lists, and many prefixes declared, in the signed info': (
      xml,
    ) =>
      xml.replace(
        /<CanonicalizationMethod Algorithm="[^"]*"\/>/,
        `<CanonicalizationMethod Algorithm="${EXC}">${`<InclusiveNamespaces xmlns="${EXC}" PrefixList="${'a '.repeat(2048)}"/>`.repeat(7)}</CanonicalizationMethod>${Array.from(
          { length: 110 },
          (_, e) =>
            `<E ${Array.from({ length: 13 }, (_, i) => `xmlns:b${e}x${i}="u"`).join(' ')}/>`,
        ).join('')}`,
      ),
    // sax keeps a CRLF in an attribute value as two characters, the reader as one.
    'a status code of line ends, nested': (xml) =>
      xml
        .replace(/<saml:Assertion .*<\/saml:Assertion>/s, '')
        .replace(
          /<samlp:StatusCode Value="[^"]*"\/>/,
          `<samlp:StatusCode Value="${'\r\n'.repeat(4095)}:"><samlp:StatusCode Value="${'\r\n'.repeat(4095)}:"/></samlp:StatusCode>`,
        ),
  };

  it('prints the cost of whole answers at the bounds', async () => {
    for (const [name, shape] of Object.entries(shapes)) {
      const answer = idp.answer({ login: 'pat', tamper: shape });
      let refused = 'taken';
      try {
        checkAnswer(answer);
      } catch (error) {
        refused = `refused (${(error as Error).message.slice(0, 60)})`;
      }
      for (const certs of [[cert], [cert, cert]]) {
        const saml = new SAML({
          entryPoint: 'http://idp.test',
          idpIssuer: idp.entityId,
          idpCert: certs,
          issuer: 'sp',
          audience: 'sp',
          callbackUrl: 'http://sp.test/acs',
          wantAssertionsSigned: true,
          wantAuthnResponseSigned: false,
        });
        const start = performance.now();
        const why = await saml
          .validatePostResponseAsync({ SAMLResponse: answer })
          .then(
            () => 'accepted',
            (error: Error) => error.message.slice(0, 50),
          );
        console.log(
          `${name} | ${Buffer.from(answer, 'base64').length} bytes | ${certs.length} certificate(s) | ${Math.round(performance.now() - start)} ms | ${why} | ${refused}`,
        );
      }
    }
  }, 600_000);

  /**
   * A whole sign-in through the provider (#951): a normal answer, many times, and the slowest
   * answers `checkAnswer` takes, each with the request it answers.
   */
  it('prints the cost of a sign-in through the provider', async () => {
    const seen = new Set<string>();
    const provider = new SamlIdentityProvider(
      {
        metadata: { url: idp.metadataUrl },
        entityId: 'sp',
        acsUrl: 'http://sp.test/acs',
        nameIdFormat: 'persistent',
        emailAttribute: 'email',
        nameAttribute: 'name',
        groupsAttribute: 'groups',
        emailVerified: true,
        idpInitiated: false,
      },
      {
        recordOnce: (key: string) =>
          Promise.resolve(!seen.has(key) && seen.add(key) !== undefined),
      },
    );
    const signIn = async (tamper?: (xml: string) => string) => {
      const { pending } = await provider.begin();
      const answer = idp.answer({
        login: 'pat',
        inResponseTo: pending['requestId']!,
        ...(tamper && { tamper }),
      });
      // How long the server could do nothing else meanwhile: the longest time between beats.
      const start = performance.now();
      let last = start;
      let held = 0;
      const beat = () => {
        const now = performance.now();
        held = Math.max(held, now - last);
        last = now;
      };
      const beating = setInterval(beat, 1);
      const outcome = await provider
        .complete(new URLSearchParams({ SAMLResponse: answer }), pending)
        .then(
          () => 'accepted',
          (error: Error) => error.message.slice(0, 50),
        );
      beat();
      clearInterval(beating);
      return { ms: performance.now() - start, outcome, held };
    };
    const first = await signIn();
    console.log(
      `the first sign-in | ${Math.round(first.ms)} ms | ${first.outcome}`,
    );
    const times: number[] = [];
    const helds: number[] = [];
    for (let i = 0; i < 200; i++) {
      const { ms, outcome, held } = await signIn();
      expect(outcome).toBe('accepted');
      times.push(ms);
      helds.push(held);
    }
    helds.sort((a, b) => a - b);
    times.sort((a, b) => a - b);
    const at = (share: number) =>
      times[Math.min(times.length - 1, Math.floor(times.length * share))]!;
    console.log(
      `a normal sign-in, ${times.length} times | median ${at(0.5).toFixed(1)} ms | 95th ${at(0.95).toFixed(1)} ms | most ${at(1).toFixed(1)} ms | the server held up to ${helds[Math.floor(helds.length / 2)]!.toFixed(1)} ms (median), ${helds.at(-1)!.toFixed(1)} ms (most)`,
    );
    const slowest: Record<string, (xml: string) => string> = {
      'many names, then a long value ("&amp;" x 8000)': (xml) =>
        places['many names, then a long value']!(xml, '&amp;'.repeat(1600)),
      'a long prefix list, and many prefixes declared ("#" x 4000 + "\\n")': (
        xml,
      ) =>
        places['a long prefix list, and many prefixes declared']!(
          xml,
          `${'#'.repeat(4000)}\n`,
        ),
      'many names in both signed elements, two transforms each':
        shapes['many names in both signed elements, two transforms each']!,
    };
    for (const [name, tamper] of Object.entries(slowest)) {
      const { ms, outcome, held } = await signIn(tamper);
      console.log(
        `${name} | ${Math.round(ms)} ms | the server held up to ${Math.round(held)} ms | ${outcome}`,
      );
    }
  }, 600_000);
});
