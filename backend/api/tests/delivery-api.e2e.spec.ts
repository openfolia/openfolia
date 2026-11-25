import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

interface Operation {
  operationId: string;
  'x-audience'?: string;
  'x-required-permission'?: string;
  parameters?: { name: string }[];
}
interface Document {
  openapi: string;
  info: { title: string; description: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

const REFERENCE = /"#\/components\/schemas\/([^"]+)"/g;
const refsIn = (node: unknown) =>
  [...JSON.stringify(node).matchAll(REFERENCE)].map((m) => m[1] ?? '');

const fetchDocument = async (path: string) => {
  const res = await t.anonymous().get(path);
  expect(res.status).toBe(200);
  return res.body as Document;
};

describe('delivery OpenAPI document', () => {
  let full: Document;
  let delivery: Document;
  beforeAll(async () => {
    full = await fetchDocument('/openapi.json');
    delivery = await fetchDocument('/openapi/delivery.json');
  });

  it('holds exactly the marked read routes', () => {
    expect(Object.keys(delivery.paths).sort()).toEqual([
      '/assets/{hash}',
      '/changelog',
      '/changes',
      '/chunks',
      '/config',
      '/d/-/fonts/{name}',
      '/d/-/{name}',
      '/d/{product}/{manual}/{variant}/{lang}',
      '/d/{product}/{manual}/{variant}/{lang}/assets/{hash}',
      '/d/{product}/{manual}/{variant}/{lang}/pdf',
      '/d/{product}/{manual}/{variant}/{lang}/pdf/qr.png',
      '/d/{product}/{manual}/{variant}/{lang}/pdf/qr.svg',
      '/d/{product}/{manual}/{variant}/{lang}/qr.png',
      '/d/{product}/{manual}/{variant}/{lang}/qr.svg',
      '/d/{product}/{manual}/{variant}/{lang}/symbols/{id}',
      '/downloads',
      '/downloads/{id}/versions',
      '/downloads/{id}/versions/{releaseId}/file',
      '/health',
      '/manuals',
      '/manuals/{id}',
      '/manuals/{id}/compare',
      '/manuals/{id}/history',
      '/manuals/{id}/update-guide/{lang}',
      '/manuals/{id}/update-guide/{lang}/steps',
      '/manuals/{id}/variants/{variant}/{lang}',
      '/manuals/{id}/variants/{variant}/{lang}/html',
      '/manuals/{id}/variants/{variant}/{lang}/pdf',
      '/modules',
      '/modules/{lang}/{id}',
      '/modules/{lang}/{id}/compare',
      '/modules/{lang}/{id}/history',
      '/modules/{lang}/{id}/preview',
      '/preview/fonts/{name}',
      '/preview/{name}',
      '/refs',
      '/releases',
      '/releases/{releaseId}',
      '/releases/{releaseId}/changes',
      '/releases/{releaseId}/dita-packages',
      '/releases/{releaseId}/dita-packages/{packageId}',
      '/releases/{releaseId}/dita-packages/{packageId}/file',
      '/releases/{releaseId}/iirds-packages',
      '/releases/{releaseId}/iirds-packages/{packageId}',
      '/releases/{releaseId}/iirds-packages/{packageId}/file',
      '/releases/{releaseId}/outputs',
      '/releases/{releaseId}/outputs/archive',
      '/releases/{releaseId}/outputs/{outputId}/file',
      '/search',
      '/stable-addresses',
      '/symbols/{id}',
      '/terms',
      '/terms/export',
      '/terms/{termId}',
    ]);
    expect(delivery.info.title).toBe('OpenFolia delivery API');
  });

  it('leaves no authoring, workflow or admin route or schema in it', () => {
    // A module version names the change set it came from by a relationship
    // (`{ type: "ChangeSet", id }`): a reference, no change set schema.
    const text = JSON.stringify(delivery).replaceAll(
      '"enum":["ChangeSet"]',
      '',
    );
    for (const word of [
      'change-sets',
      'working-copy',
      'workingCopy',
      '/locks',
      '/audit-events',
      '/users',
      'ChangeSet',
      'Lock',
      'AuditEvent',
      'ActorResource',
      'x-ccms-',
      'x-openfolia-',
      'X-Ccms-User',
    ]) {
      expect([word, text.includes(word)]).toEqual([word, false]);
    }
  });

  it('keeps every schema its operations reference, and only those', () => {
    const names = Object.keys(delivery.components.schemas);
    const used = new Set<string>();
    const queue = refsIn(delivery.paths);
    while (queue.length > 0) {
      const name = queue.pop() ?? '';
      if (used.has(name)) continue;
      used.add(name);
      expect(names).toContain(name);
      queue.push(...refsIn(delivery.components.schemas[name]));
    }
    expect(names.filter((n) => !used.has(n))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['ErrorDocument', 'Block']));
    expect(names.length).toBeLessThan(
      Object.keys(full.components.schemas).length,
    );
  });

  it('is well-formed: unique operation IDs, the same OpenAPI version as the full document', () => {
    expect(delivery.openapi).toBe(full.openapi);
    const ids = Object.values(delivery.paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('ManualPdf_pdf');
  });

  it('explains authentication, refs, variants, images, output and errors', () => {
    const text = delivery.info.description;
    for (const heading of [
      '## Authentication',
      '## Refs and caching',
      '## Variants, languages and resolving a manual',
      '## Search',
      '## Retrieval chunks',
      '## Images',
      '## HTML and PDF',
      '## Responses and errors',
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('content.read');
    expect(text).toContain('immutable');
  });

  it('is served as YAML, with an interactive reference, without a token', async () => {
    const yaml = await t.anonymous().get('/openapi/delivery.yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain('OpenFolia delivery API');
    const docs = await t.anonymous().get('/docs/delivery');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger');
    // The full reference is unchanged.
    const all = await t.anonymous().get('/docs');
    expect(all.status).toBe(200);
  });

  it('leaves the full document as it was, marking the delivery operations', () => {
    expect(full.paths['/change-sets']).toBeDefined();
    expect(full.paths['/me']).toBeDefined();
    expect(full.paths['/modules']?.['get']?.['x-audience']).toBe('delivery');
    expect(full.paths['/modules']?.['get']?.parameters).toContainEqual(
      expect.objectContaining({ name: 'X-Ccms-User' }),
    );
  });
});

/** What is wrong with the operations a document marks for delivery. */
function violations(doc: Pick<Document, 'paths'>): string[] {
  const found: string[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op['x-audience'] !== 'delivery') continue;
      const route = `${method.toUpperCase()} ${path}`;
      if (!/^(get|head)$/.test(method)) found.push(`${route} is not a read`);
      const permission = op['x-required-permission'];
      if (permission !== undefined && permission !== 'content.read') {
        found.push(`${route} needs ${permission}`);
      }
    }
  }
  return found;
}

describe('guard rails for delivery operations', () => {
  it('are only GET or HEAD and need at most content.read', async () => {
    const full = await fetchDocument('/openapi.json');
    const marked = Object.values(full.paths)
      .flatMap((methods) => Object.values(methods))
      .filter((op) => op['x-audience'] === 'delivery');
    expect(marked.length).toBeGreaterThan(10);
    expect(violations(full)).toEqual([]);
  });

  it('catch a write route or a stronger permission marked for delivery', () => {
    const op = (extra: object) => ({
      operationId: 'x',
      'x-audience': 'delivery',
      ...extra,
    });
    expect(
      violations({
        paths: {
          '/a': { post: op({}) },
          '/b': { get: op({ 'x-required-permission': 'content.edit' }) },
          '/c': { get: op({ 'x-required-permission': 'content.read' }) },
          '/d': { get: op({}) },
        },
      }),
    ).toEqual(['POST /a is not a read', 'GET /b needs content.edit']);
  });
});
