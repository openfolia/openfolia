// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..', '..');
const compose = parse(
  readFileSync(join(root, 'deploy', 'compose.demo.yaml'), 'utf8'),
) as { services: Record<string, { environment?: Record<string, string> }> };

/**
 * The settings both the launcher and the agent read (`shared()` in the launcher's settings): the
 * names as that function spells them, so a setting added there is checked here too.
 */
function sharedSettings(): string[] {
  const source = readFileSync(
    join(root, 'backend', 'sandbox-launcher', 'src', 'settings.ts'),
    'utf8',
  );
  const start = source.indexOf('function shared(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  return [...new Set(body.match(/CCMS_LAUNCHER_\w+/g) ?? [])];
}

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

  // Whatever the agent reads and passes to the sandboxes (the portal, the lifetime, the public
  // host, #846's end route on it) must be what the launcher serves: every shared setting the
  // launcher is given here, the agent is given the same (a secret by the same file).
  it('gives the agent every shared setting the launcher has, the same', () => {
    const { launcher, agent } = compose.services;
    const names = sharedSettings();
    expect(names).toEqual(
      expect.arrayContaining([
        'CCMS_LAUNCHER_PUBLIC_URL',
        'CCMS_LAUNCHER_PORTAL_URL',
        'CCMS_LAUNCHER_IDLE_MINUTES',
        'CCMS_LAUNCHER_MAX_MINUTES',
      ]),
    );
    const given = names
      .flatMap((name) => [name, `${name}_FILE`])
      .filter((name) => launcher.environment?.[name] !== undefined);
    expect(given.length).toBeGreaterThan(1);
    for (const name of given)
      expect(agent.environment?.[name], name).toBe(
        launcher.environment?.[name],
      );
  });
});
