import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parsePermissions,
  renderErrorCodes,
  renderMcpTools,
  renderPermissions,
} from '../scripts/lib/catalogues.mjs';
import { withPermissionTexts } from '../scripts/lib/guide-references.mjs';
import {
  compactJson,
  fields,
  typeOf,
  undescribedFields,
} from '../scripts/lib/json-schema.mjs';

const repo = (path: string) =>
  readFileSync(join(import.meta.dirname, '../../..', path), 'utf8');

describe('the permissions reference', () => {
  const source = `
    export const PERMISSIONS = [
      /** Read released content. */
      'content.read',
      /** Configure webhooks. */
      'webhook.manage',
      'undescribed',
    ] as const;
    export const GLOBAL_PERMISSIONS: ReadonlySet<Permission> = new Set(['webhook.manage']);
    export const READ_PERMISSIONS: ReadonlySet<Permission> = new Set(['content.read']);
  `;

  it('reads each permission with its comment, and refuses one without', () => {
    const { permissions, problems } = parsePermissions(source);
    expect(permissions).toEqual([
      {
        name: 'content.read',
        description: 'Read released content.',
        global: false,
        read: true,
      },
      {
        name: 'webhook.manage',
        description: 'Configure webhooks.',
        global: true,
        read: false,
      },
      { name: 'undescribed', description: '', global: false, read: false },
    ]);
    expect(problems).toEqual([
      'permissions.ts: undescribed has no /** comment */ describing it',
    ]);
  });

  const texts = {
    en: {
      admin: {
        permissions: {
          contentRead: 'Read released content in scope',
          webhookManage: 'Manage webhook subscribers',
        },
      },
    },
    de: {
      admin: {
        permissions: {
          contentRead: 'Freigegebene Inhalte im Geltungsbereich lesen',
          webhookManage: 'Webhook-Abonnenten verwalten',
        },
      },
    },
  };
  const apis = {
    delivery: {
      paths: {
        '/modules': {
          get: {
            summary: 'List modules',
            'x-required-permission': 'content.read',
          },
        },
        '/health': { get: { summary: 'Health' } },
      },
    },
  };
  const pageOf = (api: string, path: string, method: string) =>
    `/api/${api}/${method}${path}`;

  it('lists the routes needing each permission, and those needing none', () => {
    const { permissions } = withPermissionTexts(
      parsePermissions(source).permissions.slice(0, 2),
      texts,
    );
    const body = renderPermissions(permissions, apis, pageOf);
    expect(body).toContain(
      '## content.read\n\nRead released content in scope\n\n| Route | What it does |',
    );
    expect(body).toContain(
      '[`GET /modules`](/api/delivery/get/modules) | List modules |',
    );
    expect(body).toContain('## Routes without a permission');
    expect(body).toContain(
      '[`GET /health`](/api/delivery/get/health) | Health |',
    );
  });

  it('writes the German page with the editor’s German texts, the routes without their English summaries', () => {
    const { permissions } = withPermissionTexts(
      parsePermissions(source).permissions.slice(0, 2),
      texts,
    );
    const body = renderPermissions(permissions, apis, pageOf, 'de');
    expect(body).toContain('| Berechtigung | Was sie erlaubt | Art | Routen |');
    expect(body).toContain(
      '## content.read\n\nFreigegebene Inhalte im Geltungsbereich lesen\n\n- [`GET /modules`](/api/delivery/get/modules)\n',
    );
    expect(body).toContain('| Webhook-Abonnenten verwalten | global |');
    expect(body).toContain('## Routen ohne Berechtigung');
    expect(body).not.toContain('List modules');
    expect(body).not.toContain('Health |');
  });

  it('refuses a permission without the editor’s text in a language', () => {
    const { problems } = withPermissionTexts(
      parsePermissions(source).permissions.slice(0, 2),
      { en: texts.en, de: { admin: { permissions: {} } } },
    );
    expect(problems).toEqual([
      "the editor's de.json has no text for the permission content.read (admin.permissions.contentRead)",
      "the editor's de.json has no text for the permission webhook.manage (admin.permissions.webhookManage)",
    ]);
  });

  it('finds the editor’s texts for every permission of the API', () => {
    const { problems } = withPermissionTexts(
      parsePermissions(repo('backend/api/src/access/core/permissions.ts'))
        .permissions,
      {
        en: JSON.parse(repo('frontend/editor/src/i18n/en.json')),
        de: JSON.parse(repo('frontend/editor/src/i18n/de.json')),
      },
    );
    expect(problems).toEqual([]);
  });

  it('finds every permission of the API described', () => {
    const { permissions, problems } = parsePermissions(
      repo('backend/api/src/access/core/permissions.ts'),
    );
    expect(problems).toEqual([]);
    expect(permissions.map((p) => p.name)).toContain('content.read');
  });
});

describe('the error code reference', () => {
  it('lists each code with its status, and by status', () => {
    const body = renderErrorCodes({
      'not-found': { status: 404, when: 'Nothing <there>.' },
      'import-failed': { when: 'Reported on the job.' },
    });
    expect(body).toContain(
      '| <code>import-<wbr />failed</code> | — | Reported on the job. |',
    );
    expect(body).toContain(
      '| <code>not-<wbr />found</code> | 404 | Nothing &lt;there&gt;. |',
    );
    expect(body).toContain('| 404 | `not-found` |');
  });
});

describe('schemas as tables', () => {
  const schema = {
    type: 'object',
    required: ['languages'],
    properties: {
      languages: {
        type: 'object',
        required: ['source'],
        properties: {
          source: { type: 'string', description: 'The source language.' },
        },
      },
      moduleTypes: {
        type: 'array',
        default: [],
        items: { $ref: '#/$defs/ModuleType' },
      },
      labels: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { text: { type: 'string' } },
        },
      },
    },
    $defs: {
      ModuleType: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 64 },
          kind: { enum: ['a', 'b'] },
        },
      },
    },
  };

  it('walks nested objects, lists of objects and maps to their fields', () => {
    expect(fields(schema).map((r) => [r.path, r.type, r.required])).toEqual([
      ['languages', 'object', true],
      ['languages.source', 'string', true],
      ['moduleTypes', 'object[]', false],
      ['moduleTypes[].id', 'string (at most 64)', false],
      ['moduleTypes[].kind', '"a" | "b"', false],
      ['labels', 'object', false],
      ['labels.<key>', 'object', false],
      ['labels.<key>.text', 'string', false],
    ]);
  });

  it('lists a field the variants of a union share once, with every type', () => {
    const union = {
      type: 'object',
      properties: {
        attributes: {
          type: 'array',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  kind: { const: 'enum', description: 'How values compare.' },
                  values: { type: 'array', items: { type: 'string' } },
                },
              },
              {
                type: 'object',
                properties: { kind: { const: 'version' } },
              },
            ],
          },
        },
      },
    };
    expect(fields(union).map((r) => [r.path, r.type, r.description])).toEqual([
      ['attributes', 'object[]', ''],
      ['attributes[].kind', '"enum" | "version"', 'How values compare.'],
      ['attributes[].values', 'string[]', ''],
    ]);
  });

  it('names each field without a description as a problem', () => {
    expect(undescribedFields(fields(schema), 'openfolia.yaml')).toEqual([
      'openfolia.yaml: `languages` has no description',
      'openfolia.yaml: `moduleTypes` has no description',
      'openfolia.yaml: `moduleTypes[].id` has no description',
      'openfolia.yaml: `moduleTypes[].kind` has no description',
      'openfolia.yaml: `labels` has no description',
      'openfolia.yaml: `labels.<key>` has no description',
      'openfolia.yaml: `labels.<key>.text` has no description',
    ]);
  });

  it('writes a default on one line that can wrap', () => {
    expect(compactJson({ access: 'signed-in', manuals: {} })).toBe(
      '{ "access": "signed-in", "manuals": {} }',
    );
    expect(compactJson(false)).toBe('false');
  });

  it('names ranges and unions', () => {
    expect(typeOf({ type: 'integer', minimum: 1, maximum: 10 }, {})).toBe(
      'integer (1 to 10)',
    );
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'null' }] }, {})).toBe(
      'string | null',
    );
  });

  it('renders the MCP tools with their arguments', () => {
    const body = renderMcpTools([
      {
        name: 'search',
        title: 'Search the content',
        description: 'Finds modules.',
        inputSchema: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', description: 'Words.' } },
        },
      },
    ]);
    expect(body).toContain(
      '## search\n\n**Search the content.** Finds modules.',
    );
    expect(body).toContain('| <code>q</code> | `string` | yes |  | Words. |');
    expect(body).not.toContain('## Resources');
  });

  it('renders the MCP resources from their templates, with their bounds', () => {
    const body = renderMcpTools([], {
      templates: [
        {
          uriTemplate: 'openfolia://manuals/{id}/{variant}/{lang}',
          name: 'manual',
          title: 'A released manual',
          description: 'As `read_manual` gives it.',
          mimeType: 'text/markdown',
        },
      ],
      pageSize: 20,
      textLimit: 500_000,
    });
    expect(body).toContain(
      '### manual\n\n**A released manual.** As `read_manual` gives it.',
    );
    expect(body).toContain(
      '- Address: `openfolia://manuals/{id}/{variant}/{lang}`',
    );
    expect(body).toContain('- Type: `text/markdown`');
    expect(body).toContain('20 manuals a page');
    expect(body).toContain('at most 500,000 characters');
  });
});
