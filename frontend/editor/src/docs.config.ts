/**
 * Branding: the product name and the logos, in one place, so the platform is rebranded without
 * touching a component. Colours, radius and fonts are in `frontend/theme/src/theme.css`.
 * URLs are relative to the app's base href. The defaults are the product's own brand, OpenFolia,
 * from `@openfolia/theme` (`frontend/theme/src/brand/`, served at `assets/brand/`); an installation's
 * branding replaces them here.
 */
export interface DocsConfig {
  branding: {
    /** The logo's accessible name and the breadcrumb's home. */
    productName: string;
    logo: {
      /** Square mark: collapsed sidebar, favicon fallback. */
      small: string;
      /** The square mark on a dark page; without it, `small` there too. */
      smallDark?: string;
      /** Mark and name: expanded sidebar, sign-in page. Optional: `small` plus the name then. */
      full?: string;
      /** The full logo on a dark page; without it, `full` there too. */
      fullDark?: string;
    };
    /** The browser tab's icon (an SVG may follow the device's light or dark setting). */
    favicon: string;
    /** The tab icon as PNG by size in pixels, for a browser that shows no SVG icon; optional. */
    faviconPng?: { readonly 16?: string; readonly 32?: string };
    /** The icon a phone puts on its home screen (180 × 180 PNG); optional. */
    appleTouchIcon?: string;
    /** The web app manifest (the name and the 192 and 512 px icons to install the app); optional. */
    manifest?: string;
  };
}

export const docsConfig: DocsConfig = {
  branding: {
    productName: 'OpenFolia',
    // "color-light" is the artwork for light backgrounds, "color-dark" the one for dark ones.
    logo: {
      small: 'assets/brand/openfolia-mark-color-light.svg',
      smallDark: 'assets/brand/openfolia-mark-color-dark.svg',
      full: 'assets/brand/openfolia-lockup-horizontal-color-light.svg',
      fullDark: 'assets/brand/openfolia-lockup-horizontal-color-dark.svg',
    },
    // The app icon: the Iron Grey square reads on a light and a dark tab bar alike.
    favicon: 'assets/brand/favicon.svg',
    faviconPng: {
      16: 'assets/brand/favicon-16.png',
      32: 'assets/brand/favicon-32.png',
    },
    appleTouchIcon: 'assets/brand/apple-touch-icon-180.png',
    manifest: 'manifest.webmanifest',
  },
};
