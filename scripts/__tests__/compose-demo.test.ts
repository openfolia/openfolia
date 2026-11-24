// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..', '..');
const compose = parse(
  readFileSync(join(root, 'deploy', 'compose.demo.yaml'), 'utf8'),
) as { services: Record<string, { environment?: Record<string, string> }> };

describe('deploy/compose.demo.yaml', () => {
  // The agent, not the launcher, starts each sandbox (backend/sandbox-launcher/src/agent.ts), so the
  // portal's address the sandbox's banner links has to reach the agent too (#837).
  it("gives the agent the portal's address, as the launcher has it", () => {
    const { launcher, agent } = compose.services;
    expect(launcher.environment?.CCMS_LAUNCHER_PORTAL_URL).toBeTruthy();
    expect(agent.environment?.CCMS_LAUNCHER_PORTAL_URL).toBe(
      launcher.environment?.CCMS_LAUNCHER_PORTAL_URL,
    );
  });
});
