import { describe, expect, it } from 'vitest';
import {
  readXml,
  XML_NAMESPACE,
  XmlReadError,
  type XmlReadOptions,
} from './xml-read.js';

const refusal = (text: string, options?: XmlReadOptions) => {
  try {
    readXml(text, undefined, options);
  } catch (error) {
    if (error instanceof XmlReadError) return error.reason;
    throw error;
  }
  return undefined;
};

describe('readXml', () => {
  it('reads elements, attributes, text and namespaces', () => {
    const root = readXml(
      '<?xml version="1.0" encoding="UTF-8"?><a xmlns:x="urn:x" x:k="1" xml:lang="en">t<b/>&amp;</a>',
    );
    expect(root.local).toBe('a');
    expect(root.attributes.get('{urn:x}k')).toBe('1');
    expect(root.attributes.get(`{${XML_NAMESPACE}}lang`)).toBe('en');
    expect(root.children).toHaveLength(3);
  });

  it('gives the namespaces each element declares, read as values are', () => {
    const root = readXml(
      `<a xmlns="urn:a" b=' xmlns:c="urn:c"' xmlns:d='urn:&amp;d'><e xmlns=""/><f/></a>`,
    );
    expect([...root.declarations]).toEqual([
      ['', 'urn:a'],
      ['d', 'urn:&d'],
    ]);
    expect([...(root.children[0] as typeof root).declarations]).toEqual([
      ['', ''],
    ]);
    expect((root.children[1] as typeof root).declarations.size).toBe(0);
  });

  it('refuses a document type declaration and any entity but the predefined ones', () => {
    expect(refusal('<!DOCTYPE a><a/>')).toBe('dtd-forbidden');
    expect(refusal('<a>&nbsp;</a>')).toBe('dtd-forbidden');
    expect(refusal('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')).toBe(
      'unsupported-encoding',
    );
    expect(refusal('<a><b></a>')).toBe('not-well-formed');
  });

  describe('with doctype: external-id', () => {
    const ext = { doctype: 'external-id' } as const;

    it('skips a declaration with an external identifier, never opening it', () => {
      for (const doctype of [
        '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">',
        "<!DOCTYPE topic SYSTEM 'file:///etc/passwd'>",
        '<!DOCTYPE topic>',
        '<!DOCTYPE topic\n  PUBLIC "-//X//EN"\n  "http://example.invalid/x.dtd" >',
      ]) {
        const root = readXml(
          `<?xml version="1.0"?>\n${doctype}\n<topic id="t">x</topic>`,
          undefined,
          ext,
        );
        expect(root.local).toBe('topic');
        expect(root.children).toEqual(['x']);
      }
    });

    it('still refuses an internal subset, entities, a second declaration and one after the root', () => {
      expect(refusal('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', ext)).toBe(
        'dtd-forbidden',
      );
      expect(
        refusal(
          '<!DOCTYPE a SYSTEM "a.dtd" [<!ENTITY x SYSTEM "file:///etc/passwd">]><a/>',
          ext,
        ),
      ).toBe('dtd-forbidden');
      expect(refusal('<!DOCTYPE a PUBLIC "p" "s"><a>&x;</a>', ext)).toBe(
        'dtd-forbidden',
      );
      expect(refusal('<!DOCTYPE a><!DOCTYPE a><a/>', ext)).toBe(
        'dtd-forbidden',
      );
      expect(refusal('<a><!DOCTYPE a></a>', ext)).toBe('dtd-forbidden');
      expect(refusal('<!ENTITY x "y"><a/>', ext)).toBe('dtd-forbidden');
      expect(refusal('<!DOCTYPE a PUBLIC "p{" "s"><a/>', ext)).toBe(
        'not-well-formed',
      );
      expect(refusal('<!DOCTYPE a PUBLIC "p"><a/>', ext)).toBe(
        'not-well-formed',
      );
      expect(refusal('<!DOCTYPE a SYSTEM "s"', ext)).toBe('not-well-formed');
    });

    it('is off by default', () => {
      expect(refusal('<!DOCTYPE a PUBLIC "p" "s"><a/>')).toBe('dtd-forbidden');
    });
  });
});
