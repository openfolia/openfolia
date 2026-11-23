import { SETTINGS_TOPICS } from '../admin/settings/settings-topics';
import type { PermissionRule } from '../permissions/permissions';
import {
  ADMIN_GROUP_TITLES,
  ADMIN_TABS,
  NAV_ITEMS,
  tabRule,
} from '../shell/nav';

/** A page the palette opens by name (#591). */
export interface PalettePage {
  /** Unique among the pages: the path joined. */
  readonly id: string;
  /**
   * Where the page sits, as translation keys: "Admin › <group> › <page>", or
   * "Admin › Project settings › <topic>". The last one is the page's own name.
   */
  readonly trail: readonly string[];
  /** The route, from the root. */
  readonly link: readonly string[];
}

const ADMIN = NAV_ITEMS.find((item) => item.path === 'admin');

/**
 * Every admin page and every project-settings topic the role may open (`visible`: the rule the
 * rail and the routes use), in rail order, each topic after Project settings.
 */
export function adminPages(
  visible: (rule: PermissionRule) => boolean,
): readonly PalettePage[] {
  if (!ADMIN || !visible(ADMIN.rule)) return [];
  return ADMIN_TABS.filter((tab) => visible(tabRule(tab))).flatMap((tab) => {
    const page: PalettePage = {
      id: `admin/${tab.path}`,
      trail: [ADMIN.label, ADMIN_GROUP_TITLES[tab.group], tab.label],
      link: ['/admin', tab.path],
    };
    if (tab.path !== 'settings') return [page];
    return [
      page,
      ...SETTINGS_TOPICS.map((topic): PalettePage => ({
        id: `admin/settings/${topic.path}`,
        trail: [ADMIN.label, tab.label, topic.title],
        link: ['/admin', 'settings', topic.path],
      })),
    ];
  });
}

/** Lower case without accents, so "Ubersetzung" finds "Übersetzung". */
const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Whether every word of `term` is in `label` (case and accents ignored); nothing typed: no. */
export function matchesPage(label: string, term: string): boolean {
  const words = fold(term).split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const text = fold(label);
  return words.every((word) => text.includes(word));
}
