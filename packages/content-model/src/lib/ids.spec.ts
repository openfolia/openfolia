import { FileName, MediaType, toFileName } from './ids.js';

describe('toFileName', () => {
  it('keeps a plain file name as it is', () => {
    expect(toFileName('config-v2.zip')).toBe('config-v2.zip');
    expect(toFileName('Daten Übersicht.json')).toBe('Daten Übersicht.json');
    expect(toFileName('.env.sample')).toBe('.env.sample');
  });

  it('keeps only the last path segment', () => {
    expect(toFileName('C:\\Users\\a\\report.pdf')).toBe('report.pdf');
    expect(toFileName('../../etc/passwd')).toBe('passwd');
  });

  it('replaces what a file name cannot hold', () => {
    expect(toFileName('a"b<c>|d?.zip')).toBe('a_b_c__d_.zip');
    expect(toFileName('evil\u202Egpj.exe')).toBe('evil_gpj.exe');
    expect(toFileName('line\r\nbreak.txt')).toBe('line__break.txt');
    expect(toFileName('  tabs \t and   spaces . ')).toBe('tabs _ and spaces');
  });

  it('gives nothing for a name of dots or spaces', () => {
    expect(toFileName('')).toBeUndefined();
    expect(toFileName('..')).toBeUndefined();
    expect(toFileName(' . ')).toBeUndefined();
    expect(toFileName('dir/')).toBeUndefined();
  });

  it('cuts a long name to 255 characters, keeping its extension', () => {
    const name = toFileName(`${'a'.repeat(300)}.tar.gz`);
    expect(name).toHaveLength(255);
    expect(name?.endsWith('.gz')).toBe(true);
    // A surrogate pair is never split.
    const emoji = toFileName(`${'😀'.repeat(200)}.zip`) ?? '';
    expect(emoji.length).toBeLessThanOrEqual(255);
    expect(emoji.endsWith('😀.zip')).toBe(true);
  });

  it('never leaves a cut name ending in a dot, nor a lone surrogate or an invisible character', () => {
    const cut = toFileName(`${'a'.repeat(254)}.${'b'.repeat(50)}`);
    expect(cut).toBe('a'.repeat(254));
    expect(toFileName(cut ?? '')).toBe(cut);
    expect(toFileName('\ud800.zip')).toBe('_.zip');
    expect(toFileName('a\udc00b.zip')).toBe('a_b.zip');
    expect(toFileName('photo 😀.zip')).toBe('photo 😀.zip');
    for (const mark of ['\u200b', '\u200d', '\u2060', '\ufeff', '\u061c']) {
      expect(toFileName(`invoice.html${mark}`)).toBe('invoice.html_');
    }
    for (const raw of [`${'a'.repeat(260)}. .`, `${'a'.repeat(254)}. b`]) {
      const name = toFileName(raw) ?? '';
      expect(FileName.safeParse(name).success).toBe(true);
    }
  });

  it('writes names in NFC', () => {
    expect(toFileName('Cafe\u0301.txt')).toBe('Caf\u00e9.txt');
  });
});

describe('FileName and MediaType', () => {
  it('accept what toFileName keeps, and nothing else', () => {
    expect(FileName.safeParse('config.zip').success).toBe(true);
    for (const bad of [
      '',
      'a/b',
      'a\\b',
      'trailing.',
      ' lead',
      'a\u0000b',
      'x'.repeat(256),
    ]) {
      expect(FileName.safeParse(bad).success).toBe(false);
    }
  });

  it('accept a lowercase type/subtype only', () => {
    expect(MediaType.safeParse('application/vnd.ms-excel').success).toBe(true);
    for (const bad of [
      'Application/zip',
      'text/html; charset=utf-8',
      'zip',
      'a/',
    ]) {
      expect(MediaType.safeParse(bad).success).toBe(false);
    }
  });
});
