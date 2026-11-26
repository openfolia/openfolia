import { MAX_COUNT } from '../core/scim-list.js';
import {
  ENTERPRISE_USER_SCHEMA,
  GROUP_SCHEMA,
  type JsonObject,
  USER_SCHEMA,
} from '../core/scim-json.js';

/**
 * What a directory reads to learn what this server supports (RFC 7644, section 4; RFC 7643,
 * sections 5 to 7): the service provider's configuration, the resource types and their schemas.
 * Static: answered the same to every directory.
 */

const SERVICE_PROVIDER_CONFIG_SCHEMA =
  'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const RESOURCE_TYPE_SCHEMA =
  'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

/** What the server supports: patch and filters; no bulk, sorting, ETags or password changes. */
export const serviceProviderConfig = (base: string): JsonObject => ({
  schemas: [SERVICE_PROVIDER_CONFIG_SCHEMA],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAX_COUNT },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'Bearer token',
      description:
        'A service account’s token (ccms_sat_…) whose roles hold scim.provision, as Authorization: Bearer <token>.',
      primary: true,
    },
  ],
  meta: {
    resourceType: 'ServiceProviderConfig',
    location: `${base}/ServiceProviderConfig`,
  },
});

/** The resource types: users (with the enterprise extension) and groups. */
export const resourceTypes = (base: string): JsonObject[] => [
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    description: 'A person who signs in to the editor.',
    schema: USER_SCHEMA,
    schemaExtensions: [{ schema: ENTERPRISE_USER_SCHEMA, required: false }],
    meta: {
      resourceType: 'ResourceType',
      location: `${base}/ResourceTypes/User`,
    },
  },
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: 'Group',
    name: 'Group',
    endpoint: '/Groups',
    description:
      'A group of users; group mappings give its members roles by its name.',
    schema: GROUP_SCHEMA,
    meta: {
      resourceType: 'ResourceType',
      location: `${base}/ResourceTypes/Group`,
    },
  },
];

interface AttrOptions {
  readonly multiValued?: boolean;
  readonly required?: boolean;
  readonly caseExact?: boolean;
  readonly mutability?: 'readOnly' | 'readWrite' | 'immutable' | 'writeOnly';
  readonly returned?: 'always' | 'never' | 'default' | 'request';
  readonly uniqueness?: 'none' | 'server' | 'global';
  readonly subAttributes?: readonly JsonObject[];
  readonly canonicalValues?: readonly string[];
}

/** One attribute's definition, with the standard's defaults (RFC 7643, section 7). */
function attr(
  name: string,
  type: string,
  options: AttrOptions = {},
): JsonObject {
  return {
    name,
    type,
    multiValued: options.multiValued ?? false,
    description: '',
    required: options.required ?? false,
    caseExact: options.caseExact ?? false,
    mutability: options.mutability ?? 'readWrite',
    returned: options.returned ?? 'default',
    uniqueness: options.uniqueness ?? 'none',
    ...(options.subAttributes && { subAttributes: options.subAttributes }),
    ...(options.canonicalValues && {
      canonicalValues: options.canonicalValues,
    }),
  };
}

/** `value`, `display`, `type` and `primary`: the sub-attributes of a multi-valued attribute. */
const multi = (name: string, types: readonly string[] = []) =>
  attr(name, 'complex', {
    multiValued: true,
    subAttributes: [
      attr('value', 'string'),
      attr('display', 'string'),
      attr('type', 'string', { canonicalValues: types }),
      attr('primary', 'boolean'),
    ],
  });

const reference = (name: string, mutability: AttrOptions['mutability']) =>
  attr(name, 'complex', {
    multiValued: true,
    mutability,
    subAttributes: [
      attr('value', 'string', { caseExact: true, mutability }),
      attr('$ref', 'reference', { mutability }),
      attr('display', 'string', { mutability }),
      attr('type', 'string', { mutability }),
    ],
  });

const schemas = (base: string): JsonObject[] => [
  {
    schemas: [SCHEMA_SCHEMA],
    id: USER_SCHEMA,
    name: 'User',
    description: 'A person who signs in to the editor.',
    attributes: [
      attr('userName', 'string', { required: true, uniqueness: 'server' }),
      attr('name', 'complex', {
        subAttributes: [
          'formatted',
          'familyName',
          'givenName',
          'middleName',
          'honorificPrefix',
          'honorificSuffix',
        ].map((n) => attr(n, 'string')),
      }),
      ...[
        'displayName',
        'nickName',
        'title',
        'userType',
        'preferredLanguage',
        'locale',
        'timezone',
      ].map((n) => attr(n, 'string')),
      attr('profileUrl', 'reference'),
      attr('active', 'boolean'),
      attr('password', 'string', {
        mutability: 'writeOnly',
        returned: 'never',
      }),
      multi('emails', ['work', 'home', 'other']),
      multi('phoneNumbers', [
        'work',
        'home',
        'mobile',
        'fax',
        'pager',
        'other',
      ]),
      multi('ims'),
      multi('photos', ['photo', 'thumbnail']),
      attr('addresses', 'complex', {
        multiValued: true,
        subAttributes: [
          'formatted',
          'streetAddress',
          'locality',
          'region',
          'postalCode',
          'country',
          'type',
        ]
          .map((n) => attr(n, 'string'))
          .concat(attr('primary', 'boolean')),
      }),
      reference('groups', 'readOnly'),
      multi('entitlements'),
      multi('roles'),
      multi('x509Certificates'),
    ],
    meta: {
      resourceType: 'Schema',
      location: `${base}/Schemas/${USER_SCHEMA}`,
    },
  },
  {
    schemas: [SCHEMA_SCHEMA],
    id: GROUP_SCHEMA,
    name: 'Group',
    description:
      'A group of users; group mappings give its members roles by its name.',
    attributes: [
      attr('displayName', 'string', {
        required: true,
        caseExact: true,
        uniqueness: 'server',
      }),
      reference('members', 'readWrite'),
    ],
    meta: {
      resourceType: 'Schema',
      location: `${base}/Schemas/${GROUP_SCHEMA}`,
    },
  },
  {
    schemas: [SCHEMA_SCHEMA],
    id: ENTERPRISE_USER_SCHEMA,
    name: 'EnterpriseUser',
    description:
      'The enterprise user extension: kept as the directory sends it.',
    attributes: [
      ...[
        'employeeNumber',
        'costCenter',
        'organization',
        'division',
        'department',
      ].map((n) => attr(n, 'string')),
      attr('manager', 'complex', {
        subAttributes: [
          attr('value', 'string'),
          attr('$ref', 'reference'),
          attr('displayName', 'string', { mutability: 'readOnly' }),
        ],
      }),
    ],
    meta: {
      resourceType: 'Schema',
      location: `${base}/Schemas/${ENTERPRISE_USER_SCHEMA}`,
    },
  },
];

export { schemas as scimSchemas };
