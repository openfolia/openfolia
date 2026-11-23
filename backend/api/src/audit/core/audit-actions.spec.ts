import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from './audit-actions.js';
import { AuditAction } from './audit-event.js';

describe('the audit actions catalogue', () => {
  it('lists each action once, sorted, in the format the log takes', () => {
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(0);
    expect([...AUDIT_ACTIONS]).toEqual([...new Set(AUDIT_ACTIONS)].sort());
    for (const action of AUDIT_ACTIONS) {
      expect(AuditAction.safeParse(action).success, action).toBe(true);
    }
  });

  it('holds the group mappings’ actions (#692)', () => {
    expect(AUDIT_ACTIONS).toContain('group-mapping.create');
    expect(AUDIT_ACTIONS).toContain('group-mapping.delete');
  });
});
