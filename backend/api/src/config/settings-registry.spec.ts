import { z } from 'zod';
import { defineSettings, registerSettings } from './settings-registry.js';

const check = (_env: { CCMS_THING_URL?: string }, ctx: z.RefinementCtx) =>
  ctx.addIssue({ code: 'custom', message: 'checked' });

const things = defineSettings(
  'things',
  z.object({ CCMS_THING_URL: z.string().optional() }),
  check,
);
const alarms = defineSettings(
  'alarms',
  z.object({ CCMS_ALARM_LEVEL: z.string(), CCMS_ALARM_TONE: z.string() }),
);

describe('registerSettings', () => {
  it('holds each group’s settings with their group, their schemas and the checks, in the order given', () => {
    const registered = registerSettings([things, alarms]);
    expect(registered.names).toEqual([
      { name: 'CCMS_THING_URL', group: 'things' },
      { name: 'CCMS_ALARM_LEVEL', group: 'alarms' },
      { name: 'CCMS_ALARM_TONE', group: 'alarms' },
    ]);
    expect(registered.shape).toEqual({
      CCMS_THING_URL: things.shape.CCMS_THING_URL,
      CCMS_ALARM_LEVEL: alarms.shape.CCMS_ALARM_LEVEL,
      CCMS_ALARM_TONE: alarms.shape.CCMS_ALARM_TONE,
    });
    expect(registered.checks).toEqual([check]);
  });

  it('refuses a setting registered twice, so none replaces another’s', () => {
    const rival = defineSettings(
      'rival',
      z.object({ CCMS_ALARM_TONE: z.literal('silent') }),
    );
    expect(() => registerSettings([alarms, rival])).toThrow(
      'The setting CCMS_ALARM_TONE is registered by alarms and by rival',
    );
    expect(() => registerSettings([things, things])).toThrow(
      'The setting CCMS_THING_URL is registered by things and by things',
    );
  });

  it('refuses a setting that is no CCMS_ name, so none slips past Env', () => {
    const odd = (name: string) =>
      registerSettings([
        {
          group: 'odd',
          names: [name],
          shape: Object.fromEntries([[name, z.string()]]),
        },
      ]);
    for (const name of ['__proto__', 'constructor', 'PORT', 'ccms_thing'])
      expect(() => odd(name)).toThrow(
        `The setting ${name} of odd is no CCMS_ name with a schema`,
      );
    // A name that only turns into one: the duplicate check compares names, not what they print as.
    expect(() =>
      registerSettings([
        things,
        {
          group: 'odd',
          names: [['CCMS_THING_URL'] as unknown as string],
          shape: { CCMS_THING_URL: z.string() },
        },
      ]),
    ).toThrow(
      'The setting CCMS_THING_URL of odd is no CCMS_ name with a schema',
    );
    expect(() =>
      registerSettings([{ group: 'odd', names: ['CCMS_GHOST'], shape: {} }]),
    ).toThrow('The setting CCMS_GHOST of odd is no CCMS_ name with a schema');
  });

  it('refuses settings refined as a whole, whose refinement would be lost', () => {
    expect(() =>
      defineSettings(
        'odd',
        z.object({ CCMS_ODD: z.string() }).superRefine(() => undefined),
      ),
    ).toThrow(
      "The settings of odd are refined as a whole: pass the check as defineSettings' check",
    );
  });

  it('freezes a component’s settings as they are defined, and what it registers', () => {
    expect(Object.isFrozen(things)).toBe(true);
    expect(Object.isFrozen(things.names)).toBe(true);
    expect(Object.isFrozen(things.shape)).toBe(true);
    const registered = registerSettings([things]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.names)).toBe(true);
    expect(registered.names.every((n) => Object.isFrozen(n))).toBe(true);
    expect(Object.isFrozen(registered.shape)).toBe(true);
    expect(Object.isFrozen(registered.checks)).toBe(true);
  });
});
