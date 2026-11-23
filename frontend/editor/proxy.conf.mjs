// Dev-server proxy: `/api/*` goes to the API with the shared bearer token added here, in the
// dev-server process, so the token never reaches the browser or the bundle.
//
// Settings (environment first, then the worktree's `.env.local`, which the API's local setup made):
//   CCMS_API_TOKEN  the API's shared token (required)
//   CCMS_API_URL    the API's address (default: http://127.0.0.1:<PORT from .env.local>, else 3100)
//
// The process's own PORT is never read: it is the dev server's when it was started with one
// (`PORT=4300 pnpm nx serve editor`), and the proxy would then send every call to itself. Only
// `.env.local`'s PORT, which is the API's, counts; set CCMS_API_URL for any other API.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { crossSiteRefusal } from './tools/proxy-origin.mjs';

/** `.env.local`'s settings, without touching `process.env`; none when there is no file. */
function localSettings() {
  try {
    return parseEnv(
      readFileSync(
        fileURLToPath(new URL('../../.env.local', import.meta.url)),
        'utf8',
      ),
    );
  } catch {
    // No local file: the environment has to provide the settings.
    return {};
  }
}

const local = localSettings();
const setting = (name) => process.env[name] || local[name] || undefined;

const target =
  setting('CCMS_API_URL') ?? `http://127.0.0.1:${local.PORT || 3100}`;
const token = setting('CCMS_API_TOKEN');
if (!token) {
  console.warn(
    '[proxy] CCMS_API_TOKEN is not set: API calls will answer 401. Set it in the environment or .env.local.',
  );
}
console.log(`[proxy] /api -> ${target}`);

export default {
  '/api': {
    target,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    // Replaces any Authorization header the browser sent.
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    // Cross-site requests never get the token (tools/proxy-origin.mjs). Runs before the request
    // is proxied; having answered, it returns the path, and an answer already sent is never
    // proxied.
    bypass(req, res) {
      const refusal = crossSiteRefusal(req);
      if (!refusal) return undefined;
      res.writeHead(403, { 'Content-Type': 'application/vnd.api+json' });
      res.end(JSON.stringify(refusal));
      return req.url;
    },
  },
};
