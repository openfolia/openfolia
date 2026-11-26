import { Logger } from '@nestjs/common';
import { ActorDocument } from '../src/access/api/access.resources.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import { users } from '../src/access/repos/access.tables.js';
import {
  sessions,
  userIdentities,
} from '../src/access/repos/sign-in.tables.js';
import type { AnswerOptions } from './saml/mock-idp.js';
import {
  cookiePair,
  type SamlSetup,
  setCookies,
  setUpSaml,
} from './saml/setup.js';

const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';
const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';

// Why an answer is refused, as the log says it.
const ONE = /does not hold exactly one NameID/;
const FORMAT = /its NameID has the Format /;
const NAME_QUALIFIER = /its NameID has the NameQualifier /;
const SP_NAME_QUALIFIER = /its NameID has the SPNameQualifier /;
const TEXT = /its NameID is empty, has blanks around it/;
const CONFIRMATION = /no bearer SubjectConfirmation/;
// Before anything in it is trusted.
const PLAIN = /SamlAnswerError: The answer holds a comment/;
const NAMES = /SamlAnswerError: A tag .* is not plain/;
const XHTML = /SamlAnswerError: .* XHTML/;
const SEPARATOR = /SamlAnswerError: The answer holds a line separator/;
const XML = /XmlReadError: /;
const SIGNATURE = /Error: Invalid signature$/;
const NOT_ITS_PARENT =
  /Error: Invalid signature: Referenced node does not refer to its parent element/;
const SAME_ID =
  /Error: Invalid signature: ID cannot refer to more than one element/;
const SEVERAL = /Error: Invalid signature: multiple assertions/;

/**
 * Subjects and name IDs no provider should send (#946), in answers the test provider signs: whom
 * each names (always the one person its NameID names, or someone else with a text of their own),
 * or that it is refused, for the reason it is meant to be, and makes nothing.
 */
describe('SAML sign-in, name IDs out of shape', () => {
  let s: SamlSetup;
  beforeAll(async () => {
    s = await setUpSaml({ CCMS_SAML_IDP_INITIATED: 'true' });
  });
  // A user keeps the newest sessions only, so each test counts from none.
  beforeEach(async () => {
    await s.t.database.db.delete(sessions);
  });
  afterAll(async () => {
    await s?.close();
  });

  type Shape = Pick<
    AnswerOptions,
    'nameId' | 'reshape' | 'signResponse' | 'signWith' | 'tamper'
  >;
  const persistentAnd = (more: string) => ` Format="${PERSISTENT}"${more}`;
  /** pat's NameID as XML, with other attributes or another text. */
  const nameIdXml = (text = 'id-pat', attributes = persistentAnd('')) =>
    `<saml:NameID${attributes}>${text}</saml:NameID>`;
  /** The assertion with `xml` as its NameID, signed. */
  const nameId = (xml: string): Shape => replaced(nameIdXml(), xml);
  /** The assertion with `to` in place of `from` (`$&`: what was found), signed. */
  const replaced = (from: string, to: string): Shape => ({
    reshape: (xml) => xml.replace(from, to),
  });
  /** The answer with `to` in place of `from` (`$&`: what was found), after it was signed. */
  const tampered = (from: string, to: string): Shape => ({
    tamper: (xml) => xml.replace(from, to),
  });
  /** The assertion with its Subject made of `subject(NameID, SubjectConfirmation)`, signed. */
  const subject = (
    shape: (nameId: string, confirmation: string) => string,
  ): Shape => ({
    reshape: (xml) =>
      xml.replace(
        /<saml:Subject>(<saml:NameID .*<\/saml:NameID>)(.*)<\/saml:Subject>/s,
        (_, nameId: string, confirmation: string) =>
          shape(nameId, confirmation),
      ),
  });
  /**
   * The assertion with its Subject made of `shape`, where `hide` makes an XHTML script of escaped
   * text: signed as that text, and written out as elements by a reader that knows XHTML.
   */
  const hidden = (
    shape: (
      nameId: string,
      confirmation: string,
      hide: (xml: string) => string,
    ) => string,
  ): Shape => {
    const escaped = (xml: string) =>
      xml.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    const texts: string[] = [];
    return {
      ...subject((id, confirmation) =>
        shape(id, confirmation, (xml) => {
          texts.push(CLOSE + xml + OPEN);
          return OPEN + escaped(CLOSE + xml + OPEN) + CLOSE;
        }),
      ),
      // The test provider's signer is such a reader: the text as it was signed.
      tamper: (xml) =>
        texts.reduce(
          (changed, text) => changed.replace(text, () => escaped(text)),
          xml,
        ),
    };
  };
  const OPEN = '<h:x xmlns:h="http://www.w3.org/1999/xhtml"><script>';
  const CLOSE = '</script></h:x>';
  /**
   * `shape` with its XHTML declared on the response, and declared otherwise on an element around
   * the assertion that a reader may take for an empty one.
   */
  const displaced = (shape: Shape): Shape => ({
    ...shape,
    tamper: (xml) =>
      shape.tamper!(xml)
        .replaceAll('<h:x xmlns:h="http://www.w3.org/1999/xhtml">', '<h:x>')
        .replace(
          '<samlp:Response ',
          '$&xmlns:h="http://www.w3.org/1999/xhtml" ',
        )
        .replace(
          /<saml:Assertion .*<\/saml:Assertion>/s,
          '<samlp:X></samlp:X><samlp:X xmlns:h="urn:o">$&</samlp:X >',
        ),
  });
  /**
   * The answer with its signed assertion replaced, after it was signed, by what `shape` makes of
   * it, of its signature, and of a whole assertion for someone else, signed by nobody.
   */
  const wrapped = (
    shape: (signed: string, signature: string, forged: string) => string,
  ): Shape => ({
    tamper: (xml) =>
      xml.replace(/<saml:Assertion .*<\/saml:Assertion>/s, (signed) => {
        const signature = /<Signature .*<\/Signature>/s.exec(signed)![0];
        const forged = signed
          .replace(signature, '')
          .replace(/ ID="[^"]*"/, ' ID="_forged"')
          .replace('>id-pat<', '>id-root<');
        return shape(signed, signature, forged);
      }),
  });

  async function post(shape: Shape) {
    // Every change is one: what it looks for is there.
    for (const key of ['reshape', 'tamper'] as const) {
      const change = shape[key];
      if (!change) continue;
      shape = {
        ...shape,
        [key]: (xml: string) => {
          const changed = change(xml);
          expect(changed).not.toBe(xml);
          return changed;
        },
      };
    }
    const res = await s.t
      .anonymous()
      .post('/auth/saml/callback')
      .type('form')
      .send({ SAMLResponse: s.mock.answer({ login: 'pat', ...shape }) })
      .expect(303);
    const session = setCookies(res).find((line) =>
      line.startsWith(`${SESSION_COOKIE}=ccms_ses_`),
    );
    return {
      to: (res.headers['location'] as string).replace(s.base, ''),
      session: session && cookiePair(session),
    };
  }
  const userOf = async (shape: Shape) => {
    const { session } = await post(shape);
    expect(session).toBeDefined();
    const me = await s.t.anonymous().get('/me').set('Cookie', session!);
    return ActorDocument.parse(me.body).data.id;
  };
  const made = async () => {
    const { db } = s.t.database;
    return {
      users: (await db.select().from(users)).length,
      identities: (await db.select().from(userIdentities)).length,
      sessions: (await db.select().from(sessions)).length,
    };
  };
  /** The answer is refused for that reason, and nothing is made. */
  async function expectRefused(shape: Shape, why: RegExp) {
    await userOf({});
    const before = await made();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      expect(await post(shape)).toEqual({
        to: '/sign-in?error=sign-in-failed',
        session: undefined,
      });
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringMatching(why),
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(await made()).toEqual(before);
  }

  const ENCRYPTED =
    '<saml:EncryptedID><x:EncryptedData xmlns:x="http://www.w3.org/2001/04/xmlenc#"/></saml:EncryptedID>';

  const same: [string, Shape][] = [
    ['nothing changed', {}],
    // As providers write answers.
    [
      'the answer indented',
      {
        reshape: (xml) => xml.replaceAll('><', '>\n  <'),
        tamper: (xml) =>
          xml.replace(/<samlp:Status>|<saml:Assertion /g, '\n  $&'),
      },
    ],
    [
      'the answer indented, with the line ends of Windows',
      {
        reshape: (xml) => xml.replaceAll('><', '>\n  <'),
        tamper: (xml) => xml.replaceAll('\n', '\r\n'),
      },
    ],
    [
      'carriage returns signed in another attribute',
      {
        reshape: (xml) =>
          xml.replace(
            '<saml:AttributeStatement>',
            '$&<saml:Attribute Name="street"><saml:AttributeValue>a&#13;&#10;b&#13;c</saml:AttributeValue></saml:Attribute>',
          ),
      },
    ],
    // Signed both: what is verified is the whole response.
    ['the response signed too', { signResponse: (xml) => xml }],
    [
      'the response signed too, its assertion’s namespace declared on it alone',
      {
        signResponse: (xml) => xml,
        reshape: (xml) => xml.replace(` xmlns:saml="${SAML_NS}"`, ''),
      },
    ],
    [
      'the response signed too, with carriage returns in its assertion’s signature',
      {
        signResponse: (xml) => {
          const changed = xml.replace(/<SignatureValue>.{64}/, '$&&#13;\n');
          expect(changed).not.toBe(xml);
          return changed;
        },
      },
    ],
    [
      'the response signed too, but changed since: the assertion’s signature counts',
      {
        signResponse: (xml) => xml,
        ...tampered('status:Success"', '$& other="x"'),
      },
    ],
    [
      'namespaces declared that nothing is in',
      tampered(
        '<samlp:Response ',
        '$&xmlns="urn:o" xmlns:o="urn:o" xmlns:xs="http://www.w3.org/2001/XMLSchema" ',
      ),
    ],
    [
      'XHTML declared, and declared otherwise where it would be used',
      {
        reshape: (xml) =>
          xml.replace(
            '<saml:AuthnStatement',
            '<saml:Advice><script xmlns="urn:o"/><h:textarea xmlns:h="urn:o"/></saml:Advice>$&',
          ),
        tamper: (xml) =>
          xml.replace(
            '<samlp:Response ',
            '$&xmlns="http://www.w3.org/1999/xhtml" xmlns:h="http://www.w3.org/1999/xhtml" ',
          ),
      },
    ],
    ['character references in the text', nameId(nameIdXml('&#105;d&#x2d;pat'))],
    [
      'character references in the Format',
      replaced('Format="urn', 'Format="&#x75;rn'),
    ],
    [
      'another prefix for the same namespace',
      nameId(
        `<a:NameID xmlns:a="${SAML_NS}" Format="${PERSISTENT}">id-pat</a:NameID>`,
      ),
    ],
    [
      'no prefix, the namespace as the default',
      nameId(
        `<NameID xmlns="${SAML_NS}" Format="${PERSISTENT}">id-pat</NameID>`,
      ),
    ],
    // Names count without their namespace, as node-saml reads them. Only the provider can sign these, and the
    // text is still the one it names pat by.
    [
      'the NameID in a foreign namespace',
      nameId(
        `<o:NameID xmlns:o="urn:o" Format="${PERSISTENT}">id-pat</o:NameID>`,
      ),
    ],
    [
      'the Subject in a foreign namespace',
      subject(
        (id, confirmation) =>
          `<o:Subject xmlns:o="urn:o">${id}${confirmation}</o:Subject>`,
      ),
    ],
    [
      'qualifiers in a foreign namespace or another case, which are not those',
      nameId(
        nameIdXml(
          'id-pat',
          persistentAnd(
            ' namequalifier="x" NAMEQUALIFIER="x" o:NameQualifier="x" o:SPNameQualifier="x" xmlns:o="urn:o"',
          ),
        ),
      ),
    ],
    [
      'a Format in a foreign namespace beside its own',
      nameId(
        nameIdXml(
          'id-pat',
          persistentAnd(` o:Format="${UNSPECIFIED}" xmlns:o="urn:o"`),
        ),
      ),
    ],
    [
      'an SPProvidedID, and attributes named as what objects have',
      nameId(
        nameIdXml(
          'id-pat',
          persistentAnd(
            ' SPProvidedID="x" constructor="x" toString="x" cdata="x"',
          ),
        ),
      ),
    ],
    [
      'a BaseID beside it',
      nameId(`${nameIdXml()}<saml:BaseID NameQualifier="elsewhere"/>`),
    ],
    ['an EncryptedID beside it', nameId(`${nameIdXml()}${ENCRYPTED}`)],
    [
      'a BaseID and an EncryptedID before it',
      nameId(`<saml:BaseID/>${ENCRYPTED}${nameIdXml()}`),
    ],
    [
      'another Subject in its Subject',
      replaced(
        '</saml:Subject>',
        `<saml:Subject>${nameIdXml('id-root')}</saml:Subject>$&`,
      ),
    ],
    [
      'another NameID in the SubjectConfirmation',
      replaced('<saml:SubjectConfirmationData', `${nameIdXml('id-root')}$&`),
    ],
    [
      'another NameID beside the Subject',
      replaced('</saml:Subject>', `$&${nameIdXml('id-root')}`),
    ],
    [
      'another NameID in an attribute',
      replaced(
        '<saml:AttributeStatement>',
        `$&<saml:Attribute Name="other"><saml:AttributeValue>${nameIdXml('id-root')}</saml:AttributeValue></saml:Attribute>`,
      ),
    ],
    [
      'another assertion in the signed one’s Advice',
      replaced(
        '<saml:AuthnStatement',
        `<saml:Advice><saml:Assertion ID="_advice"><saml:Subject>${nameIdXml('id-root')}</saml:Subject></saml:Assertion></saml:Advice>$&`,
      ),
    ],
  ];

  it.each(same)('%s: the same user', async (_, shape) => {
    const pat = await userOf({});
    const before = await made();
    expect(await userOf(shape)).toBe(pat);
    expect(await made()).toEqual({ ...before, sessions: before.sessions + 1 });
  });

  const refused: [string, Shape, RegExp][] = [
    // The Subject.
    ['no Subject', subject(() => ''), CONFIRMATION],
    ['an empty Subject', subject(() => '<saml:Subject/>'), CONFIRMATION],
    [
      'a Subject of another case',
      subject((id, conf) => `<saml:subject>${id}${conf}</saml:subject>`),
      CONFIRMATION,
    ],
    [
      'a Subject in the Subject',
      subject(
        (id, conf) =>
          `<saml:Subject><saml:Subject>${id}${conf}</saml:Subject></saml:Subject>`,
      ),
      CONFIRMATION,
    ],
    [
      'the NameID in a Subject in the Subject',
      subject(
        (id, conf) =>
          `<saml:Subject><saml:Subject>${id}</saml:Subject>${conf}</saml:Subject>`,
      ),
      ONE,
    ],
    [
      'a second Subject before it, whole',
      subject(
        (id, conf) =>
          `<saml:Subject>${nameIdXml('id-root')}${conf}</saml:Subject><saml:Subject>${id}${conf}</saml:Subject>`,
      ),
      ONE,
    ],
    [
      'a second, empty Subject after it',
      replaced('</saml:Subject>', '$&<saml:Subject/>'),
      ONE,
    ],
    [
      'a Subject of a foreign namespace after it',
      replaced(
        '</saml:Subject>',
        `$&<o:Subject xmlns:o="urn:o">${nameIdXml('id-root')}</o:Subject>`,
      ),
      ONE,
    ],
    // The NameID.
    ['no NameID', nameId(''), ONE],
    [
      'a NameID of another case',
      nameId(nameIdXml().replaceAll('NameID', 'nameid')),
      ONE,
    ],
    ['an empty NameID', nameId(nameIdXml('')), TEXT],
    [
      'an empty NameID element',
      nameId(`<saml:NameID${persistentAnd('')}/>`),
      TEXT,
    ],
    ['a NameID element with nothing', nameId('<saml:NameID/>'), FORMAT],
    ['the same NameID twice', nameId(nameIdXml() + nameIdXml()), ONE],
    [
      'a second NameID before it',
      nameId(nameIdXml('id-root') + nameIdXml()),
      ONE,
    ],
    ['an empty second NameID', nameId(`${nameIdXml()}<saml:NameID/>`), ONE],
    ['a NameID in the NameID', nameId(nameIdXml(nameIdXml())), TEXT],
    [
      'a NameID in the NameID, after its text',
      nameId(nameIdXml(`id-pat${nameIdXml('id-root')}`)),
      TEXT,
    ],
    ['an element splitting the text', nameId(nameIdXml('id-<o/>pat')), TEXT],
    ['an element before the text', nameId(nameIdXml('<o>x</o>id-pat')), TEXT],
    ...['constructor', 'toString', 'hasOwnProperty', 'cdata', 'xmlns'].map(
      (name): [string, Shape, RegExp] => [
        `an element named ${name}`,
        nameId(nameIdXml(`id-pat<${name}>x</${name}>`)),
        name.startsWith('xml') ? NAMES : TEXT,
      ],
    ),
    // Named as xml2js names what it makes of an element, or as an object's prototype.
    ...[
      '<_>x</_>id-pat',
      'id-<_/>pat',
      'id-pat<_>x</_>',
      '<o:_ xmlns:o="urn:o">x</o:_>id-pat',
      'id-pat<__proto__>x</__proto__>',
      'id-pat<o:__proto__ xmlns:o="urn:o"/>',
      'id-pat<_:o xmlns:_="urn:o"/>',
      'id-pat<\u00e9/>',
    ].map((text): [string, Shape, RegExp] => [
      `the content ${text}`,
      nameId(nameIdXml(text)),
      NAMES,
    ]),
    ...['_', '__proto__', 'xmlns:__proto__', 'xmlns:_'].map(
      (name): [string, Shape, RegExp] => [
        `an attribute named ${name}`,
        tampered('<saml:NameID', `$& ${name}="x"`),
        NAMES,
      ],
    ),
    [
      'such an element in an attribute',
      replaced('pat@example.org', '<_>root@example.org</_>$&'),
      NAMES,
    ],
    // A prefix xml2js leaves on, so it would not see the element for what it is.
    [
      'a second NameID with a prefix beginning with xmlns',
      nameId(
        `${nameIdXml()}<xmlnso:NameID xmlns:xmlnso="urn:o">id-root</xmlnso:NameID>`,
      ),
      NAMES,
    ],
    [
      'a second Subject with a prefix beginning with xmlns',
      replaced('</saml:Subject>', '$&<xmlnso:Subject xmlns:xmlnso="urn:o"/>'),
      NAMES,
    ],
    [
      'another NameID in text that XHTML makes elements of',
      hidden(
        (id, conf, hide) =>
          `<saml:Subject>${id}${conf}${hide(nameIdXml('id-root'))}</saml:Subject>`,
      ),
      XHTML,
    ],
    [
      'another Subject in text that XHTML makes elements of',
      hidden(
        (id, conf, hide) =>
          `<saml:Subject>${hide(`${nameIdXml('id-root')}${conf}<saml:Subject>`)}${id}${hide('</saml:Subject>')}${conf}</saml:Subject>`,
      ),
      XHTML,
    ],
    // Read as ending before what follows it by a reader that looks for `</samlp:X>`.
    [
      'another Subject in text that is XHTML only where an end tag holds a blank',
      displaced(
        hidden(
          (id, conf, hide) =>
            `<saml:Subject>${hide(`${nameIdXml('id-root')}${conf}<saml:Subject>`)}${id}${hide('</saml:Subject>')}${conf}</saml:Subject>`,
        ),
      ),
      NAMES,
    ],
    [
      'a blank in an end tag',
      tampered('</saml:NameID>', '</saml:NameID >'),
      NAMES,
    ],
    ['only a BaseID', nameId('<saml:BaseID NameQualifier="elsewhere"/>'), ONE],
    ['only an EncryptedID', nameId(ENCRYPTED), ONE],
    [
      'a NameID in an EncryptedID',
      nameId(`<saml:EncryptedID>${nameIdXml()}</saml:EncryptedID>`),
      ONE,
    ],
    [
      'the NameID only in the SubjectConfirmation',
      subject(
        (id, conf) =>
          `<saml:Subject>${conf.replace('<saml:SubjectConfirmationData', `${id}$&`)}</saml:Subject>`,
      ),
      ONE,
    ],
    [
      'the NameID only beside the Subject',
      subject((id, conf) => `<saml:Subject>${conf}</saml:Subject>${id}`),
      ONE,
    ],
    // The Format and the qualifiers.
    ['no Format', nameId(nameIdXml('id-pat', '')), FORMAT],
    ...[
      '',
      '  ',
      ` ${PERSISTENT}`,
      `${PERSISTENT}&#10;`,
      `${PERSISTENT}\u200b`,
      `${PERSISTENT} ${UNSPECIFIED}`,
      PERSISTENT.replace('urn', 'URN'),
      PERSISTENT.replace('2.0', '1.1'),
    ].map((format): [string, Shape, RegExp] => [
      `the Format ${JSON.stringify(format)}`,
      nameId(nameIdXml('id-pat', ` Format="${format}"`)),
      FORMAT,
    ]),
    [
      'a Format written in another case',
      nameId(nameIdXml('id-pat', ` format="${PERSISTENT}"`)),
      FORMAT,
    ],
    [
      'a Format only in a foreign namespace',
      nameId(nameIdXml('id-pat', ` o:Format="${PERSISTENT}" xmlns:o="urn:o"`)),
      FORMAT,
    ],
    [
      'a blank NameQualifier',
      nameId(nameIdXml('id-pat', persistentAnd(' NameQualifier=" "'))),
      NAME_QUALIFIER,
    ],
    [
      'a blank SPNameQualifier',
      nameId(nameIdXml('id-pat', persistentAnd(' SPNameQualifier=" "'))),
      SP_NAME_QUALIFIER,
    ],
    // Repeated attributes are no XML: written in after signing.
    [
      'a repeated Format',
      tampered(`Format="${PERSISTENT}"`, `$& Format="${UNSPECIFIED}"`),
      XML,
    ],
    [
      'a repeated qualifier',
      tampered(
        `Format="${PERSISTENT}"`,
        '$& NameQualifier="a" NameQualifier="b"',
      ),
      XML,
    ],
    // The text.
    ['a comment in the text', nameId(nameIdXml('id-<!-- -->pat')), PLAIN],
    ['a comment after the text', nameId(nameIdXml('id-pat<!-- -->')), PLAIN],
    [
      'a processing instruction in the text',
      nameId(nameIdXml('id-<?x?>pat')),
      PLAIN,
    ],
    ['a CDATA section', nameId(nameIdXml('<![CDATA[id-pat]]>')), PLAIN],
    [
      'a CDATA section after text',
      nameId(nameIdXml('id-<![CDATA[pat]]>')),
      PLAIN,
    ],
    [
      'an entity of its own DTD',
      {
        tamper: (xml) =>
          `<!DOCTYPE a [<!ENTITY p "id-pat">]>${xml.replace('>id-pat<', '>&p;<')}`,
      },
      PLAIN,
    ],
    ['an entity nobody declares', tampered('>id-pat<', '>id-pat&p;<'), XML],
    [
      'a character XML does not allow',
      tampered('>id-pat<', '>id-pat&#0;<'),
      XML,
    ],
    [
      'a line break as a character reference',
      nameId(nameIdXml('id-pat&#10;')),
      TEXT,
    ],
    [
      'a carriage return as a character reference',
      nameId(nameIdXml('id&#13;pat')),
      TEXT,
    ],
    [
      'the response signed too, with another issuer of its own',
      { signResponse: (xml) => xml.replace('</saml:Issuer>', 'x$&') },
      /Error: Unknown SAML issuer/,
    ],
    [
      'the response signed, the assertion not',
      { signWith: 'none', signResponse: (xml) => xml },
      SIGNATURE,
    ],
    // Several assertions, written in after signing.
    [
      'the signed assertion twice',
      wrapped((signed) => signed + signed),
      SEVERAL,
    ],
    [
      'another assertion before the signed one',
      wrapped((signed, _, forged) => forged + signed),
      SEVERAL,
    ],
    [
      'another assertion after the signed one',
      wrapped((signed, _, forged) => signed + forged),
      SEVERAL,
    ],
    [
      'another assertion in a foreign namespace',
      wrapped((signed) => `${signed}<o:Assertion xmlns:o="urn:o" ID="_o"/>`),
      SEVERAL,
    ],
    [
      'an encrypted assertion beside it',
      wrapped((signed) => `${signed}<saml:EncryptedAssertion/>`),
      SEVERAL,
    ],
    [
      'another assertion around the signed one',
      wrapped((signed, _, forged) =>
        forged.replace('</saml:Subject>', (found) => found + signed),
      ),
      SIGNATURE,
    ],
    [
      'another assertion in place of the signed one, kept aside',
      wrapped(
        (signed, _, forged) =>
          `${forged}<samlp:Extensions>${signed}</samlp:Extensions>`,
      ),
      SIGNATURE,
    ],
    [
      'another assertion with the signature, the signed one kept aside',
      wrapped(
        (signed, signature, forged) =>
          `${forged.replace('</saml:Issuer>', (found) => found + signature)}<samlp:Extensions>${signed.replace(signature, '')}</samlp:Extensions>`,
      ),
      NOT_ITS_PARENT,
    ],
    [
      'another assertion with the signature and the signed one’s ID, that kept aside',
      wrapped(
        (signed, signature, forged) =>
          `${forged.replace('_forged', / ID="([^"]*)"/.exec(signed)![1]!).replace('</saml:Issuer>', (found) => found + signature)}<samlp:Extensions>${signed.replace(signature, '')}</samlp:Extensions>`,
      ),
      SAME_ID,
    ],
    [
      'another assertion with the signature, the signed one in it',
      wrapped((signed, signature, forged) =>
        forged.replace(
          '</saml:Issuer>',
          (found) => found + signature + signed.replace(signature, ''),
        ),
      ),
      NOT_ITS_PARENT,
    ],
    [
      'another assertion with the signature, the signed one in the signature',
      wrapped((signed, signature, forged) =>
        forged.replace(
          '</saml:Issuer>',
          (found) =>
            found +
            signature.replace(
              '</Signature>',
              (end) =>
                `<Object>${signed.replace(signature, '')}</Object>${end}`,
            ),
        ),
      ),
      NOT_ITS_PARENT,
    ],
    [
      'another NameID before the signed assertion’s',
      tampered('<saml:NameID', `${nameIdXml('id-root')}$&`),
      SIGNATURE,
    ],
  ];

  it.each(refused)('%s: refused, and nothing made', (_, shape, why) =>
    expectRefused(shape, why),
  );

  describe('characters that do not show', () => {
    const text = (value: string): Shape => ({
      nameId: { value, format: PERSISTENT },
    });

    // Someone who could vary them, at a provider that passes on what is typed and looks people up
    // without them (RFC 4518 drops most), would be another user with each.
    it.each([
      '200b',
      '200c',
      '200d',
      '2060',
      'feff',
      'ad',
      '202e',
      'fe0f',
      '34f',
      '3164',
      'e0041',
      '180b',
      '1806',
      'fffc',
      '2028',
      '2029',
      '85',
      '7f',
      '9',
      'a',
    ])('U+%s, before, in or after the text: refused', async (code) => {
      // Signed as these two, they are read as line feeds: another text than the one signed.
      // Line ends XML does not know: refused before anything reads them.
      const why = ['85', '2028', '2029'].includes(code) ? SEPARATOR : TEXT;
      const char = `&#x${code};`;
      for (const value of [`${char}id-pat`, `id-${char}pat`, `id-pat${char}`]) {
        await expectRefused(nameId(nameIdXml(value)), why);
      }
      const raw = String.fromCodePoint(Number.parseInt(code, 16));
      // Raw, the test provider's signer reads U+0085 and U+2028 as line feeds.
      if (['85', '2028'].includes(code)) return;
      await expectRefused(text(`id-${raw}pat`), why);
    });

    it.each(['85', '2028'])(
      'U+%s as the reference it was signed as, which a reader takes for a line feed: refused',
      async (code) => {
        const raw = String.fromCodePoint(Number.parseInt(code, 16));
        await expectRefused(
          {
            ...nameId(nameIdXml(`id-&#x${code};pat`)),
            tamper: (xml) => xml.replace(raw, `&#x${code};`),
          },
          SEPARATOR,
        );
      },
    );

    it('a no-break space: refused around the text, another text in it', async () => {
      await expectRefused(text('\u00a0id-pat'), TEXT);
      await expectRefused(text('id-pat\u00a0'), TEXT);
      expect(await userOf(text('a\u00a0b'))).not.toBe(
        await userOf(text('a b')),
      );
    });

    // Left as they are: a directory may hold a name in any of these forms, whose person would be
    // locked out, and joining them could make two people one.
    it.each([
      ['composed and decomposed', '\u00e9', 'e\u0301'],
      ['a ligature', '\ufb01', 'fi'],
      ['full width', '\uff41', 'a'],
      ['another script', '\u0430', 'a'],
      ['another case', 'A', 'a'],
      ['two spaces', 'a  b', 'a b'],
    ])(
      '%s: two texts, two users, each time the same',
      async (_, one, other) => {
        const user = await userOf(text(`id-${one}`));
        expect(await userOf(text(`id-${other}`))).not.toBe(user);
        expect(await userOf(text(`id-${one}`))).toBe(user);
      },
    );
  });
});
