import type { AuditEvent } from './audit-event.js';
import {
  auditCsvHeader,
  auditCsvLine,
  auditJsonLine,
  describeAuditFilter,
} from './audit-export.js';

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: '42',
  at: new Date('2026-03-04T05:06:07.089Z'),
  kind: 'write',
  actor: { kind: 'user', id: 'sample-admin' },
  action: 'role.assign',
  subject: { type: 'user', id: 'sample-reader' },
  comment: null,
  data: {},
  ...over,
});

describe('audit export formats', () => {
  it('writes the CSV header and a row, CRLF-terminated', () => {
    expect(auditCsvHeader()).toBe(
      'id,at,actor kind,actor id,action,subject type,subject id,comment,data,kind\r\n',
    );
    expect(auditCsvLine(event({ data: { role: 'reviewer' } }))).toBe(
      '42,2026-03-04T05:06:07.089Z,user,sample-admin,role.assign,user,sample-reader,,"{""role"":""reviewer""}",write\r\n',
    );
  });

  it('quotes a cell a spreadsheet would run as a formula, and line breaks', () => {
    const line = auditCsvLine(
      event({
        comment: '=HYPERLINK("http://example.invalid")',
        subject: { type: 'module', id: '+en/a' },
        data: {},
      }),
    );
    expect(line).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect(line).toContain(`'+en/a`);
    expect(auditCsvLine(event({ comment: 'two\nlines' }))).toContain(
      '"two\nlines"',
    );
  });

  it('writes one JSON line per event, line breaks escaped', () => {
    const line = auditJsonLine(
      event({ comment: 'two\nlines ', data: { nested: { a: [1] } } }),
    );
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(JSON.parse(line)).toEqual({
      id: '42',
      at: '2026-03-04T05:06:07.089Z',
      kind: 'write',
      actor: { kind: 'user', id: 'sample-admin' },
      action: 'role.assign',
      subject: { type: 'user', id: 'sample-reader' },
      comment: 'two\nlines ',
      data: { nested: { a: [1] } },
    });
  });

  it('describes a filter as its query values, only those set', () => {
    expect(describeAuditFilter({})).toEqual({});
    expect(
      describeAuditFilter({
        subject: { type: 'module', id: 'en/a' },
        actor: { kind: 'service', id: 'importer' },
        action: 'module.edit',
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-02-01T00:00:00Z'),
      }),
    ).toEqual({
      subject: 'module/en/a',
      actor: 'service/importer',
      action: 'module.edit',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
    expect(
      describeAuditFilter({
        subject: { type: 'role' },
        actor: { kind: 'user' },
      }),
    ).toEqual({ subject: 'role', actor: 'user' });
  });
});
