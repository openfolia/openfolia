import {
  IIRDS_DOCUMENT_TYPES,
  IIRDS_INFORMATION_SUBJECTS,
  IIRDS_LIFECYCLE_PHASES,
  IIRDS_PRODUCT_CLASSES,
  IIRDS_QUALIFICATION_CLASSES,
  IIRDS_TOPIC_TYPES,
} from '@openfolia/content-model';
import {
  iirdsSchema,
  instancesOf,
  isA,
  schemaProblems,
} from '../../../tests/iirds/iirds-schema.js';
import {
  escapeXml,
  iirdsMetadata,
  type IirdsPackageMetadata,
} from './iirds-metadata.js';
import { iriSegment, iirdsFileName, mediaExtension } from './iirds-package.js';

const base = 'https://docs.example.com/iirds/';
const doc = `${base}releases/r1/manuals/operating/model%3Dsmall/en`;

const metadata: IirdsPackageMetadata = {
  package: {
    iri: `${base}releases/r1/packages/operating/model%3Dsmall/en`,
    title: 'Operating & <care> "manual"',
    lang: 'en',
    revision: '2.1',
    createdAt: new Date('2026-03-01T10:00:00.123Z'),
  },
  document: {
    iri: doc,
    objectIri: `${base}manuals/operating`,
    title: 'Operating & <care> "manual"',
    lang: 'en',
    revision: '2.1',
    documentTypes: ['OperatingInstructions'],
    status: { value: 'Released', at: new Date('2026-03-01T10:00:00Z') },
    pdf: { source: 'pdf/operating.pdf' },
    instances: [
      { iri: `${base}audiences/public`, class: 'Role', label: 'Public' },
    ],
    lifecyclePhases: [],
  },
  topics: [
    {
      iri: `${doc}/modules/intro`,
      objectIri: `${base}modules/intro`,
      title: "It's ]]> here\u0001",
      lang: 'en',
      source: 'content/intro.html',
      topicType: 'GenericConcept',
      subjects: ['SafetyInstruction'],
      instances: [
        { iri: `${base}audiences/public`, class: 'Role', label: 'Public' },
        {
          iri: `${base}facets/region/north`,
          class: 'ProductVariant',
          label: 'Region: North',
        },
      ],
      lifecyclePhases: ['Operation', 'Operation'],
    },
    {
      iri: `${doc}/modules/steps`,
      objectIri: `${base}modules/steps`,
      title: 'Steps',
      lang: 'de',
      source: 'content/steps.html',
      subjects: [],
      instances: [],
      lifecyclePhases: [],
    },
  ],
  toc: [
    { kind: 'topic', topic: `${doc}/modules/intro` },
    {
      kind: 'group',
      title: 'Use <it>',
      children: [{ kind: 'topic', topic: `${doc}/modules/steps` }],
    },
  ],
  instances: [
    { iri: `${base}audiences/public`, class: 'Role', label: 'Public' },
    {
      iri: `${base}facets/region/north`,
      class: 'ProductVariant',
      label: 'Region: North',
    },
  ],
};

describe('the iiRDS vocabulary', () => {
  it('names exactly the instances and classes the vendored schema defines', () => {
    const s = iirdsSchema();
    expect([...IIRDS_TOPIC_TYPES].sort()).toEqual(
      instancesOf(s, 'TopicType').filter((t) => t.startsWith('Generic')),
    );
    expect([...IIRDS_DOCUMENT_TYPES].sort()).toEqual(
      instancesOf(s, 'DocumentType'),
    );
    expect([...IIRDS_LIFECYCLE_PHASES].sort()).toEqual(
      instancesOf(s, 'ProductLifeCyclePhase'),
    );
    expect([...IIRDS_INFORMATION_SUBJECTS].sort()).toEqual(
      instancesOf(s, 'InformationSubject'),
    );
    for (const c of IIRDS_PRODUCT_CLASSES) {
      expect(isA(s, c, 'ProductMetadata'), c).toBe(true);
    }
    for (const c of IIRDS_QUALIFICATION_CLASSES) {
      expect(isA(s, c, 'Qualification'), c).toBe(true);
    }
  });
});

describe('iirdsMetadata', () => {
  it('writes metadata the schema allows, every text escaped', () => {
    const xml = iirdsMetadata(metadata);
    expect(schemaProblems(xml)).toEqual([]);
    expect(xml).toContain(
      '<iirds:title xml:lang="en">Operating &amp; &lt;care&gt; &quot;manual&quot;</iirds:title>',
    );
    expect(xml).toContain('It&apos;s ]]&gt; here�');
    expect(xml).toContain('<iirds:dateOfCreation>2026-03-01T10:00:00Z<');
    // Declared once, related once.
    expect(xml.match(/<iirds:Role /g)).toHaveLength(1);
    expect(xml.match(/relates-to-product-lifecycle-phase/g)).toHaveLength(1);
    // The same input makes the same text.
    expect(iirdsMetadata(metadata)).toBe(xml);
  });

  it('finds a property outside its domain, a relative IRI and an undeclared information object', () => {
    const xml = iirdsMetadata(metadata);
    expect(
      schemaProblems(
        xml.replace(
          '<iirds:has-topic-type',
          '<iirds:has-document-type rdf:resource="http://iirds.tekom.de/iirds#Manual"/><iirds:has-topic-type',
        ),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      schemaProblems(xml.replace(`rdf:about="${doc}"`, 'rdf:about="relative"')),
    ).toContain('relative rdf:about "relative"');
    expect(
      schemaProblems(
        xml.replace(
          `<iirds:InformationObject rdf:about="${base}modules/steps"/>`,
          '',
        ),
      ),
    ).toContain(
      `is-version-of names ${base}modules/steps, no information object of the package`,
    );
  });

  it('escapes what XML cannot hold', () => {
    expect(escapeXml('a\rb\tc\u0000d￾e\n')).toBe('a&#13;b&#9;c�d�e\n');
    expect(escapeXml('\uD800x')).toBe('�x');
  });
});

describe('the package names', () => {
  it('makes IRI segments no consumer resolves away, and file names of safe characters', () => {
    expect(iriSegment('model=large,software=2.0')).toBe(
      'model%3Dlarge%2Csoftware%3D2.0',
    );
    expect(iriSegment('')).toBe('-');
    expect(iriSegment('..')).toBe('%2E%2E');
    expect(iriSegment('a/b')).toBe('a%2Fb');
    expect(
      iirdsFileName(
        { manualId: 'operating', variant: 'model=large', lang: 'en' },
        '2.1',
      ),
    ).toBe('operating_model-large_en_2.1.iirds');
    expect(mediaExtension('image/png')).toBe('.png');
    expect(mediaExtension('constructor')).toBe('.bin');
  });
});
