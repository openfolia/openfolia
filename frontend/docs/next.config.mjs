import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * A static export (`out/`): every page, the search index and the machine-readable files are made
 * at build time, so the site is plain files any web server can serve. Each page is a folder with
 * an `index.html` (`trailingSlash`), so `/api/delivery` works on every server without rewrites.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  // Not `tsconfig.json`: Nx's TypeScript sync would then manage the file as a library's, with
  // project references Next does not use.
  typescript: { tsconfigPath: 'tsconfig.app.json' },
  // The dev server (`docs:serve`) is opened at 127.0.0.1 as well as localhost; Next 16 blocks its
  // dev resources (the client, `/_next/hmr`) from any other host, which left every control dead
  // (#618). Only `next dev` reads this; the export has no dev resources.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // `next dev` would write an AGENTS.md here (#617); the repository has its own agent docs.
  agentRules: false,
  // The workspace's root is two folders up; tracing from here is enough.
  turbopack: { root: import.meta.dirname + '/../..' },
};

export default withMDX(config);
