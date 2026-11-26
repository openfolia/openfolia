import { ScimInvalidFilterError } from './scim-errors.js';
import { matches, parseFilter } from './scim-filter.js';
import { ENTERPRISE_USER_SCHEMA, type JsonObject } from './scim-json.js';

const jane: JsonObject = {
  id: 'jane',
  externalId: 'E-1',
  userName: 'Jane@Example.org',
  displayName: 'Jane Doe',
  name: { givenName: 'Jane', familyName: 'Doe' },
  active: true,
  emails: [
    { value: 'jane@example.org', type: 'work', primary: true },
    { value: 'jd@home.example', type: 'home' },
  ],
  [ENTERPRISE_USER_SCHEMA]: { employeeNumber: '42', department: 'Docs' },
  meta: { lastModified: '2026-11-20T10:00:00.000Z' },
};

const match = (filter: string, resource: JsonObject = jane) =>
  matches(parseFilter(filter), resource);

describe('SCIM filters', () => {
  it('compares strings ignoring case, but case-exact attributes exactly', () => {
    expect(match('userName eq "jane@example.org"')).toBe(true);
    expect(match('USERNAME Eq "JANE@EXAMPLE.ORG"')).toBe(true);
    expect(match('externalId eq "E-1"')).toBe(true);
    expect(match('externalId eq "e-1"')).toBe(false);
    expect(match('userName ne "jane@example.org"')).toBe(false);
  });

  it('knows co, sw, ew, gt, ge, lt, le and pr', () => {
    expect(match('displayName co "ne D"')).toBe(true);
    expect(match('displayName sw "jane"')).toBe(true);
    expect(match('displayName ew "doe"')).toBe(true);
    expect(match('meta.lastModified gt "2026-11-01T00:00:00Z"')).toBe(true);
    expect(match('meta.lastModified lt "2026-11-01T00:00:00Z"')).toBe(false);
    expect(match('meta.lastModified ge "2026-11-20T10:00:00.000Z"')).toBe(true);
    expect(match('meta.lastModified le "2026-11-20T10:00:00.000Z"')).toBe(true);
    expect(match('title pr')).toBe(false);
    expect(match('name.givenName pr')).toBe(true);
  });

  it('combines with and, or, not and parentheses, and takes and before or', () => {
    expect(
      match('userName eq "x" or displayName sw "Jane" and active eq true'),
    ).toBe(true);
    expect(
      match('(userName eq "x" or displayName sw "Jane") and active eq false'),
    ).toBe(false);
    expect(match('not (active eq false)')).toBe(true);
    expect(match('not(userName eq "jane@example.org")')).toBe(false);
  });

  it('looks into multi-valued attributes, value paths and extensions', () => {
    expect(match('emails eq "jd@home.example"')).toBe(true);
    expect(match('emails.value ew "@example.org"')).toBe(true);
    expect(match('emails[type eq "work" and value co "@example.org"]')).toBe(
      true,
    );
    expect(match('emails[type eq "home" and primary eq true]')).toBe(false);
    expect(match(`${ENTERPRISE_USER_SCHEMA}:employeeNumber eq "42"`)).toBe(
      true,
    );
    expect(
      match('urn:ietf:params:scim:schemas:core:2.0:User:userName sw "jane"'),
    ).toBe(true);
  });

  it('reads null, numbers and escaped strings', () => {
    expect(match('title eq null')).toBe(true);
    expect(match('displayName ne null')).toBe(true);
    expect(match('count gt 2', { count: 3 })).toBe(true);
    expect(match('displayName eq "Ja\\"ne"', { displayName: 'Ja"ne' })).toBe(
      true,
    );
  });

  it('refuses what does not parse, as invalidFilter', () => {
    for (const bad of [
      'userName',
      'userName eq',
      'userName xx "a"',
      '(userName eq "a"',
      'userName eq "a" and',
      'userName eq "a" extra',
      'emails[type eq "work"',
      'userName eq "unclosed',
      'name.givenName.more eq "a"',
      'active gt true',
      'x'.repeat(2001),
    ]) {
      expect(() => match(bad)).toThrow(ScimInvalidFilterError);
    }
  });

  it('bounds how deep a filter nests', () => {
    const deep = `${'('.repeat(40)}userName eq "a"${')'.repeat(40)}`;
    expect(() => parseFilter(deep)).toThrow(ScimInvalidFilterError);
  });
});
