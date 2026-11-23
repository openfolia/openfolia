import type { Item } from '../../api';
import { ID_MAX, ROLE_ID } from '../admin-model';

export type GroupMappingItem = Item<'/group-mappings'>;

/** Page sizes of the mappings table. */
export const MAPPING_PAGE_SIZES = [25, 50, 100] as const;

/** The longest group name the API takes (`POST /group-mappings`). */
export const GROUP_MAX = 256;

/** A mapping to add: the group's name as the provider sends it, and the role its members hold. */
export interface MappingDraft {
  readonly group: string;
  readonly roleId: string;
}

/**
 * What is wrong with a draft, by field, as translation keys; empty when nothing is. The group's
 * name is checked as it will be sent: without spaces at either end (`trimmedGroup`), since the
 * API compares names exactly and a provider never sends such spaces.
 */
export function mappingProblems(draft: MappingDraft): {
  group?: string;
  role?: string;
} {
  const problems: { group?: string; role?: string } = {};
  const group = trimmedGroup(draft.group);
  if (group === '' || group.includes('\u0000')) {
    problems.group = 'editor.admin.groupMappings.problems.group';
  } else if (group.length > GROUP_MAX) {
    problems.group = 'editor.admin.groupMappings.problems.groupLength';
  }
  if (draft.roleId === '') {
    problems.role = 'editor.admin.groupMappings.problems.role';
  }
  return problems;
}

/** The group's name as it is sent: without spaces (or line breaks) at either end. */
export function trimmedGroup(group: string): string {
  return group.trim();
}

/** Whether the address's role filter is a role ID, as `filter[role]` takes it. */
export function isRoleFilter(value: string): boolean {
  return value.length <= ID_MAX && ROLE_ID.test(value);
}
