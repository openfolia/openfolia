// @vitest-environment node
// What each runtime image of the Dockerfile starts as: its user, ENTRYPOINT and CMD. A change to one
// is deliberate and shows here (a stray edit once dropped the API's entrypoint, which reads its
// *_FILE secrets).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { IMAGES } from '@/scripts/images-plan.mjs';

const dockerfile = readFileSync(
  join(import.meta.dirname, '..', '..', 'Dockerfile'),
  'utf8',
);

/** Each target's last USER, ENTRYPOINT and CMD (a target does not inherit them by name here). */
function targets(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM \S+ AS (\S+)$/.exec(line);
    if (from) {
      current = {};
      out[from[1]!] = current;
      continue;
    }
    const instruction = /^(USER|ENTRYPOINT|CMD) (.+)$/.exec(line);
    if (instruction && current) current[instruction[1]!] = instruction[2]!;
  }
  return out;
}

const NODE_ENTRYPOINT =
  '["/usr/bin/tini", "--", "/usr/local/bin/openfolia-entrypoint"]';

describe('the Dockerfile', () => {
  it('starts every image as it should', () => {
    const all = targets();
    expect(
      Object.fromEntries(IMAGES.map((image) => [image, all[image]])),
    ).toEqual({
      api: {
        USER: 'node',
        ENTRYPOINT: NODE_ENTRYPOINT,
        CMD: '["node", "dist/main.js"]',
      },
      backup: {
        USER: 'node',
        ENTRYPOINT:
          '["/usr/bin/tini", "--", "/usr/local/bin/openfolia-entrypoint", "node", "dist/main.js"]',
        CMD: '["run"]',
      },
      editor: {
        USER: 'nginx',
        ENTRYPOINT: '["/usr/local/bin/openfolia-editor-entrypoint"]',
        CMD: '["nginx", "-g", "daemon off;"]',
      },
      embedder: {
        USER: 'node',
        ENTRYPOINT: '["/usr/bin/tini", "--"]',
        CMD: '["node", "dist/main.js"]',
      },
      mcp: {
        USER: 'node',
        ENTRYPOINT: NODE_ENTRYPOINT,
        CMD: '["node", "dist/main.js", "--http"]',
      },
      portal: {
        USER: 'node',
        ENTRYPOINT:
          '["/usr/bin/tini", "-g", "--", "/usr/local/bin/openfolia-portal-entrypoint"]',
        CMD: '["node", "scripts/serve.ts", "--", "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]',
      },
      sandbox: {
        USER: 'node',
        ENTRYPOINT:
          '["/usr/bin/tini", "-g", "--", "/usr/local/bin/openfolia-sandbox"]',
      },
      // The launcher reads its own *_FILE secrets; the agent is `node dist/agent-main.js`.
      'sandbox-launcher': {
        USER: 'node',
        ENTRYPOINT: '["/usr/bin/tini", "--"]',
        CMD: '["node", "dist/main.js"]',
      },
      'demo-portal': {
        USER: '10001:10001',
        CMD: '["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]',
      },
    });
  });
});
