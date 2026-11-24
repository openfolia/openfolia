// The two API references from the API's OpenAPI documents: the Delivery API
// (`backend/api/openapi/delivery.yaml`) and the Management API (the full document, generated at
// build time, minus the delivery operations, so each operation has one page).

export const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

/** Every operation of a document: `{ path, method, operation }`. */
export function operations(doc) {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const method of METHODS)
      if (item?.[method]) out.push({ path, method, operation: item[method] });
  return out;
}

/** Operations without a summary or a description: each a problem, for the build to refuse. */
export function undocumented(doc, name) {
  return operations(doc).flatMap(({ path, method, operation }) => {
    const missing = ['summary', 'description'].filter(
      (field) =>
        typeof operation[field] !== 'string' || operation[field].trim() === '',
    );
    return missing.length > 0
      ? [
          `${name}: ${method.toUpperCase()} ${path} has no ${missing.join(' and no ')} (@ApiOperation)`,
        ]
      : [];
  });
}

/** The full document without the delivery operations (`x-audience: delivery`). */
export function managementDocument(full) {
  const paths = {};
  for (const [path, item] of Object.entries(full.paths ?? {})) {
    const kept = {};
    let any = false;
    for (const [key, value] of Object.entries(item)) {
      if (METHODS.includes(key)) {
        if (value?.['x-audience'] === 'delivery') continue;
        any = true;
      }
      kept[key] = value;
    }
    if (any) paths[path] = kept;
  }
  return {
    ...full,
    info: { ...full.info, title: 'Management API' },
    paths,
  };
}

/**
 * The one server of the reference, its pages and its downloads (#858): the instance's address
 * plus `/api`, the host a variable the reader fills in. The default is a placeholder that still
 * parses as a URL, so the code samples read `https://your-team.openfolia.com/api/...` until the
 * reader types their own.
 */
export const API_SERVER = {
  url: 'https://{host}/api',
  description:
    "Your instance's API: https://<team>.openfolia.com/api for a hosted OpenFolia, or your own editor's address plus /api.",
  variables: {
    host: {
      default: 'your-team.openfolia.com',
      description:
        "Your team's address, https://<team>.openfolia.com for a hosted OpenFolia, or your own host.",
    },
  },
};

/** The document with the reference's one server. */
export function withServer(doc) {
  return { ...doc, servers: [API_SERVER] };
}

/** Every `$ref` inside a value. */
function refsIn(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) refsIn(v, out);
  else if (value && typeof value === 'object')
    for (const [key, v] of Object.entries(value)) {
      if (key === '$ref' && typeof v === 'string') out.add(v);
      else refsIn(v, out);
    }
  return out;
}

const unescape = (segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * The document cut down to one operation and what it references, so a page carries kilobytes, not
 * the whole document: the API reference has a page per operation, and each page embeds its
 * document for the code samples and the schema views.
 */
export function pruneToOperation(doc, path, method) {
  const item = doc.paths[path];
  const { parameters, servers, summary, description } = item;
  const pathItem = { [method]: item[method] };
  if (parameters) pathItem.parameters = parameters;
  if (servers) pathItem.servers = servers;
  if (summary) pathItem.summary = summary;
  if (description) pathItem.description = description;

  const components = {};
  const queue = [...refsIn(pathItem), ...refsIn(doc.security ?? [])];
  const seen = new Set();
  while (queue.length > 0) {
    const ref = queue.pop();
    if (seen.has(ref) || !ref.startsWith('#/components/')) continue;
    seen.add(ref);
    const [kind, ...name] = ref
      .slice('#/components/'.length)
      .split('/')
      .map(unescape);
    const target = doc.components?.[kind]?.[name.join('/')];
    if (target === undefined)
      throw new Error(
        `${method.toUpperCase()} ${path}: ${ref} resolves to nothing`,
      );
    (components[kind] ??= {})[name.join('/')] = target;
    queue.push(...refsIn(target));
  }
  if (doc.components?.securitySchemes)
    components.securitySchemes = doc.components.securitySchemes;

  const tags = new Set(item[method].tags ?? []);
  return {
    openapi: doc.openapi,
    info: doc.info,
    ...(doc.servers && { servers: doc.servers }),
    ...(doc.security && { security: doc.security }),
    ...(doc.tags && { tags: doc.tags.filter((t) => tags.has(t.name)) }),
    paths: { [path]: pathItem },
    components,
  };
}

/** A file name from an operation ID: `Modules_list` → `modules-list`. */
export function slug(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
