// The portal's Astro configuration. A build is one audience in one language: `build/run.ts`
// sets where it goes (`CCMS_PORTAL_SITE_OUT`), the path it is served under
// (`CCMS_PORTAL_SITE_BASE`) and the snapshot it is made from (`CCMS_PORTAL_SNAPSHOT`, read by
// the pages). Static output only, nothing inlined: every script and stylesheet is a file of
// the site, so the pages' Content Security Policy needs no 'unsafe-inline'.
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  outDir: process.env.CCMS_PORTAL_SITE_OUT ?? './dist-dev',
  base: process.env.CCMS_PORTAL_SITE_BASE ?? '/',
  trailingSlash: 'always',
  // Two pages at one address would drop one silently: an error instead.
  prerenderConflictBehavior: 'error',
  build: { format: 'directory', inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
