import { decide } from '../permissions/permissions';
import { ALL_PERMISSIONS } from '../permissions/me';
import {
  ADMIN_GROUP_TITLES,
  ADMIN_GROUPS,
  ADMIN_TABS,
  groupTabs,
  NAV_ITEMS,
  tabRule,
} from './nav';

const admin = NAV_ITEMS.find((item) => item.path === 'admin')!;
const shown = (permissions: readonly string[]) => {
  const granted = new Set(permissions);
  return {
    entry: decide(granted, admin.rule).kind !== 'hidden',
    tabs: ADMIN_TABS.filter(
      (tab) => decide(granted, tabRule(tab)).kind !== 'hidden',
    ).map((tab) => tab.path),
  };
};

describe('the Admin entry and its tabs', () => {
  it('shows Backups only to an admin.backups holder, and the entry with it (#529)', () => {
    expect(shown(['admin.backups'])).toEqual({
      entry: true,
      tabs: ['backups'],
    });
    expect(shown(['content.read.draft']).tabs).not.toContain('backups');
    expect(shown(['admin.roles']).tabs).not.toContain('backups');
  });

  it('shows Page design to a draft reader, and the entry with it (#392)', () => {
    expect(shown(['content.read.draft'])).toEqual({
      entry: true,
      tabs: ['page-designs'],
    });
  });

  it('hides the entry from someone holding none of them', () => {
    expect(shown(['content.read']).entry).toBe(false);
  });
});

describe('the rail groups (#591)', () => {
  const groupsFor = (permissions: readonly string[]) => {
    const granted = new Set(permissions);
    return groupTabs(
      ADMIN_TABS.filter(
        (tab) => decide(granted, tabRule(tab)).kind !== 'hidden',
      ),
    ).map((g) => [g.group, g.tabs.map((t) => t.path)]);
  };

  it('puts every page in one of five groups, in rail order', () => {
    expect(groupsFor(ALL_PERMISSIONS)).toEqual([
      ['people', ['users', 'roles', 'group-mappings', 'service-accounts']],
      ['content', ['settings', 'variants', 'page-designs', 'import']],
      ['look', ['branding']],
      ['integrations', ['webhooks']],
      ['operations', ['system', 'backups', 'audit']],
    ]);
    expect(ADMIN_GROUPS.map((g) => ADMIN_GROUP_TITLES[g])).toEqual([
      'editor.admin.groups.people',
      'editor.admin.groups.content',
      'editor.admin.groups.look',
      'editor.admin.groups.integrations',
      'editor.admin.groups.operations',
    ]);
  });

  it('leaves out a group with no page the role opens', () => {
    expect(
      groupsFor(['content.read.draft', 'admin.branding', 'admin.backups']),
    ).toEqual([
      ['content', ['page-designs']],
      ['look', ['branding']],
      ['operations', ['backups']],
    ]);
  });
});
