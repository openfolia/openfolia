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
  const files: Record<string, string> = {
    'backend/api/src/permissions.ts': `
      import { registerPermissions } from './access/core/permission-registry.js';
      import { CONTENT_PERMISSIONS } from './content/content.permissions.js';
      import { WEBHOOK_PERMISSIONS } from './webhooks/webhooks.permissions.js';
      export const REGISTERED_PERMISSIONS = registerPermissions([
        CONTENT_PERMISSIONS,
        WEBHOOK_PERMISSIONS,
      ]);
    `,
    'backend/api/src/content/content.permissions.ts': `
      function decoy() {
        const CONTENT_PERMISSIONS = definePermissions('decoy', [{ key: 'decoy.all' }]);
      }
      export const CONTENT_PERMISSIONS = definePermissions('content', [
        {
          key: 'content.read',
          labelKey: 'editor.admin.permissions.contentRead',
          description: 'Read released content.',
          read: true,
        },
      ]);
    `,
    'backend/api/src/webhooks/webhooks.permissions.ts': `
      export const WEBHOOK_PERMISSIONS = definePermissions('webhooks', [
        {
          key: 'webhook.manage',
          labelKey: 'editor.admin.permissions.webhookManage',
          description: 'Configure webhooks.',
          global: true,
        },
        { key: 'undescribed', labelKey: 'editor.admin.permissions.undescribed' },
      ]);
    `,
  };
  const read = (path: string) => files[path];

  it('reads each registered permission in order, and refuses one without a description', () => {
    const { permissions, problems } = parsePermissions(read);
    expect(permissions).toEqual([
      {
        name: 'content.read',
        labelKey: 'editor.admin.permissions.contentRead',
        description: 'Read released content.',
        global: false,
        read: true,
      },
      {
        name: 'webhook.manage',
        labelKey: 'editor.admin.permissions.webhookManage',
        description: 'Configure webhooks.',
        global: true,
        read: false,
      },
      {
        name: 'undescribed',
        labelKey: 'editor.admin.permissions.undescribed',
        description: '',
        global: false,
        read: false,
      },
    ]);
    expect(problems).toEqual([
      'backend/api/src/webhooks/webhooks.permissions.ts: undescribed needs a key, a labelKey and a description, each a string',
    ]);
  });

  it('refuses a flag or member it cannot read, so nothing is documented otherwise than enforced', () => {
    const odd: Record<string, string> = {
      ...files,
      'backend/api/src/webhooks/webhooks.permissions.ts': `
        export const WEBHOOK_PERMISSIONS = definePermissions('webhooks', [
          {
            key: 'webhook.manage',
            labelKey: 'editor.admin.permissions.webhookManage',
            description: 'Configure webhooks.',
            global: IS_GLOBAL,
            'read': true,
            ...more,
          },
        ]);
      `,
    };
    const { permissions, problems } = parsePermissions(
      (path: string) => odd[path],
    );
    expect(permissions[1]).toMatchObject({ global: false, read: false });
    const where = 'backend/api/src/webhooks/webhooks.permissions.ts';
    const why =
      'which the reference cannot read (texts are string literals, global and read only true)';
    expect(problems).toEqual([
      `${where}: webhook.manage has global: IS_GLOBAL, ${why}`,
      `${where}: webhook.manage has 'read': true, ${why}`,
      `${where}: webhook.manage has ...more, ${why}`,
    ]);
  });

  it('refuses a second registerPermissions, nested or not, and a group that is not an export const', () => {
    const registry = 'backend/api/src/permissions.ts';
    const decoy: Record<string, string> = {
      ...files,
      [registry]: `function decoy() { return registerPermissions([DECOY]); }\n${files[registry]}`,
    };
    expect(parsePermissions((path: string) => decoy[path])).toEqual({
      permissions: [],
      problems: [
        `${registry}: needs exactly one registerPermissions([...]), as export const REGISTERED_PERMISSIONS (what the API reads)`,
      ],
    });
    const renamed: Record<string, string> = {
      ...files,
      [registry]: (files[registry] ?? '').replace(
        'export const REGISTERED_PERMISSIONS',
        'export const OTHER',
      ),
    };
    expect(
      parsePermissions((path: string) => renamed[path]).permissions,
    ).toEqual([]);
    const group = 'backend/api/src/content/content.permissions.ts';
    const mutable: Record<string, string> = {
      ...files,
      [group]: (files[group] ?? '').replace('export const', 'export let'),
    };
    expect(parsePermissions((path: string) => mutable[path]).problems).toEqual([
      `${registry}: CONTENT_PERMISSIONS is no definePermissions(group, [...]) imported from a file`,
      'backend/api/src/webhooks/webhooks.permissions.ts: undescribed needs a key, a labelKey and a description, each a string',
    ]);
  });

  it('refuses a registered group it cannot read', () => {
    const { problems } = parsePermissions((path: string) =>
      path === 'backend/api/src/permissions.ts'
        ? 'export const REGISTERED_PERMISSIONS = registerPermissions([NOWHERE]);'
        : '',
    );
    expect(problems).toEqual([
      'backend/api/src/permissions.ts: NOWHERE is no definePermissions(group, [...]) imported from a file',
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
      parsePermissions(read).permissions.slice(0, 2),
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
      parsePermissions(read).permissions.slice(0, 2),
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
      parsePermissions(read).permissions.slice(0, 2),
      { en: texts.en, de: { admin: { permissions: {} } } },
    );
    expect(problems).toEqual([
      "the editor's de.json has no text for the permission content.read (editor.admin.permissions.contentRead)",
      "the editor's de.json has no text for the permission webhook.manage (editor.admin.permissions.webhookManage)",
    ]);
  });

  it('finds the editor’s texts for every permission of the API', () => {
    const { problems } = withPermissionTexts(
      parsePermissions(repo).permissions,
      {
        en: JSON.parse(repo('frontend/editor/src/i18n/en.json')),
        de: JSON.parse(repo('frontend/editor/src/i18n/de.json')),
      },
    );
    expect(problems).toEqual([]);
  });

  it('finds every permission of the API described', () => {
    const { permissions, problems } = parsePermissions(repo);
    expect(problems).toEqual([]);
    expect(permissions.map((p) => p.name)).toEqual([
      'content.read',
      'content.read.draft',
      'content.edit',
      'content.review',
      'content.approve',
      'release.publish',
      'translation.manage',
      'webhook.manage',
      'admin.roles',
      'admin.branding',
      'admin.backups',
      'scim.provision',
    ]);
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
