import { describe, expect, it } from 'vitest';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { Sandbox } from '../sandbox.js';
import { GetSandboxAction } from './get-sandbox.action.js';

const reader = actorWith(['content.read']);

describe('GetSandboxAction (#826)', () => {
  it('answers the sandbox’s status to any actor', async () => {
    const sandbox = Sandbox.on({
      limits: {
        moduleBytes: 100,
        commentLength: 10,
        changeSets: 1,
        modules: 1,
        manuals: 1,
        releasesPerHour: 1,
        renderJobs: 1,
        writeBytes: 1_000,
      },
      lifetime: { idleMinutes: 30, maxMinutes: 90 },
    });
    const status = await new GetSandboxAction(sandbox).handle({
      actor: reader,
    });
    expect(status).toMatchObject({
      limits: { writeBytes: 1_000 },
      used: { 'change-sets': 0, modules: 0, manuals: 0, releases: 0 },
      writtenBytes: 0,
    });
  });

  it('tells the reader portal’s address and the end address only when set (#837, #846)', async () => {
    const options = {
      limits: {
        moduleBytes: 100,
        commentLength: 10,
        changeSets: 1,
        modules: 1,
        manuals: 1,
        releasesPerHour: 1,
        renderJobs: 1,
        writeBytes: 1_000,
      },
      lifetime: { idleMinutes: 30, maxMinutes: 90 },
    };
    const without = await new GetSandboxAction(Sandbox.on(options)).handle({
      actor: reader,
    });
    expect(without).not.toHaveProperty('portalUrl');
    const portalUrl = 'https://manuals.example.org/';
    const withUrl = await new GetSandboxAction(
      Sandbox.on({ ...options, portalUrl }),
    ).handle({ actor: reader });
    expect(withUrl.portalUrl).toBe(portalUrl);
    expect(without).not.toHaveProperty('endUrl');
    const withEnd = await new GetSandboxAction(
      Sandbox.on({ ...options, endUrl: '/_demo/api/end' }),
    ).handle({ actor: reader });
    expect(withEnd.endUrl).toBe('/_demo/api/end');
  });

  it('is 404 not-configured when the instance is no sandbox', async () => {
    await expect(
      new GetSandboxAction(Sandbox.OFF).handle({ actor: reader }),
    ).rejects.toMatchObject({ code: 'not-configured' });
  });
});
