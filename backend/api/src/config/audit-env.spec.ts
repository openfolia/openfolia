import { AuditEnv, auditSinkTarget, checkAuditEnv } from './audit-env.js';

const SECRET = `whsec_${'0f'.repeat(32)}`;

const parse = (settings: Record<string, string>) =>
  AuditEnv.superRefine(checkAuditEnv).safeParse(settings);

describe('auditSinkTarget', () => {
  it('reads https:// and syslog+tls:// URLs', () => {
    expect(auditSinkTarget('https://logs.example.org/in?x=1')).toEqual({
      kind: 'https',
      url: new URL('https://logs.example.org/in?x=1'),
    });
    expect(auditSinkTarget('syslog+tls://logs.example.org')).toEqual({
      kind: 'syslog',
      host: 'logs.example.org',
      port: 6514,
    });
    expect(auditSinkTarget('syslog+tls://10.0.0.5:10514')).toEqual({
      kind: 'syslog',
      host: '10.0.0.5',
      port: 10514,
    });
    expect(auditSinkTarget('syslog+tls://[::1]:6514')).toEqual({
      kind: 'syslog',
      host: '::1',
      port: 6514,
    });
  });

  it('refuses anything else, never repeating the value', () => {
    for (const value of [
      'http://logs.example.org',
      'syslog://logs.example.org',
      'not a url',
      'https://user:pw@logs.example.org',
      'https://logs.example.org/#x',
      'syslog+tls://logs.example.org/path',
      'syslog+tls://logs.example.org?x=1',
    ]) {
      const problem = auditSinkTarget(value);
      expect(typeof problem).toBe('string');
      expect(problem).not.toContain('logs.example.org');
    }
  });
});

describe('AuditEnv', () => {
  it('defaults to no sink, kept for ever', () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      CCMS_AUDIT_SINK_POLL_MS: 3_000,
      CCMS_AUDIT_SINK_TIMEOUT_MS: 10_000,
    });
  });

  it('needs the secret with an https:// sink, not with syslog', () => {
    expect(
      parse({ CCMS_AUDIT_SINK_URL: 'https://l.example.org' }).success,
    ).toBe(false);
    expect(
      parse({
        CCMS_AUDIT_SINK_URL: 'https://l.example.org',
        CCMS_AUDIT_SINK_SECRET: SECRET,
      }).success,
    ).toBe(true);
    expect(
      parse({ CCMS_AUDIT_SINK_URL: 'syslog+tls://l.example.org' }).success,
    ).toBe(true);
  });

  it('refuses a malformed secret, a relative CA file, a period out of range, and settings without a URL', () => {
    const bad: Record<string, string>[] = [
      {
        CCMS_AUDIT_SINK_URL: 'https://l.example.org',
        CCMS_AUDIT_SINK_SECRET: 'whsec_short',
      },
      {
        CCMS_AUDIT_SINK_URL: 'syslog+tls://l.example.org',
        CCMS_AUDIT_SINK_CA_FILE: 'ca.pem',
      },
      { CCMS_AUDIT_KEEP_DAYS: '0' },
      { CCMS_AUDIT_KEEP_DAYS: '36501' },
      { CCMS_AUDIT_SINK_SECRET: SECRET },
      { CCMS_AUDIT_SINK_CA_FILE: '/etc/ca.pem' },
      { CCMS_AUDIT_SINK_URL: 'ftp://l.example.org' },
    ];
    for (const settings of bad) {
      const result = parse(settings);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain(SECRET);
    }
    expect(
      parse({ CCMS_AUDIT_KEEP_DAYS: '365' }).data?.CCMS_AUDIT_KEEP_DAYS,
    ).toBe(365);
  });
});
