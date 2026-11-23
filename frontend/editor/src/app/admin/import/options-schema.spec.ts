import {
  initialValues,
  optionFields,
  optionsOf,
  problemsOf,
  valuesFrom,
} from './options-schema';

/** An options schema as `GET /importers` sends it (a Zod object's JSON Schema, input side). */
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    folder: {
      type: 'string',
      title: 'Target folder',
      description: 'Where the modules go.',
    },
    keepIds: { type: 'boolean', default: true },
    language: { type: 'string', enum: ['en', 'de'], default: 'de' },
    depth: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' }, default: ['a'] },
  },
  required: ['folder'],
  additionalProperties: false,
};

describe('optionFields', () => {
  it('makes a text field, a checkbox, a select and JSON for the rest, in order', () => {
    const fields = optionFields(schema);
    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ['folder', 'text'],
      ['keepIds', 'boolean'],
      ['language', 'select'],
      ['depth', 'json'],
      ['tags', 'json'],
    ]);
    expect(fields[0]).toMatchObject({
      label: 'Target folder',
      description: 'Where the modules go.',
      required: true,
    });
    // Without a title, the property's name is the label.
    expect(fields[1]).toMatchObject({ label: 'keepIds', required: false });
    expect(fields[2]?.choices).toEqual(['en', 'de']);
    expect(fields[3]?.jsonType).toBe('integer');
  });

  it('has no fields for an importer without options, or a schema it cannot read', () => {
    expect(
      optionFields({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
    ).toEqual([]);
    expect(optionFields(null)).toEqual([]);
    expect(optionFields({ type: 'string' })).toEqual([]);
    expect(optionFields({ properties: [] })).toEqual([]);
  });

  it('starts each field at its default', () => {
    expect(initialValues(optionFields(schema))).toEqual({
      folder: '',
      keepIds: true,
      language: 'de',
      depth: '',
      tags: '["a"]',
    });
  });
});

describe('problemsOf and optionsOf', () => {
  const fields = optionFields(schema);

  it('asks for a required field and checks JSON and its type', () => {
    const values = {
      ...initialValues(fields),
      depth: '1.5',
      tags: '{nope',
    };
    expect(problemsOf(fields, values)).toEqual({
      folder: 'editor.admin.import.options.required',
      depth: 'editor.admin.import.options.wrongType',
      tags: 'editor.admin.import.options.invalidJson',
    });
  });

  it('sends what is filled in, leaves an empty optional field out and always says a checkbox', () => {
    const values = {
      ...initialValues(fields),
      folder: 'imported/legacy',
      keepIds: false,
      depth: '',
      tags: '["x", "y"]',
    };
    expect(problemsOf(fields, values)).toEqual({});
    expect(optionsOf(fields, values)).toEqual({
      folder: 'imported/legacy',
      keepIds: false,
      language: 'de',
      tags: ['x', 'y'],
    });
  });

  it('keeps an option named __proto__ an own value, never the prototype', () => {
    const odd = optionFields({
      type: 'object',
      properties: { ['__proto__']: { type: 'string' } },
    });
    const options = optionsOf(odd, { ['__proto__']: 'x' });
    expect(Object.getPrototypeOf(options)).toBe(Object.prototype);
    expect(JSON.stringify(options)).toBe('{"__proto__":"x"}');
  });

  it('shows the options an import was checked with again', () => {
    expect(
      valuesFrom(fields, { folder: 'a', keepIds: false, tags: ['z'] }),
    ).toEqual({
      folder: 'a',
      keepIds: false,
      language: 'de',
      depth: '',
      tags: '["z"]',
    });
  });
});
