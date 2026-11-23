import {
  type AttachmentTypeRules,
  attachmentType,
  DANGEROUS_EXTENSIONS,
  extensionOf,
  nameFits,
  NO_TYPE_RULES,
  parseTypeRules,
  refusal,
  type TypeRule,
} from './attachment-types.js';

const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));
const rules = (raw: Partial<Record<keyof AttachmentTypeRules, string>>) => {
  const parse = (list: string | undefined): TypeRule[] => {
    const parsed = parseTypeRules(list ?? '');
    if (typeof parsed === 'string') throw new Error(parsed);
    return parsed;
  };
  return {
    ...(raw.allow !== undefined ? { allow: parse(raw.allow) } : {}),
    deny: parse(raw.deny),
    open: parse(raw.open),
  };
};

describe('parseTypeRules', () => {
  it('reads media types, top-level types and extensions', () => {
    expect(parseTypeRules(' application/zip , text/*,.zip,,')).toEqual([
      { kind: 'type', type: 'application/zip' },
      { kind: 'family', top: 'text' },
      { kind: 'extension', extension: '.zip' },
    ]);
    expect(parseTypeRules('')).toEqual([]);
  });

  it('names a malformed entry', () => {
    expect(parseTypeRules('zip')).toMatch(/"zip" is neither/);
    expect(parseTypeRules('Text/HTML')).toMatch(/"Text\/HTML"/);
    expect(parseTypeRules('*/*')).toMatch(/neither/);
    expect(parseTypeRules('.ZIP')).toMatch(/neither/);
  });
});

describe('attachmentType', () => {
  it('takes the type from the extension for bytes that show none', () => {
    expect(attachmentType(bytes('{"a": 1}'), 'sample.json')).toEqual({
      mediaType: 'application/json',
      extension: '.json',
      named: 'application/json',
    });
    expect(attachmentType(bytes('a;b'), 'DATA.CSV').mediaType).toBe('text/csv');
    expect(attachmentType(bytes('\x00\x01'), 'firmware').mediaType).toBe(
      'application/octet-stream',
    );
  });

  it('takes a signature for a name that says nothing', () => {
    expect(attachmentType(bytes('PK\x03\x04rest'), 'x.unknown').mediaType).toBe(
      'application/zip',
    );
    expect(attachmentType(bytes('%PDF-1.7'), undefined).mediaType).toBe(
      'application/pdf',
    );
  });

  it('lets dangerous bytes win over any name', () => {
    for (const [content, type] of [
      ['<!DOCTYPE html><p>x', 'text/html'],
      ['﻿  <script>alert(1)</script>', 'text/html'],
      ['<?xml version="1.0"?><html xmlns="x">', 'text/html'],
      ['<svg xmlns="http://www.w3.org/2000/svg">', 'image/svg+xml'],
      ['MZ\x90\x00', 'application/vnd.microsoft.portable-executable'],
      ['\x7fELF\x02', 'application/x-elf'],
      ['#!/bin/sh\nrm -rf', 'application/x-sh'],
    ] as const) {
      const head = new Uint8Array(Buffer.from(content, 'utf8'));
      expect(attachmentType(head, 'harmless.json').mediaType).toBe(type);
    }
    const utf16 = new Uint8Array(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('<html>', 'utf16le'),
      ]),
    );
    expect(attachmentType(utf16, 'a.txt').mediaType).toBe('text/html');
  });
});

describe('extensionOf', () => {
  it('gives the last extension in lowercase, if any', () => {
    expect(extensionOf('a.tar.GZ')).toBe('.gz');
    // A name that is all extension has one: Windows opens `.hta` as such.
    expect(extensionOf('.profile')).toBe('.profile');
    expect(extensionOf('.HTA')).toBe('.hta');
    expect(extensionOf('name.')).toBeUndefined();
    expect(extensionOf('noext')).toBeUndefined();
    expect(extensionOf(undefined)).toBeUndefined();
  });
});

describe('refusal', () => {
  const file = (mediaType: string, extension?: string) => ({
    mediaType,
    ...(extension ? { extension } : {}),
  });

  it('takes ordinary files by default', () => {
    expect(refusal(file('application/zip', '.zip'), NO_TYPE_RULES)).toBe(
      undefined,
    );
    expect(refusal(file('application/json', '.json'), NO_TYPE_RULES)).toBe(
      undefined,
    );
  });

  it('refuses dangerous types and extensions by default', () => {
    for (const f of [
      file('text/html', '.html'),
      file('image/svg+xml', '.svg'),
      file('application/vnd.microsoft.portable-executable', '.exe'),
      file('application/octet-stream', '.ps1'),
      file('text/html', '.txt'),
    ]) {
      expect(refusal(f, NO_TYPE_RULES)).toEqual({ reason: 'dangerous' });
    }
  });

  it('opens a dangerous type by its type or its own extension, never another', () => {
    expect(
      refusal(file('text/html', '.html'), rules({ open: 'text/html' })),
    ).toBe(undefined);
    expect(refusal(file('text/html', '.html'), rules({ open: '.html' }))).toBe(
      undefined,
    );
    expect(
      refusal(file('image/svg+xml', '.svg'), rules({ open: '.svg' })),
    ).toBe(undefined);
    // An executable named page.html stays refused.
    expect(
      refusal(
        file('application/vnd.microsoft.portable-executable', '.html'),
        rules({ open: '.html,text/html' }),
      ),
    ).toEqual({ reason: 'dangerous' });
    expect(
      refusal(
        file('application/octet-stream', '.ps1'),
        rules({ open: '.ps1' }),
      ),
    ).toBe(undefined);
  });

  it('applies the allow list to type or extension, then the deny list', () => {
    const allowZip = rules({ allow: 'application/zip,.json' });
    expect(refusal(file('application/zip', '.zip'), allowZip)).toBe(undefined);
    expect(refusal(file('application/json', '.json'), allowZip)).toBe(
      undefined,
    );
    expect(refusal(file('application/pdf', '.pdf'), allowZip)).toEqual({
      reason: 'not-allowed',
    });
    expect(
      refusal(
        file('application/zip', '.zip'),
        rules({ deny: 'application/*' }),
      ),
    ).toEqual({ reason: 'denied' });
    // An allow list does not open a dangerous type.
    expect(
      refusal(file('text/html', '.html'), rules({ allow: 'text/html' })),
    ).toEqual({ reason: 'dangerous' });
  });
});

describe('refusal of what the bytes and the name disagree on', () => {
  const typed = (content: string, name: string) =>
    attachmentType(new Uint8Array(Buffer.from(content, 'latin1')), name);
  const PNG = '\x89PNG\r\n\x1a\n\x00';

  it('refuses a known signature under an extension of another type, even where opened', () => {
    const open = rules({ open: 'text/html,image/svg+xml,.html,.svg' });
    for (const [content, name] of [
      [PNG, 'page.html'],
      ['<!doctype html><p>x', 'data.json'],
      ['<html><body>', 'notes.txt'],
      [PNG, 'photo.jpg'],
      ['%PDF-1.7', 'manual.zip'],
    ] as const) {
      expect(refusal(typed(content, name), open)).toEqual({
        reason: 'mismatch',
      });
    }
  });

  it('takes what agrees: a ZIP container, a signature with no or an unknown name, plain text', () => {
    for (const [content, name] of [
      ['PK\x03\x04', 'report.docx'],
      ['PK\x03\x04', 'settings.zip'],
      ['PK\x03\x04', 'firmware.bin'],
      ['PK\x03\x04', 'export'],
      ['%PDF-1.7', 'manual.pdf'],
      ['a;b', 'table.csv'],
    ] as const) {
      expect(refusal(typed(content, name), NO_TYPE_RULES)).toBe(undefined);
    }
    expect(typed('PK\x03\x04', 'firmware.bin').mediaType).toBe(
      'application/zip',
    );
  });

  it('checks the lists against the bytes’ type as well as the name’s', () => {
    // ZIP bytes under a name of no known type are a ZIP: a deny or allow on ZIP holds.
    const zipAsData = typed('PK\x03\x04', 'data.dat');
    expect(refusal(zipAsData, rules({ deny: 'application/zip' }))).toEqual({
      reason: 'denied',
    });
    expect(refusal(zipAsData, rules({ allow: '.dat' }))).toEqual({
      reason: 'not-allowed',
    });
    // A deny on ZIP holds for a ZIP container too; an allow of the container takes it.
    const docx = typed('PK\x03\x04', 'report.docx');
    expect(refusal(docx, rules({ deny: 'application/zip' }))).toEqual({
      reason: 'denied',
    });
    expect(refusal(docx, rules({ allow: '.docx' }))).toBe(undefined);
  });
});

describe('nameFits', () => {
  it('lets a block name a file only as what it is', () => {
    expect(nameFits('config.zip', 'application/zip')).toBe(true);
    expect(nameFits('report.docx', 'application/zip')).toBe(true);
    expect(nameFits('settings', 'application/zip')).toBe(true);
    expect(nameFits('notes.cfg', 'application/zip')).toBe(true);
    expect(nameFits('photo.png', 'application/zip')).toBe(false);
    expect(nameFits('dump.pdf', 'application/octet-stream')).toBe(true);
  });

  it('never gives a dangerous extension to a file of another type', () => {
    for (const name of [
      'evil.html',
      'x.svg',
      'run.exe',
      'a.ps1',
      'b.js',
      'guide.url',
      'disk.iso',
      'sheet.xlsm',
      'x.settingcontent-ms',
    ]) {
      expect(nameFits(name, 'application/zip')).toBe(false);
      expect(nameFits(name, 'application/octet-stream')).toBe(false);
    }
    expect(nameFits('page.html', 'text/html')).toBe(true);
    expect(nameFits('logo.svg', 'image/svg+xml')).toBe(true);
  });
});

describe('OLE compound files and leading-dot names', () => {
  const OLE = '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\x00\x00';
  const typed = (content: string, name: string) =>
    attachmentType(new Uint8Array(Buffer.from(content, 'latin1')), name);

  it('refuses legacy Office documents and OLE bytes by default, and OLE named as text as a mismatch', () => {
    for (const [name, type] of [
      ['report.doc', 'application/msword'],
      ['sheet.xls', 'application/vnd.ms-excel'],
      ['slides.ppt', 'application/vnd.ms-powerpoint'],
      ['setup.msi', 'application/x-msi'],
      ['blob', 'application/x-ole-storage'],
    ] as const) {
      const file = typed(OLE, name);
      expect(file.mediaType).toBe(type);
      expect(refusal(file, NO_TYPE_RULES)).toEqual({ reason: 'dangerous' });
    }
    expect(refusal(typed(OLE, 'notes.txt'), NO_TYPE_RULES)).toEqual({
      reason: 'mismatch',
    });
    // Opened by its extension, a legacy document is taken.
    expect(refusal(typed(OLE, 'report.doc'), rules({ open: '.doc' }))).toBe(
      undefined,
    );
    // A macro-enabled OOXML document is a ZIP that agrees with its name, and dangerous.
    const xlsm = typed('PK\x03\x04', 'book.xlsm');
    expect(xlsm.mediaType).toBe(
      'application/vnd.ms-excel.sheet.macroenabled.12',
    );
    expect(refusal(xlsm, NO_TYPE_RULES)).toEqual({ reason: 'dangerous' });
    expect(refusal(xlsm, rules({ open: '.xlsm' }))).toBe(undefined);
  });

  it('treats a name that is all extension as having it', () => {
    expect(refusal(typed('plain words', '.hta'), NO_TYPE_RULES)).toEqual({
      reason: 'dangerous',
    });
    expect(nameFits('.hta', 'application/zip')).toBe(false);
    expect(nameFits('.doc', 'text/plain')).toBe(false);
    expect(nameFits('.bashrc', 'text/plain')).toBe(true);
  });
});

describe('DANGEROUS_EXTENSIONS', () => {
  it('refuses every one of them by default, on harmless bytes', () => {
    for (const extension of DANGEROUS_EXTENSIONS) {
      expect(extension).toMatch(/^\.[a-z0-9-]+$/);
      const file = attachmentType(bytes('plain words'), `file${extension}`);
      expect(refusal(file, NO_TYPE_RULES), extension).toEqual({
        reason: 'dangerous',
      });
      expect(nameFits(`file${extension}`, 'text/plain'), extension).toBe(false);
    }
  });
});
