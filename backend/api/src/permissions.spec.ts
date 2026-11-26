import {
  GLOBAL_PERMISSIONS,
  Permission,
  PERMISSIONS,
  READ_PERMISSIONS,
} from './access/core/permissions.js';
import { REGISTERED_PERMISSIONS } from './permissions.js';

// Every permission there was before the components registered their own: the same keys in the
// same order (roles store and answer them in it), the same texts and the same global and read
// ones. A change here changes stored roles, the API or the permissions reference.
const TODAY = [
  {
    key: 'content.read',
    group: 'content',
    labelKey: 'editor.admin.permissions.contentRead',
    description: 'Read released content (`main` and release tags).',
    global: false,
    read: true,
  },
  {
    key: 'content.read.draft',
    group: 'content',
    labelKey: 'editor.admin.permissions.contentReadDraft',
    description: 'Read anything else: drafts on other branches and commits.',
    global: false,
    read: true,
  },
  {
    key: 'content.edit',
    group: 'content',
    labelKey: 'editor.admin.permissions.contentEdit',
    description: 'Change content (open and edit change sets).',
    global: false,
    read: false,
  },
  {
    key: 'content.review',
    group: 'content',
    labelKey: 'editor.admin.permissions.contentReview',
    description: 'Review a change.',
    global: false,
    read: false,
  },
  {
    key: 'content.approve',
    group: 'content',
    labelKey: 'editor.admin.permissions.contentApprove',
    description: 'Sign off a change; restricted module types need it.',
    global: false,
    read: false,
  },
  {
    key: 'release.publish',
    group: 'releases',
    labelKey: 'editor.admin.permissions.releasePublish',
    description: 'Cut a release.',
    global: false,
    read: false,
  },
  {
    key: 'translation.manage',
    group: 'translations',
    labelKey: 'editor.admin.permissions.translationManage',
    description: 'Order and accept translations.',
    global: false,
    read: false,
  },
  {
    key: 'webhook.manage',
    group: 'webhooks',
    labelKey: 'editor.admin.permissions.webhookManage',
    description: 'Configure webhooks.',
    global: true,
    read: false,
  },
  {
    key: 'admin.roles',
    group: 'access',
    labelKey: 'editor.admin.permissions.adminRoles',
    description: 'Define roles and assign them.',
    global: true,
    read: false,
  },
  {
    key: 'admin.branding',
    group: 'branding',
    labelKey: 'editor.admin.permissions.adminBranding',
    description:
      "Set the platform's branding: name, logos, icons and colours (#169).",
    global: true,
    read: false,
  },
  {
    key: 'admin.backups',
    group: 'backups',
    labelKey: 'editor.admin.permissions.adminBackups',
    description:
      "Configure the instance's backups, see their runs and hold the backup key (#529).",
    global: true,
    read: false,
  },
  {
    key: 'scim.provision',
    group: 'scim',
    labelKey: 'editor.admin.permissions.scimProvision',
    description:
      "Provision users and groups from a directory over SCIM 2.0 (#377): held by the service account a directory's token belongs to, and only there (`/scim/v2` refuses anyone else).",
    global: true,
    read: false,
  },
];

describe('the permission registry', () => {
  it('yields exactly the permissions there were, in their order', () => {
    expect(
      REGISTERED_PERMISSIONS.map((p) => ({
        key: p.key,
        group: p.group,
        labelKey: p.labelKey,
        description: p.description,
        global: p.global ?? false,
        read: p.read ?? false,
      })),
    ).toEqual(TODAY);
  });

  it('gives access the same lists, the same global and read ones', () => {
    expect([...PERMISSIONS]).toEqual(TODAY.map((p) => p.key));
    expect(Permission.options).toEqual(TODAY.map((p) => p.key));
    expect([...GLOBAL_PERMISSIONS]).toEqual(
      TODAY.filter((p) => p.global).map((p) => p.key),
    );
    expect([...READ_PERMISSIONS]).toEqual(
      TODAY.filter((p) => p.read).map((p) => p.key),
    );
  });

  it('keeps the keys literal, so checking one nobody registered does not compile', () => {
    // @ts-expect-error: no component registers it.
    const unknown: Permission = 'content.fly';
    expect(Permission.safeParse(unknown).success).toBe(false);
  });

  it('cannot be changed once registered', () => {
    expect(Object.isFrozen(REGISTERED_PERMISSIONS)).toBe(true);
    expect(REGISTERED_PERMISSIONS.every((p) => Object.isFrozen(p))).toBe(true);
    for (const set of [GLOBAL_PERMISSIONS, READ_PERMISSIONS] as Set<string>[]) {
      expect(() => set.add('content.edit')).toThrow(TypeError);
      expect(() => set.delete('content.read')).toThrow(TypeError);
      expect(() => set.clear()).toThrow(TypeError);
    }
    expect(GLOBAL_PERMISSIONS.has('content.edit')).toBe(false);
    expect([...READ_PERMISSIONS]).toEqual([
      'content.read',
      'content.read.draft',
    ]);
  });
});
