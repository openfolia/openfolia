import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  API_SERVER,
  managementDocument,
  operations,
  pruneToOperation,
  slug,
  undocumented,
  withServer,
} from '../scripts/lib/openapi.mjs';

const doc = {
  openapi: '3.0.0',
  info: { title: 'All', version: '1' },
  security: [{ bearer: [] }],
  tags: [{ name: 'modules' }, { name: 'releases' }],
  paths: {
    '/modules': {
      get: {
        operationId: 'Modules_list',
        summary: 'List modules',
        description: 'The modules.',
        tags: ['modules'],
        'x-audience': 'delivery',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ModuleList' },
              },
            },
          },
        },
      },
      post: {
        operationId: 'Modules_create',
        summary: 'Create',
        description: '',
        tags: ['modules'],
        responses: { 201: { description: 'made' } },
      },
    },
    '/releases': {
      get: {
        operationId: 'Releases_list',
        summary: 'List releases',
        description: 'The releases.',
        tags: ['releases'],
        'x-audience': 'delivery',
        responses: { 200: { description: 'ok' } },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      ModuleList: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/Module' },
          },
        },
      },
      Module: { type: 'object', properties: { id: { type: 'string' } } },
      Unused: { type: 'string' },
    },
  },
};

describe('the API references', () => {
  it('keep the operations outside the delivery API as the Management API, each once', () => {
    const management = managementDocument(doc);
    expect(operations(management).map((o) => `${o.method} ${o.path}`)).toEqual([
      'post /modules',
    ]);
    expect(management.info.title).toBe('Management API');
  });

  it('refuse an operation without a summary or a description', () => {
    expect(undocumented(doc, 'All')).toEqual([
      'All: POST /modules has no description (@ApiOperation)',
    ]);
  });

  it('cut a document down to one operation and what it references', () => {
    const mini = pruneToOperation(doc, '/modules', 'get');
    expect(Object.keys(mini.paths)).toEqual(['/modules']);
    expect(Object.keys(mini.paths['/modules'])).toEqual(['get']);
    expect(Object.keys(mini.components.schemas).sort()).toEqual([
      'Module',
      'ModuleList',
    ]);
    expect(mini.components.securitySchemes).toEqual(
      doc.components.securitySchemes,
    );
    expect(mini.tags).toEqual([{ name: 'modules' }]);
  });

  it('refuse a reference that resolves to nothing', () => {
    const broken = structuredClone(doc);
    Object.assign(broken.paths['/releases'].get.responses, {
      200: { $ref: '#/components/responses/Gone' },
    });
    expect(() => pruneToOperation(broken, '/releases', 'get')).toThrow(
      /resolves to nothing/,
    );
  });

  it('name one server, the instance with an editable host, never localhost (#858)', () => {
    const server = {
      url: 'https://{host}/api',
      description: expect.stringContaining('https://<team>.openfolia.com/api'),
      variables: {
        host: {
          default: 'your-team.openfolia.com',
          description: expect.stringContaining('https://<team>.openfolia.com'),
        },
      },
    };
    const whole = withServer({ ...doc, servers: [{ url: 'http://x.test' }] });
    expect(whole.servers).toEqual([server]);
    // An operation's page embeds the same server.
    expect(pruneToOperation(whole, '/modules', 'get').servers).toEqual([
      server,
    ]);
    // And so does the download, as YAML.
    const yaml = stringify(whole, { lineWidth: 0 });
    expect(parse(yaml).servers).toEqual([server]);
    expect(yaml).not.toMatch(/localhost/);
    // The default fills in to a URL the code samples can show.
    expect(
      new URL(server.url.replace('{host}', API_SERVER.variables.host.default))
        .href,
    ).toBe('https://your-team.openfolia.com/api');
  });

  it('make addresses from operation IDs', () => {
    expect(slug('Modules_list')).toBe('modules-list');
    expect(slug('ModuleHistory_history')).toBe('module-history-history');
  });

  it('find every operation of the committed delivery document described', () => {
    const delivery = parse(
      readFileSync(
        join(import.meta.dirname, '../../../backend/api/openapi/delivery.yaml'),
        'utf8',
      ),
    );
    expect(operations(delivery).length).toBeGreaterThan(0);
    expect(undocumented(delivery, 'Delivery API')).toEqual([]);
    for (const { path, method } of operations(delivery))
      expect(() => pruneToOperation(delivery, path, method)).not.toThrow();
  });
});
