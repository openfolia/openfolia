/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/**
 * The iiRDS RDF schema (`vendor/iirds-schema/iirds-core.rdf`, the iiRDS
 * Consortium's, vendored unchanged; see `vendor/README.md`), read for
 * checking packages against it: its classes (with their superclasses),
 * properties (domain, range, cardinalities) and the instances it defines.
 */
const NS = 'http://iirds.tekom.de/iirds#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

export interface IirdsSchema {
  /** Class → its direct superclasses (local names in the iiRDS namespace). */
  readonly classes: ReadonlyMap<string, readonly string[]>;
  readonly properties: ReadonlyMap<
    string,
    {
      readonly domains: readonly string[];
      /** Local names for iiRDS classes; full IRIs for anything else (literals, XSD types). */
      readonly ranges: readonly string[];
      readonly cardinalities: readonly {
        readonly class: string;
        readonly min: number;
        readonly max: number;
      }[];
    }
  >;
  /** Instance → its class. */
  readonly instances: ReadonlyMap<string, string>;
}

let schema: IirdsSchema | undefined;

const local = (iri: string | null) =>
  iri?.startsWith(NS) ? iri.slice(NS.length) : (iri ?? '');

export function iirdsSchema(): IirdsSchema {
  if (schema) return schema;
  const text = readFileSync(
    new URL('./vendor/iirds-schema/iirds-core.rdf', import.meta.url),
    'utf8',
  );
  const { window } = new JSDOM('');
  const doc = new window.DOMParser().parseFromString(text, 'application/xml');
  const classes = new Map<string, string[]>();
  const properties = new Map<
    string,
    {
      domains: string[];
      ranges: string[];
      cardinalities: { class: string; min: number; max: number }[];
    }
  >();
  const instances = new Map<string, string>();
  for (const el of Array.from(doc.documentElement.children)) {
    const about = el.getAttributeNS(RDF, 'about');
    if (!about?.startsWith(NS)) continue;
    const name = local(about);
    const refs = (ns: string, tag: string) =>
      Array.from(el.children)
        .filter((c) => c.namespaceURI === ns && c.localName === tag)
        .map((c) => c.getAttributeNS(RDF, 'resource') ?? '');
    if (el.namespaceURI === RDFS && el.localName === 'Class') {
      classes.set(name, refs(RDFS, 'subClassOf').map(local));
    } else if (el.namespaceURI === RDF && el.localName === 'Property') {
      const cardinalities = Array.from(el.children)
        .filter((c) => c.namespaceURI === NS && c.localName === 'description')
        .flatMap((c) => {
          const m = /^Cardinality:\s*(\S+)\s*\[(\d+)(?:\.\.(\d+|\*))?\]/.exec(
            c.textContent?.trim() ?? '',
          );
          if (!m) return [];
          const min = Number(m[2]);
          const max =
            m[3] === undefined ? min : m[3] === '*' ? Infinity : Number(m[3]);
          return [{ class: local(m[1] as string), min, max }];
        });
      properties.set(name, {
        domains: refs(RDFS, 'domain').map(local),
        ranges: refs(RDFS, 'range').map(local),
        cardinalities,
      });
    } else if (el.namespaceURI === NS) {
      instances.set(name, el.localName);
    }
  }
  schema = { classes, properties, instances };
  return schema;
}

/** Whether class `name` is `of` or one of its subclasses. */
export function isA(s: IirdsSchema, name: string, of: string): boolean {
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (next === of) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(s.classes.get(next) ?? []));
  }
  return false;
}

/** The instances the schema defines of class `of` (or its subclasses), sorted. */
export function instancesOf(s: IirdsSchema, of: string): string[] {
  return [...s.instances]
    .filter(([, cls]) => isA(s, cls, of))
    .map(([name]) => name)
    .sort();
}

/**
 * What in an iiRDS package's `metadata.rdf` the schema does not allow:
 * an element of the iiRDS namespace that is no class or property of it; a
 * property on a node outside its domain; an object outside its range (a
 * resource where a literal belongs, an instance or node of another class);
 * an iiRDS resource the schema does not define; a node with more or fewer
 * values of a property than its cardinality; an `is-version-of` naming no
 * information object of the package; a relative `rdf:about`. Empty when
 * all of it holds.
 */
export function schemaProblems(xml: string): string[] {
  const s = iirdsSchema();
  const { window } = new JSDOM('');
  const doc = new window.DOMParser().parseFromString(xml, 'application/xml');
  const problems: string[] = [];
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return ['not well-formed XML'];
  }
  const root = doc.documentElement;
  if (root.namespaceURI !== RDF || root.localName !== 'RDF') {
    return ['the root is not rdf:RDF'];
  }
  const declared = new Map<string, string>();
  const nodes: Element[] = [];
  const collect = (el: Element) => {
    // A node element; its children are property elements, whose element children are nodes again.
    nodes.push(el);
    const about = el.getAttributeNS(RDF, 'about');
    if (about !== null && el.namespaceURI === NS) {
      declared.set(about, el.localName);
    }
    for (const property of Array.from(el.children)) {
      for (const child of Array.from(property.children)) collect(child);
    }
  };
  for (const el of Array.from(root.children)) collect(el);

  const classOf = (iri: string): string | undefined => {
    if (declared.has(iri)) return declared.get(iri);
    if (!iri.startsWith(NS)) return undefined;
    const name = local(iri);
    if (s.instances.has(name)) return s.instances.get(name);
    // `iirds:nil` is a class used as a node (the end of a list).
    if (s.classes.has(name)) return name;
    return undefined;
  };

  for (const node of nodes) {
    const about = node.getAttributeNS(RDF, 'about');
    if (about !== null && !/^[a-z][a-z0-9+.-]*:/i.test(about)) {
      problems.push(`relative rdf:about "${about}"`);
    }
    if (node.namespaceURI !== NS) continue;
    const cls = node.localName;
    if (!s.classes.has(cls)) {
      problems.push(`iirds:${cls} is no class of the schema`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const property of Array.from(node.children)) {
      if (property.namespaceURI !== NS) continue;
      const name = property.localName;
      const def = s.properties.get(name);
      if (!def) {
        problems.push(`iirds:${name} is no property of the schema`);
        continue;
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (def.domains.length > 0 && !def.domains.some((d) => isA(s, cls, d))) {
        problems.push(`iirds:${name} on iirds:${cls}, outside its domain`);
      }
      const resource = property.getAttributeNS(RDF, 'resource');
      const nested = property.children[0];
      const literalRange = def.ranges.some(
        (r) => r.includes('#') || r.includes('/'),
      );
      const target =
        resource !== null
          ? classOf(resource)
          : nested && nested.namespaceURI === NS
            ? nested.localName
            : undefined;
      if (
        resource !== null &&
        resource.startsWith(NS) &&
        classOf(resource) === undefined
      ) {
        problems.push(
          `iirds:${name} names ${resource}, which the schema does not define`,
        );
      }
      if (literalRange) {
        if (resource !== null || nested) {
          problems.push(`iirds:${name} on iirds:${cls} takes a literal`);
        }
      } else if (def.ranges.length > 0 && (resource !== null || nested)) {
        if (target === undefined) {
          problems.push(
            `iirds:${name} on iirds:${cls} names ${resource ?? 'a node'} of no known class`,
          );
        } else if (!def.ranges.some((r) => isA(s, target, r))) {
          problems.push(
            `iirds:${name} on iirds:${cls} names an iirds:${target}, outside its range`,
          );
        }
      } else if (def.ranges.length > 0 && resource === null && !nested) {
        problems.push(`iirds:${name} on iirds:${cls} takes a resource`);
      }
    }
    for (const [name, def] of s.properties) {
      for (const c of def.cardinalities) {
        if (!isA(s, cls, c.class)) continue;
        const n = counts.get(name) ?? 0;
        if (n < c.min || n > c.max) {
          problems.push(
            `iirds:${cls} has ${n} iirds:${name}, not [${c.min}..${c.max}]`,
          );
        }
      }
    }
  }
  for (const el of Array.from(
    doc.getElementsByTagNameNS(NS, 'is-version-of'),
  )) {
    const target = el.getAttributeNS(RDF, 'resource') ?? '';
    if (declared.get(target) !== 'InformationObject') {
      problems.push(
        `is-version-of names ${target}, no information object of the package`,
      );
    }
  }
  return problems;
}
