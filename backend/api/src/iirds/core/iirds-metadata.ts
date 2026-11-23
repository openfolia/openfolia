import {
  IIRDS_NAMESPACE,
  IIRDS_VERSION,
  type IirdsDocumentType,
  type IirdsInformationSubject,
  type IirdsLifecyclePhase,
  type IirdsProductClass,
  type IirdsQualificationClass,
  type IirdsTopicType,
} from '@openfolia/content-model';

/**
 * The metadata of one iiRDS package (#431), as `iirdsMetadata` writes it to
 * `META-INF/metadata.rdf`: the package, the manual as an `iirds:Document`
 * (its PDF as a rendition), each module of it as an `iirds:Topic` (its HTML
 * file as a rendition), the manual's table of contents as
 * `iirds:DirectoryNode`s, and the product metadata and qualifications they
 * relate to. Every IRI is absolute (made under the configured base IRI);
 * every text is escaped when written.
 */
export interface IirdsPackageMetadata {
  readonly package: {
    readonly iri: string;
    readonly title: string;
    readonly lang: string;
    readonly revision: string;
    /** When the release was published: the package's date of creation. */
    readonly createdAt: Date;
  };
  readonly document: IirdsDocument;
  readonly topics: readonly IirdsTopic[];
  /** The manual's structure: groups and modules in order; empty, no table of contents at all (#551). */
  readonly toc: readonly TocNode[];
  /** The instances the units relate to, each declared once (by IRI). */
  readonly instances: readonly IirdsInstance[];
}

/** Product metadata or a qualification of the project's own, declared in the package. */
export interface IirdsInstance {
  readonly iri: string;
  readonly class: IirdsProductClass | IirdsQualificationClass;
  readonly label: string;
}

/** What a unit relates to, by the instance's IRI. */
export interface Relations {
  readonly instances: readonly IirdsInstance[];
  readonly lifecyclePhases: readonly IirdsLifecyclePhase[];
}

export interface IirdsDocument extends Relations {
  readonly iri: string;
  /** The version- and language-independent manual (`iirds:InformationObject`). */
  readonly objectIri: string;
  readonly title: string;
  readonly lang: string;
  readonly revision: string;
  readonly documentTypes: readonly IirdsDocumentType[];
  /** `Released`, or `Withdrawn` for a withdrawn release; dated with when that happened. */
  readonly status: {
    readonly value: 'Released' | 'Withdrawn';
    readonly at: Date;
  };
  /** The PDF in the package, when there is one. */
  readonly pdf?: { readonly source: string } | undefined;
}

export interface IirdsTopic extends Relations {
  readonly iri: string;
  /** The version- and language-independent module (`iirds:InformationObject`). */
  readonly objectIri: string;
  readonly title: string;
  /** The language of the module's text (the source language where it was not translated). */
  readonly lang: string;
  /** Its HTML file in the package. */
  readonly source: string;
  readonly topicType?: IirdsTopicType | undefined;
  readonly subjects: readonly IirdsInformationSubject[];
}

/** One entry of the table of contents: a module (its topic) or a titled group. */
export type TocNode =
  | { readonly kind: 'topic'; readonly topic: string }
  | {
      readonly kind: 'group';
      readonly title: string;
      readonly children: readonly TocNode[];
    };

/** The property relating a unit to an instance of a class. */
const RELATION: Record<IirdsInstance['class'], string> = {
  ProductVariant: 'relates-to-product-variant',
  Component: 'relates-to-component',
  ProductFunction: 'relates-to-product-feature',
  ProductProperty: 'relates-to-product-feature',
  Role: 'relates-to-qualification',
  SkillLevel: 'relates-to-qualification',
};

/**
 * Text as XML 1.0 carries it, in element content and in quoted
 * attributes: `&`, `<`, `>`, `"` and `'` escaped, a carriage return and a
 * tab as character references (so they read back), and any character XML
 * 1.0 cannot hold (other control characters, lone surrogates, U+FFFE and
 * U+FFFF) as U+FFFD.
 */
export function escapeXml(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&apos;';
        break;
      case '\r':
        out += '&#13;';
        break;
      case '\t':
        out += '&#9;';
        break;
      default:
        out +=
          (code < 0x20 && code !== 0x0a) ||
          (code >= 0xd800 && code <= 0xdfff) ||
          code === 0xfffe ||
          code === 0xffff
            ? '�'
            : ch;
    }
  }
  return out;
}

const iirds = (name: string) => `${IIRDS_NAMESPACE}${name}`;

/** A date as `xsd:dateTimeStamp`, to the second, in UTC. */
const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * `META-INF/metadata.rdf` (RDF 1.1 XML syntax) for `metadata`: the same
 * input always gives the same text. Elements in a fixed order: the
 * package, the instances (by IRI), the information objects, the document,
 * the topics (in the manual's order), the directory nodes.
 */
export function iirdsMetadata(metadata: IirdsPackageMetadata): string {
  const lines: string[] = [];
  const out = (indent: number, line: string) =>
    lines.push(`${'  '.repeat(indent)}${line}`);
  const resource = (indent: number, property: string, iri: string) =>
    out(indent, `<iirds:${property} rdf:resource="${escapeXml(iri)}"/>`);
  const literal = (
    indent: number,
    property: string,
    text: string,
    lang?: string,
  ) =>
    out(
      indent,
      `<iirds:${property}${lang === undefined ? '' : ` xml:lang="${escapeXml(lang)}"`}>${escapeXml(text)}</iirds:${property}>`,
    );
  const relations = (unit: Relations) => {
    const seen = new Set<string>();
    for (const instance of unit.instances) {
      if (seen.has(instance.iri)) continue;
      seen.add(instance.iri);
      resource(2, RELATION[instance.class], instance.iri);
    }
    for (const phase of new Set(unit.lifecyclePhases)) {
      resource(2, 'relates-to-product-lifecycle-phase', iirds(phase));
    }
  };
  const rendition = (format: string, source: string) => {
    out(2, '<iirds:has-rendition>');
    out(3, '<iirds:Rendition>');
    literal(4, 'format', format);
    literal(4, 'source', source);
    out(3, '</iirds:Rendition>');
    out(2, '</iirds:has-rendition>');
  };

  const { package: pkg, document: doc } = metadata;
  out(0, '<?xml version="1.0" encoding="UTF-8"?>');
  out(
    0,
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:iirds="${IIRDS_NAMESPACE}">`,
  );

  out(1, `<iirds:Package rdf:about="${escapeXml(pkg.iri)}">`);
  literal(2, 'iiRDSVersion', IIRDS_VERSION);
  literal(2, 'title', pkg.title, pkg.lang);
  literal(2, 'language', pkg.lang);
  literal(2, 'revision', pkg.revision);
  literal(2, 'dateOfCreation', stamp(pkg.createdAt));
  out(1, '</iirds:Package>');

  const instances = new Map<string, IirdsInstance>();
  for (const instance of metadata.instances) {
    if (!instances.has(instance.iri)) instances.set(instance.iri, instance);
  }
  for (const iri of [...instances.keys()].sort()) {
    const instance = instances.get(iri) as IirdsInstance;
    out(1, `<iirds:${instance.class} rdf:about="${escapeXml(iri)}">`);
    out(2, `<rdfs:label>${escapeXml(instance.label)}</rdfs:label>`);
    out(1, `</iirds:${instance.class}>`);
  }

  const objects = [
    doc.objectIri,
    ...new Set(metadata.topics.map((t) => t.objectIri)),
  ];
  for (const iri of new Set(objects)) {
    out(1, `<iirds:InformationObject rdf:about="${escapeXml(iri)}"/>`);
  }

  out(1, `<iirds:Document rdf:about="${escapeXml(doc.iri)}">`);
  literal(2, 'title', doc.title, doc.lang);
  literal(2, 'language', doc.lang);
  literal(2, 'revision', doc.revision);
  resource(2, 'is-version-of', doc.objectIri);
  resource(2, 'is-part-of-package', pkg.iri);
  for (const type of doc.documentTypes) {
    resource(2, 'has-document-type', iirds(type));
  }
  out(2, '<iirds:has-content-lifecycle-status>');
  out(3, '<iirds:ContentLifeCycleStatus>');
  resource(4, 'has-content-lifecycle-status-value', iirds(doc.status.value));
  literal(4, 'dateOfStatus', stamp(doc.status.at));
  out(3, '</iirds:ContentLifeCycleStatus>');
  out(2, '</iirds:has-content-lifecycle-status>');
  relations(doc);
  if (doc.pdf) rendition('application/pdf', doc.pdf.source);
  out(1, '</iirds:Document>');

  const written = new Set<string>();
  for (const topic of metadata.topics) {
    if (written.has(topic.iri)) continue;
    written.add(topic.iri);
    out(1, `<iirds:Topic rdf:about="${escapeXml(topic.iri)}">`);
    literal(2, 'title', topic.title, topic.lang);
    literal(2, 'language', topic.lang);
    literal(2, 'revision', doc.revision);
    resource(2, 'is-version-of', topic.objectIri);
    resource(2, 'is-part-of-package', pkg.iri);
    if (topic.topicType) resource(2, 'has-topic-type', iirds(topic.topicType));
    for (const subject of new Set(topic.subjects)) {
      resource(2, 'has-subject', iirds(subject));
    }
    relations(topic);
    rendition('text/html', topic.source);
    out(1, '</iirds:Topic>');
  }

  // The table of contents: a root node for the document, each level a
  // linked list closed by `iirds:nil`, every node with its own IRI.
  let next = 0;
  const nodeIri = () => `${doc.iri}/toc/${++next}`;
  const root = `${doc.iri}/toc`;
  const level = (nodes: readonly TocNode[]): string | undefined => {
    const iris = nodes.map(() => nodeIri());
    nodes.forEach((node, i) => {
      const iri = iris[i] as string;
      const child = node.kind === 'group' ? level(node.children) : undefined;
      out(1, `<iirds:DirectoryNode rdf:about="${escapeXml(iri)}">`);
      if (node.kind === 'group') {
        out(
          2,
          `<rdfs:label xml:lang="${escapeXml(doc.lang)}">${escapeXml(node.title)}</rdfs:label>`,
        );
      } else {
        resource(2, 'relates-to-information-unit', node.topic);
      }
      if (child !== undefined) resource(2, 'has-first-child', child);
      resource(2, 'has-next-sibling', iris[i + 1] ?? iirds('nil'));
      out(1, '</iirds:DirectoryNode>');
    });
    return iris[0];
  };
  const first = level(metadata.toc);
  // No table of contents without an entry (#551): a root node with no
  // child is not one the standard allows.
  if (first === undefined) {
    out(0, '</rdf:RDF>');
    return `${lines.join('\n')}\n`;
  }
  out(1, `<iirds:DirectoryNode rdf:about="${escapeXml(root)}">`);
  out(
    2,
    `<rdfs:label xml:lang="${escapeXml(doc.lang)}">${escapeXml(doc.title)}</rdfs:label>`,
  );
  resource(2, 'relates-to-information-unit', doc.iri);
  resource(2, 'has-directory-structure-type', iirds('TableOfContents'));
  resource(2, 'has-first-child', first);
  resource(2, 'has-next-sibling', iirds('nil'));
  out(1, '</iirds:DirectoryNode>');

  out(0, '</rdf:RDF>');
  return `${lines.join('\n')}\n`;
}
