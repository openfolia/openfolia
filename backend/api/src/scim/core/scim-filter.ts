import { ScimInvalidFilterError } from './scim-errors.js';
import {
  attributeOf,
  checkText,
  isCoreSchema,
  isObject,
  type JsonObject,
} from './scim-json.js';
import { spend, weightOf } from './scim-work.js';

/**
 * SCIM filters (RFC 7644, section 3.4.2.2): `userName eq "jane"`, `emails[type eq "work" and
 * value co "@example.org"]`, `not (active eq false) or meta.lastModified gt "2026-01-01T00:00:00Z"`.
 * Every operator of the standard (`eq`, `ne`, `co`, `sw`, `ew`, `gt`, `lt`, `ge`, `le`, `pr`),
 * `and`, `or`, `not`, parentheses, value paths and attribute paths with a schema URN. Evaluated
 * on a resource as the API answers it (`matches`); attribute names ignore case, and so do string
 * comparisons except of the attributes that are case-exact (`id`, `externalId`, the IDs in
 * `members` and `groups`).
 */

/** An attribute path: `name.givenName`, `urn:…:enterprise:2.0:User:employeeNumber`. */
export interface AttrPath {
  /** An extension's schema URN, whose object holds the attribute; undefined for the core schema. */
  readonly schema?: string;
  readonly attr: string;
  readonly sub?: string;
}

export type CompareOp =
  'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'lt' | 'ge' | 'le';

export type Filter =
  | {
      readonly kind: 'and' | 'or';
      readonly left: Filter;
      readonly right: Filter;
    }
  | { readonly kind: 'not'; readonly filter: Filter }
  | { readonly kind: 'present'; readonly path: AttrPath }
  | {
      readonly kind: 'compare';
      readonly path: AttrPath;
      readonly op: CompareOp;
      readonly value: string | number | boolean | null;
    }
  | {
      readonly kind: 'valuePath';
      readonly path: AttrPath;
      readonly filter: Filter;
    };

/** The longest filter read. */
export const MAX_FILTER_LENGTH = 2000;
/** How deep a filter may nest (parentheses, `not`, value paths). */
const MAX_NESTING = 16;

const COMPARE_OPS = new Set([
  'eq',
  'ne',
  'co',
  'sw',
  'ew',
  'gt',
  'lt',
  'ge',
  'le',
]);

type Token =
  | { readonly type: 'word'; readonly text: string }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: '(' | ')' | '[' | ']' };

/** Splits `text` into tokens; 400 `scim-invalid-filter` for anything else. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? '';
    if (/\s/.test(char)) {
      at++;
    } else if ('()[]'.includes(char)) {
      tokens.push({ type: char as '(' });
      at++;
    } else if (char === '"') {
      // A JSON string: its escapes as JSON has them.
      let end = at + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      if (end >= text.length) throw invalid('A string is not closed.');
      let value: string;
      try {
        value = JSON.parse(text.slice(at, end + 1)) as string;
        // Its escapes may spell what the text around them does not hold.
        checkText(value);
      } catch {
        throw invalid('A string has an escape that is no text.');
      }
      tokens.push({ type: 'string', value });
      at = end + 1;
    } else if (/[-0-9]/.test(char)) {
      const number = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(at));
      if (!number) throw invalid(`Unexpected "${char}".`);
      tokens.push({ type: 'number', value: Number(number[0]) });
      at += number[0].length;
    } else {
      const word = /^[A-Za-z$][\w:.$-]*/.exec(text.slice(at));
      if (!word) throw invalid(`Unexpected "${char}".`);
      tokens.push({ type: 'word', text: word[0] });
      at += word[0].length;
    }
  }
  return tokens;
}

const invalid = (detail: string) =>
  new ScimInvalidFilterError(`The filter does not parse: ${detail}`);

/** Reads an attribute path token: an optional schema URN, an attribute and a sub-attribute. */
export function attrPathOf(text: string): AttrPath {
  let schema: string | undefined;
  let rest = text;
  if (/^urn:/i.test(text)) {
    const colon = text.lastIndexOf(':');
    schema = text.slice(0, colon);
    rest = text.slice(colon + 1);
    if (isCoreSchema(schema)) schema = undefined;
  }
  const parts = rest.split('.');
  const [attr = '', sub, more] = parts;
  if (
    more !== undefined ||
    !/^[A-Za-z$][\w$-]*$/.test(attr) ||
    (sub !== undefined && !/^[A-Za-z$][\w$-]*$/.test(sub))
  ) {
    throw invalid(`"${text}" is no attribute path.`);
  }
  return { ...(schema && { schema }), attr, ...(sub !== undefined && { sub }) };
}

/** A parser over tokens, shared by filters and patch paths. */
export class Parser {
  private at = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  get done(): boolean {
    return this.at >= this.tokens.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.at];
  }

  next(): Token | undefined {
    return this.tokens[this.at++];
  }

  expect(type: '(' | ')' | '[' | ']'): void {
    if (this.next()?.type !== type) throw invalid(`"${type}" expected.`);
  }

  private keyword(word: string): boolean {
    const token = this.peek();
    if (token?.type === 'word' && token.text.toLowerCase() === word) {
      this.at++;
      return true;
    }
    return false;
  }

  /** `FILTER`: or-ed terms of and-ed factors. */
  filter(depth = 0): Filter {
    if (depth > MAX_NESTING) throw invalid('It nests too deep.');
    let left = this.conjunction(depth);
    while (this.keyword('or')) {
      left = { kind: 'or', left, right: this.conjunction(depth) };
    }
    return left;
  }

  private conjunction(depth: number): Filter {
    let left = this.factor(depth);
    while (this.keyword('and')) {
      left = { kind: 'and', left, right: this.factor(depth) };
    }
    return left;
  }

  private factor(depth: number): Filter {
    if (this.keyword('not')) {
      this.expect('(');
      const filter = this.filter(depth + 1);
      this.expect(')');
      return { kind: 'not', filter };
    }
    if (this.peek()?.type === '(') {
      this.next();
      const filter = this.filter(depth + 1);
      this.expect(')');
      return filter;
    }
    const token = this.next();
    if (token?.type !== 'word') throw invalid('An attribute path expected.');
    const path = attrPathOf(token.text);
    if (this.peek()?.type === '[') {
      if (path.sub !== undefined) {
        throw invalid(
          'A value filter follows an attribute, not a sub-attribute.',
        );
      }
      this.next();
      const filter = this.filter(depth + 1);
      this.expect(']');
      return { kind: 'valuePath', path, filter };
    }
    const op = this.next();
    const name = op?.type === 'word' ? op.text.toLowerCase() : '';
    if (name === 'pr') return { kind: 'present', path };
    if (!COMPARE_OPS.has(name)) throw invalid('An operator expected.');
    return {
      kind: 'compare',
      path,
      op: name as CompareOp,
      value: this.value(),
    };
  }

  private value(): string | number | boolean | null {
    const token = this.next();
    if (token?.type === 'string' || token?.type === 'number')
      return token.value;
    if (token?.type === 'word') {
      const word = token.text.toLowerCase();
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
    }
    throw invalid('A value expected: a string, a number, true, false or null.');
  }
}

/** Parses a filter; 400 `scim-invalid-filter` for one that does not parse. */
export function parseFilter(text: string): Filter {
  if (text.length > MAX_FILTER_LENGTH) {
    throw invalid(`It is longer than ${MAX_FILTER_LENGTH} characters.`);
  }
  const parser = new Parser(tokenize(text));
  const filter = parser.filter();
  if (!parser.done) throw invalid('Something follows the filter.');
  return filter;
}

/** Attribute paths (lowercase) whose strings are compared exactly, case included. */
const CASE_EXACT = new Set([
  'id',
  'externalid',
  'members.value',
  'groups.value',
  'value',
]);

/**
 * The values `path` names in `resource`, flattened: an attribute's value, or every value of a
 * multi-valued one; for a complex multi-valued attribute without a sub-attribute, the `value` of
 * each (RFC 7644, section 3.4.2.2). `parent` names the attribute `resource` is a value of, for a
 * value filter (`emails[type eq "work"]`).
 */
export function valuesAt(resource: JsonObject, path: AttrPath): unknown[] {
  const container = path.schema ? attributeOf(resource, path.schema) : resource;
  if (!isObject(container)) return [];
  const found = attributeOf(container, path.attr);
  const items = Array.isArray(found) ? found : [found];
  spend(items.length);
  const values = items.flatMap((item) => {
    if (path.sub !== undefined) {
      if (!isObject(item)) return [];
      const sub = attributeOf(item, path.sub);
      if (Array.isArray(sub)) spend(sub.length);
      return Array.isArray(sub) ? sub : [sub];
    }
    if (Array.isArray(found) && isObject(item))
      return [attributeOf(item, 'value')];
    return [item];
  });
  return values.filter((v) => v !== undefined && v !== null);
}

/** Whether `resource` matches `filter`. `parent`: see `valuesAt`. 400 for a comparison it cannot make. */
export function matches(
  filter: Filter,
  resource: JsonObject,
  parent?: string,
): boolean {
  // Its names are put together and lowercased for every value tested.
  spend(1 + ('path' in filter ? weightOfPath(filter.path, parent) : 0));
  switch (filter.kind) {
    case 'and':
      return (
        matches(filter.left, resource, parent) &&
        matches(filter.right, resource, parent)
      );
    case 'or':
      return (
        matches(filter.left, resource, parent) ||
        matches(filter.right, resource, parent)
      );
    case 'not':
      return !matches(filter.filter, resource, parent);
    case 'present':
      return valuesAt(resource, filter.path).some(
        (v) =>
          !(v === '' || (Array.isArray(v) && v.length === 0)) &&
          !(isObject(v) && isEmpty(v)),
      );
    case 'valuePath': {
      const container = filter.path.schema
        ? attributeOf(resource, filter.path.schema)
        : resource;
      const found = isObject(container)
        ? attributeOf(container, filter.path.attr)
        : undefined;
      const items = Array.isArray(found)
        ? found
        : found === undefined
          ? []
          : [found];
      spend(items.length);
      return items.some(
        (item) =>
          isObject(item) &&
          matches(filter.filter, item, filter.path.attr.toLowerCase()),
      );
    }
    case 'compare': {
      const name = [parent, filter.path.attr, filter.path.sub]
        .filter(Boolean)
        .join('.')
        .toLowerCase();
      const exact =
        CASE_EXACT.has(name) &&
        // A bare `value` is case-exact only inside `members` or `groups`.
        (name !== 'value' || parent === 'members' || parent === 'groups');
      const values = valuesAt(resource, filter.path);
      if (filter.value === null) {
        // `eq null`: the attribute has no value; `ne null`: it has one.
        if (filter.op === 'eq') return values.length === 0;
        if (filter.op === 'ne') return values.length > 0;
        throw invalid(`"${filter.op}" does not compare with null.`);
      }
      if (filter.op === 'ne') {
        return !values.some((v) => compare('eq', v, filter.value, exact));
      }
      return values.some((v) => compare(filter.op, v, filter.value, exact));
    }
  }
}

const weightOfPath = ({ schema, attr, sub }: AttrPath, parent = ''): number =>
  [schema, attr, sub, parent].reduce((sum, s) => sum + weightOf(s ?? ''), 0);

function isEmpty(object: JsonObject): boolean {
  const { length } = Object.keys(object);
  spend(length);
  return length === 0;
}

function compare(
  op: CompareOp,
  actual: unknown,
  expected: string | number | boolean | null,
  exact: boolean,
): boolean {
  if (typeof expected === 'boolean') {
    if (op !== 'eq') throw invalid(`"${op}" does not compare booleans.`);
    return actual === expected;
  }
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') return false;
    return ordered(op, actual, expected);
  }
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  spend(1 + weightOf(actual) + weightOf(expected));
  const a = exact ? actual : actual.toLowerCase();
  const e = exact ? expected : expected.toLowerCase();
  switch (op) {
    case 'co':
      // Searching may compare every character of the one with every one of the other.
      spend(weightOf(a) * weightOf(e));
      return a.includes(e);
    case 'sw':
      return a.startsWith(e);
    case 'ew':
      return a.endsWith(e);
    default:
      return ordered(op, a, e);
  }
}

function ordered<T extends string | number>(
  op: CompareOp,
  a: T,
  e: T,
): boolean {
  switch (op) {
    case 'eq':
      return a === e;
    case 'gt':
      return a > e;
    case 'ge':
      return a >= e;
    case 'lt':
      return a < e;
    case 'le':
      return a <= e;
    default:
      throw invalid(`"${op}" does not compare numbers.`);
  }
}
