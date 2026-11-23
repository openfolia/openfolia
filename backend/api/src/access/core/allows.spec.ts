import type { Actor, Role, Scope } from './actor.js';
import {
  allows,
  allowsAllIn,
  allowsManual,
  ANYWHERE,
  type ContentTarget,
  moduleTarget,
} from './allows.js';
import {
  GLOBAL_PERMISSIONS,
  type Permission,
  PERMISSIONS,
} from './permissions.js';

const AUDIENCES = ['public', 'customer', 'service', 'internal'];

/** A module: English procedure for customers, about one product line. */
function target(overrides: Partial<ContentTarget> = {}): ContentTarget {
  return {
    audiences: AUDIENCES,
    facetIds: ['product-line', 'region'],
    lang: 'en',
    moduleType: 'procedure',
    audience: 'customer',
    facets: { 'product-line': ['tuggers'] },
    ...overrides,
  };
}

function role(permissions: Permission[], scope: Scope = {}, id = 'r'): Role {
  return { id, name: id, permissions, scope };
}

function actor(...roles: Role[]): Actor {
  return { kind: 'user', id: 'someone', roles };
}

const CONTENT_PERMISSIONS = PERMISSIONS.filter(
  (p) => !GLOBAL_PERMISSIONS.has(p),
);

describe('allows', () => {
  describe('permissions', () => {
    it.each(PERMISSIONS)('grants %s to a role holding it', (permission) => {
      expect(allows(actor(role([permission])), permission, target())).toBe(
        true,
      );
    });

    it.each(PERMISSIONS)(
      'refuses %s to a role holding every other permission',
      (permission) => {
        const others = PERMISSIONS.filter((p) => p !== permission);
        expect(allows(actor(role(others)), permission, target())).toBe(false);
      },
    );

    it.each(PERMISSIONS)('refuses %s to an actor without roles', (p) => {
      expect(allows(actor(), p, target())).toBe(false);
      expect(allows(actor(), p, ANYWHERE)).toBe(false);
    });

    it.each([...GLOBAL_PERMISSIONS])(
      'grants the global %s whatever the role scope and the target',
      (permission) => {
        const scoped = role([permission], {
          languages: ['de'],
          moduleTypes: ['safety'],
          maxAudience: 'public',
          facets: { region: ['us'] },
        });
        expect(allows(actor(scoped), permission, target())).toBe(true);
        expect(allows(actor(scoped), permission, ANYWHERE)).toBe(true);
      },
    );

    it.each(CONTENT_PERMISSIONS)('applies the scope to %s', (permission) => {
      const german = role([permission], { languages: ['de'] });
      expect(allows(actor(german), permission, target())).toBe(false);
      expect(allows(actor(german), permission, target({ lang: 'de' }))).toBe(
        true,
      );
    });
  });

  describe('anywhere', () => {
    it('asks only whether some role holds the permission', () => {
      const narrow = role(['content.edit'], {
        languages: ['de'],
        maxAudience: 'public',
      });
      expect(allows(actor(narrow), 'content.edit', ANYWHERE)).toBe(true);
      expect(allows(actor(narrow), 'content.review', ANYWHERE)).toBe(false);
    });
  });

  describe('an empty scope', () => {
    it('covers everything, including content naming nothing', () => {
      const everywhere = actor(role(['content.edit']));
      expect(
        allows(
          everywhere,
          'content.edit',
          target({
            lang: undefined,
            moduleType: undefined,
            audience: undefined,
            facets: {},
          }),
        ),
      ).toBe(true);
    });
  });

  describe('languages', () => {
    const scope: Scope = { languages: ['de', 'pt-BR'] };
    it.each([
      ['de', true],
      ['pt-BR', true],
      ['en', false],
      // Exact tags: a region subtag is another language here.
      ['de-AT', false],
      ['pt-br', false],
      [undefined, false],
    ])('language %s: %s', (lang, expected) => {
      for (const p of ['content.read', 'content.edit'] as const) {
        expect(allows(actor(role([p], scope)), p, target({ lang }))).toBe(
          expected,
        );
      }
    });
  });

  describe('module types', () => {
    const scope: Scope = { moduleTypes: ['safety'] };
    it.each([
      ['safety', true],
      ['procedure', false],
      [undefined, false],
    ])('module type %s: %s', (moduleType, expected) => {
      for (const p of ['content.read', 'content.approve'] as const) {
        expect(allows(actor(role([p], scope)), p, target({ moduleType }))).toBe(
          expected,
        );
      }
    });
  });

  describe('audience', () => {
    it.each([
      // [maxAudience, module audience, allowed]
      ['customer', 'public', true],
      ['customer', 'customer', true],
      ['customer', 'service', false],
      ['customer', 'internal', false],
      ['internal', 'internal', true],
      ['public', 'customer', false],
      // A level not configured fails closed, on either side.
      ['customer', 'partner', false],
      ['partner', 'public', false],
    ])('up to %s, a %s module: %s', (maxAudience, audience, expected) => {
      for (const p of ['content.read', 'content.edit'] as const) {
        expect(
          allows(actor(role([p], { maxAudience })), p, target({ audience })),
        ).toBe(expected);
      }
    });

    describe('a module without audience is internal', () => {
      const internal = target({ audience: undefined });

      it.each(['public', 'customer', 'service'])(
        'invisible up to %s',
        (maxAudience) => {
          expect(
            allows(
              actor(role(['content.read'], { maxAudience })),
              'content.read',
              internal,
            ),
          ).toBe(false);
        },
      );

      it('visible up to the most restricted level, or without a limit', () => {
        expect(
          allows(
            actor(role(['content.read'], { maxAudience: 'internal' })),
            'content.read',
            internal,
          ),
        ).toBe(true);
        expect(
          allows(actor(role(['content.read'])), 'content.read', internal),
        ).toBe(true);
      });

      it('follows the configuration: the last level is the default', () => {
        const twoLevels = target({
          audiences: ['public', 'staff'],
          audience: undefined,
        });
        const upTo = (maxAudience: string) =>
          actor(role(['content.read'], { maxAudience }));
        expect(allows(upTo('staff'), 'content.read', twoLevels)).toBe(true);
        expect(allows(upTo('public'), 'content.read', twoLevels)).toBe(false);
        // No levels configured: nothing to place it at.
        expect(
          allows(
            upTo('public'),
            'content.read',
            target({ audiences: [], audience: undefined }),
          ),
        ).toBe(false);
      });
    });
  });

  describe('facets', () => {
    const scope: Scope = { facets: { 'product-line': ['tuggers', 'lifters'] } };
    it.each([
      // [the module's product lines, may read, may change]
      [['tuggers'], true, true],
      [['tuggers', 'lifters'], true, true],
      // Shared with a product line outside the scope: readable, not changeable.
      [['tuggers', 'trucks'], true, false],
      [['trucks'], false, false],
      // Not about any product line, so about all of them.
      [undefined, true, false],
      [[], true, false],
    ])('product lines %j: read %s, change %s', (values, read, change) => {
      const facets: Record<string, string[]> =
        values === undefined ? {} : { 'product-line': values };
      const t = target({ facets });
      for (const p of ['content.read', 'content.read.draft'] as const) {
        expect(allows(actor(role([p], scope)), p, t)).toBe(read);
      }
      for (const p of CONTENT_PERMISSIONS.filter(
        (p) => p !== 'content.read' && p !== 'content.read.draft',
      )) {
        expect(allows(actor(role([p], scope)), p, t)).toBe(change);
      }
    });

    it('checks each facet the scope names; others are free', () => {
      const both = role(['content.edit'], {
        facets: { 'product-line': ['tuggers'], region: ['eu'] },
      });
      const facets = (region: string[]) =>
        target({
          facets: { 'product-line': ['tuggers'], region, other: ['x'] },
        });
      expect(allows(actor(both), 'content.edit', facets(['eu']))).toBe(true);
      expect(allows(actor(both), 'content.edit', facets(['us']))).toBe(false);
    });

    it('does not read inherited properties as facet values', () => {
      const proto = role(['content.edit'], {
        facets: { constructor: ['x'] },
      });
      expect(allows(actor(proto), 'content.edit', target({ facets: {} }))).toBe(
        false,
      );
    });
  });

  describe('several roles', () => {
    it('never combine a permission from one with the scope of another', () => {
      const editsGerman = role(['content.edit'], { languages: ['de'] }, 'a');
      const readsFrench = role(['content.read'], { languages: ['fr'] }, 'b');
      const both = actor(editsGerman, readsFrench);
      expect(allows(both, 'content.edit', target({ lang: 'fr' }))).toBe(false);
      expect(allows(both, 'content.read', target({ lang: 'de' }))).toBe(false);
      expect(allows(both, 'content.edit', target({ lang: 'de' }))).toBe(true);
      expect(allows(both, 'content.read', target({ lang: 'fr' }))).toBe(true);
    });

    it('grants when any one role covers the target', () => {
      const german = role(['content.edit'], { languages: ['de'] }, 'a');
      const safety = role(['content.edit'], { moduleTypes: ['safety'] }, 'b');
      const a = actor(german, safety);
      expect(
        allows(a, 'content.edit', target({ lang: 'en', moduleType: 'safety' })),
      ).toBe(true);
      expect(allows(a, 'content.edit', target({ lang: 'en' }))).toBe(false);
    });

    it('needs every dimension of one role to hold', () => {
      const narrow = role(['content.edit'], {
        languages: ['de'],
        moduleTypes: ['safety'],
      });
      expect(
        allows(
          actor(narrow),
          'content.edit',
          target({ lang: 'de', moduleType: 'safety' }),
        ),
      ).toBe(true);
      expect(
        allows(actor(narrow), 'content.edit', target({ lang: 'de' })),
      ).toBe(false);
    });
  });
});

describe('moduleTarget', () => {
  it('takes the module metadata and the configured audience order', () => {
    expect(
      moduleTarget(
        {
          lang: 'de',
          type: 'safety',
          audience: undefined,
          facets: { region: ['eu'] },
        },
        {
          audiences: [
            { id: 'public', label: 'Public' },
            { id: 'internal', label: 'Internal' },
          ],
          facets: [
            {
              id: 'region',
              label: 'Region',
              values: [{ id: 'eu', label: 'EU' }],
            },
          ],
        },
      ),
    ).toEqual({
      audiences: ['public', 'internal'],
      facetIds: ['region'],
      lang: 'de',
      moduleType: 'safety',
      audience: undefined,
      facets: { region: ['eu'] },
    });
  });
});

describe('allowsAllIn', () => {
  const role = (permissions: Permission[], scope: Scope): Role => ({
    id: 'r',
    name: 'R',
    permissions,
    scope,
  });
  const actor = (...roles: Role[]): Actor => ({ kind: 'user', id: 'u', roles });

  it('holds for a role restricting nothing but languages that include it', () => {
    expect(
      allowsAllIn(actor(role(['content.read'], {})), 'content.read', 'en'),
    ).toBe(true);
    expect(
      allowsAllIn(
        actor(role(['content.read'], { languages: ['en'] })),
        'content.read',
        'en',
      ),
    ).toBe(true);
  });

  it('does not hold for another language, dimension, permission or role', () => {
    for (const scope of [
      { languages: ['de'] },
      { maxAudience: 'public' },
      { moduleTypes: ['concept'] },
      { facets: { region: ['eu'] } },
    ] satisfies Scope[]) {
      expect([
        scope,
        allowsAllIn(actor(role(['content.read'], scope)), 'content.read', 'en'),
      ]).toEqual([scope, false]);
    }
    // The permission and the open scope in different roles: no grant.
    expect(
      allowsAllIn(
        actor(
          role(['content.read'], { maxAudience: 'public' }),
          role(['content.edit'], {}),
        ),
        'content.read',
        'en',
      ),
    ).toBe(false);
  });

  it('holds for a global permission whatever the scope', () => {
    expect(
      allowsAllIn(
        actor(role(['admin.roles'], { languages: ['de'] })),
        'admin.roles',
        'en',
      ),
    ).toBe(true);
  });
});

describe('allowsManual', () => {
  const manual = (audience: string | undefined, lang?: string) => ({
    audiences: AUDIENCES,
    audience,
    lang,
  });
  const read = (scope: Scope) => actor(role(['content.read'], scope));

  it('covers a manual whose audience is within maxAudience', () => {
    expect(allowsManual(read({}), 'content.read', manual('internal'))).toBe(
      true,
    );
    const service = read({ maxAudience: 'service' });
    expect(allowsManual(service, 'content.read', manual('customer'))).toBe(
      true,
    );
    expect(allowsManual(service, 'content.read', manual('service'))).toBe(true);
    expect(allowsManual(service, 'content.read', manual('internal'))).toBe(
      false,
    );
  });

  it('fails closed: no audience is the most restricted, an unknown one is outside', () => {
    const service = read({ maxAudience: 'service' });
    expect(allowsManual(service, 'content.read', manual(undefined))).toBe(
      false,
    );
    expect(
      allowsManual(
        read({ maxAudience: 'internal' }),
        'content.read',
        manual(undefined),
      ),
    ).toBe(true);
    expect(allowsManual(service, 'content.read', manual('typo'))).toBe(false);
    expect(
      allowsManual(
        read({ maxAudience: 'typo' }),
        'content.read',
        manual('public'),
      ),
    ).toBe(false);
  });

  it('checks the language when one is given, in the same role', () => {
    const german = read({ languages: ['de'] });
    expect(allowsManual(german, 'content.read', manual('public'))).toBe(true);
    expect(allowsManual(german, 'content.read', manual('public', 'de'))).toBe(
      true,
    );
    expect(allowsManual(german, 'content.read', manual('public', 'en'))).toBe(
      false,
    );
    const split = actor(
      role(['content.read'], { languages: ['en'], maxAudience: 'public' }),
      role(['content.read'], { languages: ['de'] }),
    );
    expect(allowsManual(split, 'content.read', manual('internal', 'en'))).toBe(
      false,
    );
    expect(allowsManual(split, 'content.read', manual('internal', 'de'))).toBe(
      true,
    );
  });

  it('ignores module types and facets, which decide the modules', () => {
    const narrow = read({
      moduleTypes: ['safety'],
      facets: { 'product-line': ['tuggers'] },
    });
    expect(allowsManual(narrow, 'content.read', manual('public', 'en'))).toBe(
      true,
    );
  });

  it('needs the permission', () => {
    expect(
      allowsManual(
        actor(role(['content.edit'])),
        'content.read',
        manual('public'),
      ),
    ).toBe(false);
  });
});

describe('allows, facets the configuration does not define', () => {
  it('fails closed: a scope on an unknown facet matches nothing', () => {
    const reader = actor(
      role(['content.read'], { facets: { regoin: ['north'] } }),
    );
    expect(allows(reader, 'content.read', target({ facets: {} }))).toBe(false);
    expect(
      allows(
        reader,
        'content.read',
        target({ facetIds: ['regoin'], facets: {} }),
      ),
    ).toBe(true);
  });
});
