import { Logger } from '@nestjs/common';
import {
  FakeSignInRules,
  FakeSignInSetup,
} from '../../../tests/fakes/fake-sign-in.js';
import { ServerRole } from '../../config/server-role.js';
import type { EndRefusedSignIns } from '../core/refused-sign-ins.js';
import { SignInAtStart } from './sign-in-at-start.js';

describe('SignInAtStart (#378)', () => {
  const setUp = () => {
    const rules = new FakeSignInRules();
    const setup = new FakeSignInSetup();
    const swept = { run: vi.fn(() => Promise.resolve()) };
    const warn = vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
    const start = async (role: 'all' | 'worker' = 'all') => {
      await new SignInAtStart(
        rules,
        setup,
        swept as unknown as EndRefusedSignIns,
        new ServerRole(role),
      ).onApplicationBootstrap();
      return warn.mock.calls.map(([message]) => String(message)).join('\n');
    };
    return { rules, setup, swept, start };
  };
  afterEach(() => vi.restoreAllMocks());

  it('says nothing while single sign-on is optional, or works', async () => {
    const s = setUp();
    s.setup.offered = [];
    expect(await s.start()).toBe('');
    expect(s.swept.run).not.toHaveBeenCalled();
    s.setup.offered = ['oidc'];
    s.rules.rule = { ...s.rules.rule, singleSignOn: 'required' };
    expect(await s.start()).toBe('');
  });

  it('leaves it to the processes that serve sign-ins: a worker knows no providers', async () => {
    const s = setUp();
    s.setup.offered = [];
    s.rules.rule = { ...s.rules.rule, singleSignOn: 'required' };
    expect(await s.start('worker')).toBe('');
    expect(s.swept.run).not.toHaveBeenCalled();
  });

  it('ends what is refused since the last start, and starts all the same when that fails', async () => {
    const s = setUp();
    s.rules.rule = { ...s.rules.rule, singleSignOn: 'required' };
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockReturnValue(undefined);
    s.swept.run.mockRejectedValueOnce(new Error('busy'));
    await s.start();
    expect(s.swept.run).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('warns with no provider, and says who can still sign in', async () => {
    const s = setUp();
    s.setup.offered = [];
    s.rules.rule = { ...s.rules.rule, singleSignOn: 'required' };
    expect(await s.start()).toContain('nobody can sign in');
    s.rules.rule = {
      ...s.rules.rule,
      breakGlass: { userId: 'rescue', problem: null },
    };
    expect(await s.start()).toContain('only the emergency account can sign in');
  });

  it('warns of an emergency account that cannot be used', async () => {
    const s = setUp();
    s.rules.rule = {
      ...s.rules.rule,
      singleSignOn: 'required',
      breakGlass: { userId: 'rescue', problem: 'no-password' },
    };
    expect(await s.start()).toContain('(no-password)');
  });
});
