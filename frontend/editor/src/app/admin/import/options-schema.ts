/**
 * An importer's options as a form (#93): `meta.optionsSchema` of `GET /importers` is JSON Schema
 * (the input side of the importer's Zod schema), and each of its properties becomes one field.
 * A string is a text field, a boolean a checkbox, a string with an `enum` a select; anything else
 * (a number, a list, an object, a union) is JSON, checked as it is typed. What the form holds
 * becomes the `options` field of the upload, a JSON object.
 */

/** One option as a field of the form. */
export interface OptionField {
  readonly name: string;
  readonly kind: 'text' | 'boolean' | 'select' | 'json';
  /** The schema's `title`, else the property's name: the field's label. */
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
  /** A select's choices. */
  readonly choices: readonly string[];
  /** A JSON field's type, when the schema names one (`number`, `array`, …). */
  readonly jsonType: string | null;
  /** What the field starts with: the schema's `default`, as the field holds it. */
  readonly initial: OptionValue;
}

/** What a field holds: a text field's and a JSON field's text, a checkbox's state, a choice. */
export type OptionValue = string | boolean;

export type OptionValues = Readonly<Record<string, OptionValue>>;

/** Why a field's value cannot be sent (a translation key). */
export type OptionProblem =
  | 'editor.admin.import.options.required'
  | 'editor.admin.import.options.invalidJson'
  | 'editor.admin.import.options.wrongType';

/** The most options a form renders: a schema with more is read as JSON as a whole. */
const MAX_FIELDS = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fields of an options schema, in its order; none for a schema with no properties. */
export function optionFields(schema: unknown): readonly OptionField[] {
  if (!isRecord(schema) || !isRecord(schema['properties'])) return [];
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((r): r is string => typeof r === 'string')
      : [],
  );
  return Object.entries(schema['properties'])
    .slice(0, MAX_FIELDS)
    .map(([name, property]) => fieldOf(name, property, required.has(name)));
}

function fieldOf(
  name: string,
  property: unknown,
  required: boolean,
): OptionField {
  const p = isRecord(property) ? property : {};
  const label =
    typeof p['title'] === 'string' && p['title'].trim() !== ''
      ? p['title']
      : name;
  const description =
    typeof p['description'] === 'string' && p['description'].trim() !== ''
      ? p['description']
      : null;
  const base = { name, label, description, required };
  const enumValues = Array.isArray(p['enum']) ? p['enum'] : null;
  if (
    enumValues &&
    enumValues.length > 0 &&
    enumValues.every((v) => typeof v === 'string')
  ) {
    const choices = enumValues as string[];
    const initial =
      typeof p['default'] === 'string' && choices.includes(p['default'])
        ? p['default']
        : '';
    return {
      ...base,
      kind: 'select',
      choices,
      jsonType: null,
      initial,
    };
  }
  if (p['type'] === 'string') {
    return {
      ...base,
      kind: 'text',
      choices: [],
      jsonType: null,
      initial: typeof p['default'] === 'string' ? p['default'] : '',
    };
  }
  if (p['type'] === 'boolean') {
    return {
      ...base,
      kind: 'boolean',
      choices: [],
      jsonType: null,
      initial: p['default'] === true,
    };
  }
  return {
    ...base,
    kind: 'json',
    choices: [],
    jsonType: typeof p['type'] === 'string' ? p['type'] : null,
    initial: p['default'] === undefined ? '' : JSON.stringify(p['default']),
  };
}

/** The fields' starting values. */
export function initialValues(fields: readonly OptionField[]): OptionValues {
  return Object.fromEntries(fields.map((f) => [f.name, f.initial]));
}

/** Whether `value` is of JSON Schema type `type`. */
function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

/** One field's problem, or null. */
export function problemOf(
  field: OptionField,
  value: OptionValue | undefined,
): OptionProblem | null {
  if (field.kind === 'boolean') return null;
  const text = typeof value === 'string' ? value : '';
  if (text.trim() === '') {
    return field.required ? 'editor.admin.import.options.required' : null;
  }
  if (field.kind !== 'json') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'editor.admin.import.options.invalidJson';
  }
  return field.jsonType && !hasType(parsed, field.jsonType)
    ? 'editor.admin.import.options.wrongType'
    : null;
}

/** Every field's problem, by name; empty when the form can be sent. */
export function problemsOf(
  fields: readonly OptionField[],
  values: OptionValues,
): Readonly<Record<string, OptionProblem>> {
  const problems: Record<string, OptionProblem> = {};
  for (const field of fields) {
    const problem = problemOf(field, values[field.name]);
    if (problem) problems[field.name] = problem;
  }
  return problems;
}

/**
 * The `options` object to send: each filled field's value (an empty optional field is left out,
 * so the importer's default holds); a checkbox always says its state. Call it on a form without
 * problems.
 */
export function optionsOf(
  fields: readonly OptionField[],
  values: OptionValues,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name] ?? field.initial;
    if (field.kind === 'boolean') {
      put(options, field.name, value === true);
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (text.trim() === '') continue;
    put(options, field.name, field.kind === 'json' ? JSON.parse(text) : text);
  }
  return options;
}

/** Sets an own property, whatever its name (`__proto__` included: never the prototype). */
function put(target: Record<string, unknown>, name: string, value: unknown) {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * The fields' values for `options` an import was checked with (`attributes.options`), so a
 * reloaded screen shows the form as it was sent; a field it does not name keeps its start.
 */
export function valuesFrom(
  fields: readonly OptionField[],
  options: Readonly<Record<string, unknown>>,
): OptionValues {
  return Object.fromEntries(
    fields.map((f): [string, OptionValue] => {
      if (!Object.hasOwn(options, f.name)) return [f.name, f.initial];
      const value = options[f.name];
      if (f.kind === 'boolean') return [f.name, value === true];
      if (f.kind === 'json') return [f.name, JSON.stringify(value)];
      return [f.name, typeof value === 'string' ? value : f.initial];
    }),
  );
}
