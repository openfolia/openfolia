import { defaultName, fileTypeName } from './attachment-model';

describe('fileTypeName', () => {
  it('gives the short names people know, and none for what says nothing', () => {
    expect(fileTypeName('application/zip')).toBe('ZIP');
    expect(fileTypeName('application/json; charset=utf-8')).toBe('JSON');
    expect(fileTypeName('application/pdf')).toBe('PDF');
    expect(fileTypeName('image/svg+xml')).toBe('SVG');
    expect(
      fileTypeName(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('DOCX');
    expect(fileTypeName('text/plain')).toBe('Text');
    expect(fileTypeName('application/octet-stream')).toBeNull();
    expect(fileTypeName('application/x-custom')).toBeNull();
    expect(fileTypeName('application/vnd.some-vendor.format')).toBeNull();
    expect(fileTypeName(null)).toBeNull();
  });
});

describe('defaultName', () => {
  it('is the file name without its extension, with separators as spaces', () => {
    expect(defaultName('sample_settings-v2.zip')).toBe('sample settings v2');
    expect(defaultName('readme')).toBe('readme');
    expect(defaultName('.profile')).toBe('.profile');
    expect(defaultName('a.tar.gz')).toBe('a.tar');
  });
});
