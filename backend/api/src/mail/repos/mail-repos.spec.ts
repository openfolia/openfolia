import { Readable } from 'node:stream';
import sharp from 'sharp';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { FakeBrandingStore } from '../../../tests/fakes/fake-branding-store.js';
import { DEFAULT_PRODUCT_NAME } from '../../branding/core/branding.js';
import { BrandingMailBrand, LOGO_HEIGHT } from './branding-mail-brand.js';
import { classify } from './smtp-mailer.js';

describe('classify', () => {
  it.each([
    [{ code: 'EAUTH', responseCode: 535 }, 'auth', false],
    [{ code: 'ETLS' }, 'tls', false],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'tls', false],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls', false],
    [{ code: 'EENVELOPE', responseCode: 550 }, 'rejected', true],
    [{ code: 'EMESSAGE', responseCode: 452 }, 'unavailable', false],
    [{ code: 'ECONNECTION' }, 'unavailable', false],
    [new Error('anything'), 'unavailable', false],
  ])('%j is %s', (error, kind, final) => {
    const classified = classify(error);
    expect(classified.kind).toBe(kind);
    expect(classified.final).toBe(final);
  });

  it('keeps only the code, never a reply', () => {
    const error = Object.assign(new Error('550 no such user a@example.com'), {
      code: 'EENVELOPE',
      responseCode: 550,
      response: '550 no such user a@example.com',
    });
    expect(classify(error).message).not.toContain('example.com');
    expect(classify(error).code).toBe('EENVELOPE 550');
  });
});

describe('BrandingMailBrand', () => {
  async function withLogo(
    format: 'png' | 'webp',
    width: number,
    height: number,
  ) {
    const branding = new FakeBrandingStore();
    const blobs = new FakeBlobStore();
    const bytes = await sharp({
      create: { width, height, channels: 4, background: '#0b5394' },
    })
      [format]()
      .toBuffer();
    const { sha256 } = await blobs.put(Readable.from([bytes]), {
      contentType: `image/${format}`,
      maxBytes: 1024 * 1024,
    });
    branding.stored = {
      ...branding.stored,
      branding: {
        ...branding.stored.branding,
        productName: 'Manuals',
        primary: '#0b5394',
        logoLight: sha256,
      },
    };
    return { source: new BrandingMailBrand(branding, blobs), blobs, sha256 };
  }

  it('takes the name, colour and the light logo as a PNG at twice its size', async () => {
    const { source } = await withLogo('webp', 800, 200);
    const brand = await source.read();
    expect(brand.productName).toBe('Manuals');
    expect(brand.primary).toBe('#0b5394');
    expect(brand.logo).toMatchObject({ width: 160, height: LOGO_HEIGHT });
    const meta = await sharp(brand.logo!.png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.height).toBe(LOGO_HEIGHT * 2);
  });

  it('keeps the converted logo for the next email', async () => {
    const { source, blobs } = await withLogo('png', 400, 100);
    const first = await source.read();
    blobs.down = true;
    expect((await source.read()).logo).toBe(first.logo);
  });

  it('leaves out a logo that cannot be read', async () => {
    const { source, blobs } = await withLogo('png', 400, 100);
    blobs.down = true;
    expect((await source.read()).logo).toBeNull();
  });

  it('names the default product without a branding', async () => {
    const source = new BrandingMailBrand(
      new FakeBrandingStore(),
      new FakeBlobStore(),
    );
    expect(await source.read()).toEqual({
      productName: DEFAULT_PRODUCT_NAME,
      primary: null,
      logo: null,
    });
    expect(await source.productName()).toBe(DEFAULT_PRODUCT_NAME);
  });
});
