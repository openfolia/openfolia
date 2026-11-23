import { decide } from '../permissions/permissions';
import { ALL_PERMISSIONS } from '../permissions/me';
import { adminPages, matchesPage } from './palette-pages';

const pagesFor = (permissions: readonly string[]) => {
  const granted = new Set(permissions);
  return adminPages((rule) => decide(granted, rule).kind !== 'hidden');
};

describe('adminPages (#591)', () => {
  it('lists every admin page under its group, and every settings topic after Project settings', () => {
    const pages = pagesFor(ALL_PERMISSIONS);
    const ids = pages.map((p) => p.id);
    expect(ids.slice(0, 5)).toEqual([
      'admin/users',
      'admin/roles',
      'admin/group-mappings',
      'admin/service-accounts',
      'admin/settings',
    ]);
    expect(ids).toContain('admin/audit');
    expect(pages.find((p) => p.id === 'admin/users')).toEqual({
      id: 'admin/users',
      trail: [
        'editor.nav.admin',
        'editor.admin.groups.people',
        'editor.admin.tabs.users',
      ],
      link: ['/admin', 'users'],
    });
    expect(pages.find((p) => p.id === 'admin/settings/languages')).toEqual({
      id: 'admin/settings/languages',
      trail: [
        'editor.nav.admin',
        'editor.admin.tabs.settings',
        'editor.admin.settings.sections.languages',
      ],
      link: ['/admin', 'settings', 'languages'],
    });
  });

  it('lists only what the role opens: no settings topic without Project settings', () => {
    expect(
      pagesFor(['content.read', 'webhook.manage', 'admin.branding']).map(
        (p) => p.id,
      ),
    ).toEqual(['admin/branding', 'admin/webhooks']);
    expect(pagesFor(['content.read'])).toEqual([]);
  });
});

describe('matchesPage', () => {
  it('needs every word, in any case and with or without accents', () => {
    expect(matchesPage('Admin › Project settings › Languages', 'lang')).toBe(
      true,
    );
    expect(
      matchesPage('Admin › Project settings › Languages', 'SET lang'),
    ).toBe(true);
    expect(
      matchesPage('Admin › Projekteinstellungen › Übersetzung', 'uber'),
    ).toBe(true);
    expect(matchesPage('Admin › Look › Branding', 'brand users')).toBe(false);
    expect(matchesPage('Admin › Look › Branding', '   ')).toBe(false);
  });
});
