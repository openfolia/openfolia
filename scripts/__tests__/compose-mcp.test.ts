// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..', '..');

describe('deploy/compose.yaml, the mcp service', () => {
  it('passes a leftover CCMS_MCP_HTTP_TOKEN on, so the server refuses to start with the removal message (#922)', () => {
    const compose = parse(
      readFileSync(join(root, 'deploy', 'compose.yaml'), 'utf8'),
    ) as { services: { mcp: { environment: Record<string, string> } } };
    expect(compose.services.mcp.environment.CCMS_MCP_HTTP_TOKEN).toBe(
      '${CCMS_MCP_HTTP_TOKEN:-}',
    );
  });
});
