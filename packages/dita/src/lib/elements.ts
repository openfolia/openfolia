import { XML_NAMESPACE, type XmlElement, type XmlNode } from '@openfolia/xml';

/** The DITA architectural namespace (`ditaarch:DITAArchVersion`). */
export const DITA_ARCH_NAMESPACE =
  'http://dita.oasis-open.org/architecture/2005/';

/**
 * Every element of the OASIS DITA 1.3 document types the import reads
 * (base, technical content, the hazard statement, highlighting, software,
 * programming, user interface and utilities domains, maps and bookmaps,
 * DITAVAL). An element not in this list is a specialisation (read as the
 * element its `@class` names, when it has one) or unknown.
 */
// prettier-ignore
export const KNOWN_ELEMENTS: ReadonlySet<string> = new Set([
  // Topics
  'topic', 'concept', 'task', 'reference', 'troubleshooting', 'glossentry',
  'glossgroup', 'dita', 'title', 'titlealts', 'navtitle', 'searchtitle',
  'shortdesc', 'abstract', 'prolog', 'body', 'conbody', 'taskbody',
  'refbody', 'troublebody', 'glossterm', 'glossdef', 'glossBody',
  'related-links', 'link', 'linktext', 'linklist', 'linkpool', 'linkinfo',
  'desc',
  // Prolog
  'metadata', 'keywords', 'keyword', 'author', 'source', 'publisher',
  'copyright', 'copyryear', 'copyrholder', 'critdates', 'created', 'revised',
  'permissions', 'audience', 'category', 'prodinfo', 'prodname', 'vrmlist',
  'vrm', 'brand', 'series', 'platform', 'prognum', 'featnum', 'component',
  'othermeta', 'resourceid', 'data', 'data-about', 'foreign', 'unknown',
  // Blocks
  'p', 'ul', 'ol', 'li', 'sl', 'sli', 'dl', 'dlhead', 'dthd', 'ddhd',
  'dlentry', 'dt', 'dd', 'note', 'lq', 'pre', 'lines', 'codeblock', 'screen',
  'msgblock', 'fig', 'figgroup', 'image', 'alt', 'longdescref', 'object',
  'param', 'section', 'sectiondiv', 'example', 'bodydiv', 'div',
  'simpletable', 'sthead', 'strow', 'stentry', 'table', 'tgroup', 'colspec',
  'spanspec', 'thead', 'tbody', 'row', 'entry', 'draft-comment',
  'required-cleanup', 'fn', 'indexterm', 'index-base', 'indextermref',
  'index-see', 'index-see-also', 'index-sort-as', 'sort-as', 'imagemap',
  'area', 'shape', 'coords', 'parml', 'plentry', 'pt', 'pd', 'syntaxdiagram',
  // Task
  'prereq', 'context', 'steps', 'steps-unordered', 'steps-informal',
  'stepsection', 'step', 'cmd', 'info', 'substeps', 'substep', 'stepxmp',
  'stepresult', 'steptroubleshooting', 'tutorialinfo', 'choices', 'choice',
  'choicetable', 'chhead', 'choptionhd', 'chdeschd', 'chrow', 'choption',
  'chdesc', 'result', 'postreq', 'tasktroubleshooting',
  // Reference
  'refsyn', 'properties', 'prophead', 'proptypehd', 'propvaluehd',
  'propdeschd', 'property', 'proptype', 'propvalue', 'propdesc',
  // Troubleshooting
  'troubleSolution', 'condition', 'cause', 'remedy', 'responsibleParty',
  // Hazard statement
  'hazardstatement', 'messagepanel', 'typeofhazard', 'consequence',
  'howtoavoid', 'hazardsymbol',
  // Inline
  'ph', 'b', 'i', 'u', 'tt', 'sup', 'sub', 'line-through', 'overline', 'q',
  'cite', 'term', 'tm', 'xref', 'text', 'abbreviated-form', 'boolean',
  'state', 'codeph', 'kwd', 'var', 'synph', 'oper', 'delim', 'sep',
  'repsep', 'option', 'parmname', 'apiname', 'filepath', 'msgph', 'msgnum',
  'cmdname', 'varname', 'userinput', 'systemoutput', 'uicontrol',
  'wintitle', 'menucascade', 'shortcut', 'screen', 'markupname',
  'numcharref', 'parameterentity', 'textentity', 'xmlatt', 'xmlelement',
  'xmlnsname', 'xmlpi',
  // Maps
  'map', 'bookmap', 'topicref', 'topichead', 'topicgroup', 'mapref',
  'keydef', 'topicset', 'topicsetref', 'anchor', 'anchorref', 'navref',
  'topicmeta', 'reltable', 'relheader', 'relcolspec', 'relrow', 'relcell',
  'ditavalref', 'ditavalmeta', 'dvrResourcePrefix', 'dvrResourceSuffix',
  'dvrKeyscopePrefix', 'dvrKeyscopeSuffix', 'booktitle', 'mainbooktitle',
  'booktitlealt', 'bookmeta', 'frontmatter', 'backmatter', 'chapter',
  'appendix', 'appendices', 'part', 'preface', 'notices', 'amendments',
  'colophon', 'dedication', 'draftintro', 'abbrevlist', 'bibliolist',
  'booklist', 'booklists', 'figurelist', 'glossarylist', 'indexlist',
  'tablelist', 'toc', 'trademarklist', 'bookabstract',
  // DITAVAL
  'val', 'prop', 'revprop', 'startflag', 'endflag', 'alt-text',
  'style-conflict',
]);

/** The topic elements of the OASIS document types. */
export const TOPIC_ELEMENTS: ReadonlySet<string> = new Set([
  'topic',
  'concept',
  'task',
  'reference',
  'troubleshooting',
  'glossentry',
  'glossgroup',
]);

/** The tokens of `@class` (`- topic/p mydomain/mypara `) from the most specialised, element names only. */
function classNames(element: XmlElement): readonly string[] {
  const cached = CLASS_NAMES.get(element);
  if (cached) return cached;
  const value = element.attributes.get('class');
  const names =
    value === undefined
      ? []
      : value
          .trim()
          .split(/\s+/)
          .filter((token) => token.includes('/'))
          .map((token) => token.slice(token.indexOf('/') + 1))
          .reverse();
  CLASS_NAMES.set(element, names);
  return names;
}
/** Each element's `@class` names, split once (an element is classified many times). */
const CLASS_NAMES = new WeakMap<XmlElement, readonly string[]>();

/**
 * The element `element` is read as: its own name when the import knows it,
 * else the most specialised ancestor its `@class` names that the import
 * knows (a specialisation, generalised), else undefined (unknown).
 */
export function nameOf(element: XmlElement): string | undefined {
  if (element.ns !== undefined) return undefined;
  if (KNOWN_ELEMENTS.has(element.local)) return element.local;
  return classNames(element).find((name) => KNOWN_ELEMENTS.has(name));
}

/** Whether `element` is a topic (of any type, specialised ones included). */
export function isTopic(element: XmlElement): boolean {
  const name = nameOf(element);
  if (name !== undefined && TOPIC_ELEMENTS.has(name)) return true;
  return element.attributes.get('class')?.includes(' topic/topic ') ?? false;
}

/** The attribute `name` (no namespace), undefined when missing. */
export const attr = (element: XmlElement, name: string) =>
  element.attributes.get(name);

/** `xml:lang`, when the element carries one. */
export const langOf = (element: XmlElement) =>
  element.attributes.get(`{${XML_NAMESPACE}}lang`);

/** The element children. */
export const elements = (element: XmlElement): XmlElement[] =>
  element.children.filter((c): c is XmlElement => typeof c !== 'string');

/** The first child read as `name`. */
export function child(
  element: XmlElement,
  name: string,
): XmlElement | undefined {
  return elements(element).find((c) => nameOf(c) === name);
}

/** The children read as `name`. */
export const childrenNamed = (element: XmlElement, name: string) =>
  elements(element).filter((c) => nameOf(c) === name);

/** All the text in `node`, in document order, whitespace as it is. */
export function textOf(node: XmlNode): string {
  if (typeof node === 'string') return node;
  let out = '';
  const stack: XmlNode[] = [node];
  while (stack.length > 0) {
    const next = stack.pop() as XmlNode;
    if (typeof next === 'string') {
      out += next;
      continue;
    }
    for (let i = next.children.length - 1; i >= 0; i--) {
      stack.push(next.children[i] as XmlNode);
    }
  }
  return out;
}

/** Text with each run of whitespace one space, none at either end. */
export const collapse = (text: string) =>
  text.replace(/[ \t\r\n]+/g, ' ').trim();

/** The tokens of an attribute that holds a list (`@keys`, `@outputclass`). */
export const tokens = (value: string | undefined): string[] =>
  value === undefined ? [] : value.trim().split(/\s+/).filter(Boolean);

/** A copy of `element` with other children (or attributes). */
export function withChildren(
  element: XmlElement,
  children: readonly XmlNode[],
  attributes: ReadonlyMap<string, string> = element.attributes,
): XmlElement {
  return {
    ns: element.ns,
    local: element.local,
    attributes,
    children,
    line: element.line,
  };
}

/**
 * Appends `items` to `target` one by one: a spread (`push(...items)`) passes
 * each item as an argument, and an element may have more children than a
 * call may have arguments.
 */
export function pushAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) target.push(item);
  return target;
}
