import { docsConfig } from '../docs.config';
import { brandingLinks } from './branding/branding.service';

describe('brandingLinks', () => {
  it('links the default brand’s PNG and SVG tab icons, the home-screen icon and the manifest', () => {
    expect(brandingLinks(docsConfig.branding)).toEqual([
      {
        rel: 'icon',
        href: 'assets/brand/favicon-16.png',
        type: 'image/png',
        sizes: '16x16',
      },
      {
        rel: 'icon',
        href: 'assets/brand/favicon-32.png',
        type: 'image/png',
        sizes: '32x32',
      },
      { rel: 'icon', href: 'assets/brand/favicon.svg', type: 'image/svg+xml' },
      {
        rel: 'apple-touch-icon',
        href: 'assets/brand/apple-touch-icon-180.png',
        sizes: '180x180',
      },
      { rel: 'manifest', href: 'manifest.webmanifest' },
    ]);
  });

  it('links only the favicon when the branding names nothing else', () => {
    expect(
      brandingLinks({
        productName: 'Docs',
        logo: { small: 'logo.svg' },
        favicon: 'icon.png',
      }),
    ).toEqual([{ rel: 'icon', href: 'icon.png' }]);
  });
});
