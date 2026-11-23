import {
  detailOf,
  fixLinkOf,
  groupChecks,
  type CheckItem,
} from './checks-model';

const check = (
  over: Partial<CheckItem['attributes']> & { title?: string | null },
): CheckItem => {
  const { title = null, ...attributes } = over;
  return {
    type: 'Check',
    id: Math.random().toString(36).slice(2),
    attributes: {
      code: 'missing-image',
      severity: 'blocking',
      category: 'image',
      subject: { type: 'module', lang: 'en', moduleId: 'intro' },
      blockId: null,
      message: '',
      params: {},
      ...attributes,
    },
    meta: { variants: [], languages: [], title },
  };
};

describe('groupChecks', () => {
  it('groups a page by subject, in order, with its counts and title', () => {
    const groups = groupChecks([
      check({ subject: { type: 'manual', manualId: 'op' }, title: 'Op' }),
      check({ title: 'Intro' }),
      check({ severity: 'warning', code: 'missing-translation' }),
      check({
        subject: { type: 'module', lang: 'de', moduleId: 'intro' },
        severity: 'warning',
      }),
    ]);
    expect(groups.map((g) => [g.key, g.title, g.blocking, g.warning])).toEqual([
      ['manual/op', 'Op', 1, 0],
      ['module/en/intro', 'Intro', 1, 1],
      ['module/de/intro', null, 0, 1],
    ]);
  });
});

describe('detailOf', () => {
  const name = (lang: string) => `<${lang}>`;

  it('names what the API names', () => {
    expect(
      detailOf(
        check({
          code: 'xref-unknown-block',
          params: { module: 'other', block: 'b1' },
        }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.xref-unknown-block',
      params: { module: 'other', block: 'b1' },
    });
    expect(
      detailOf(
        check({ code: 'missing-translation', params: { lang: 'de' } }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.missing-translation',
      params: { language: '<de>' },
    });
  });

  it('names an outdated translation of a manual’s cover image or page design text (#656)', () => {
    expect(
      detailOf(
        check({
          code: 'outdated-translation',
          params: { lang: 'de', blocks: '2', at: 'coverImage' },
        }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.outdated-cover-translation',
      params: { count: '2', language: '<de>' },
    });
    expect(
      detailOf(
        check({
          code: 'outdated-translation',
          params: { lang: 'de', blocks: '1', design: 'house' },
        }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.outdated-design-translation',
      params: { design: 'house', count: '1', language: '<de>' },
    });
    // A module's translation keeps the general text.
    expect(
      detailOf(
        check({
          code: 'outdated-translation',
          params: { lang: 'de', blocks: '1' },
        }),
        name,
      ).key,
    ).toBe('editor.checks.codes.outdated-translation.detail');
  });

  it('names the deprecated module and its replacement (#266)', () => {
    expect(
      detailOf(
        check({
          code: 'deprecated-module',
          params: { module: 'charging', replacedBy: 'safety-note' },
        }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.deprecated-module-replaced',
      params: { module: 'charging', replacedBy: 'safety-note' },
    });
    expect(
      detailOf(
        check({ code: 'deprecated-module', params: { module: 'charging' } }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.deprecated-module',
      params: { module: 'charging' },
    });
    expect(
      detailOf(
        check({ code: 'unknown-replacement', params: { replacedBy: 'gone' } }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.unknown-replacement',
      params: { replacedBy: 'gone' },
    });
  });

  it('names the design, the place and what a page design check is about (#554)', () => {
    const of = (
      code: CheckItem['attributes']['code'],
      params: Record<string, string>,
    ) =>
      detailOf(
        check({ code, subject: { type: 'manual', manualId: 'op' }, params }),
        name,
      );
    expect(
      of('page-design-missing-value', {
        design: 'classic',
        at: 'header.default.left',
        name: 'subtitle',
      }),
    ).toEqual({
      key: 'editor.checks.named.page-design-missing-value',
      params: {
        design: 'classic',
        at: 'header.default.left',
        name: 'subtitle',
      },
    });
    expect(
      of('page-design-dropped-text', {
        design: 'classic',
        at: 'footer.default.left',
      }),
    ).toEqual({
      key: 'editor.checks.named.page-design-dropped-text',
      params: { design: 'classic', at: 'footer.default.left' },
    });
    expect(
      of('page-design-missing-font', {
        design: 'classic',
        at: 'fonts.heading.regular',
        asset: `sha256:${'f'.repeat(64)}`,
      }),
    ).toEqual({
      key: 'editor.checks.named.page-design-missing-font',
      params: { design: 'classic', at: 'fonts.heading.regular' },
    });
    expect(
      of('page-design-region-languages-differ', {
        design: 'classic',
        at: 'regions.footer',
        name: 'en',
      }),
    ).toEqual({
      key: 'editor.checks.named.page-design-region-languages-differ',
      params: { design: 'classic', at: 'regions.footer', language: '<en>' },
    });
    // Without what it names: what the code means.
    expect(of('page-design-dropped-text', {})).toEqual({
      key: 'editor.checks.codes.page-design-dropped-text.detail',
    });
    expect(of('pdf-layout-not-checked', { reason: 'render-failed' })).toEqual({
      key: 'editor.checks.codes.pdf-layout-not-checked.detail',
    });
  });

  it('names a page design that is not there, the manual’s or the default (#589)', () => {
    const missing = (from: string) =>
      detailOf(
        check({
          code: 'unknown-page-design',
          params: { design: 'gone', from },
        }),
        name,
      );
    expect(missing('manual')).toEqual({
      key: 'editor.checks.named.unknown-page-design-manual',
      params: { design: 'gone' },
    });
    expect(missing('config')).toEqual({
      key: 'editor.checks.named.unknown-page-design-config',
      params: { design: 'gone' },
    });
  });

  it('names a taken address and a capped access (#553)', () => {
    const taken = (address: string, manual: string) =>
      detailOf(
        check({
          code: 'address-taken',
          params: { address, manual, as: 'formerly' },
        }),
        name,
      );
    expect(taken('guide', 'guide')).toEqual({
      key: 'editor.checks.named.address-taken-own',
      params: { address: 'guide', manual: 'guide' },
    });
    expect(taken('guide', 'op')).toEqual({
      key: 'editor.checks.named.address-taken-other',
      params: { address: 'guide', manual: 'op' },
    });
    expect(
      detailOf(
        check({
          code: 'delivery-access-capped',
          params: { access: 'public', maxAccess: 'signed-in' },
        }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.delivery-access-capped',
      params: { access: 'public', maxAccess: 'signed-in' },
    });
  });

  it('names what a writing check found, the term or rule, and the fix (#55)', () => {
    const writing = (
      code: 'forbidden-term' | 'style-rule' | 'writing-not-checked',
      params: Record<string, string>,
    ) =>
      detailOf(
        check({ code, severity: 'warning', category: 'writing', params }),
        name,
      );
    expect(
      writing('forbidden-term', {
        text: 'loader',
        term: 'charger',
        status: 'forbidden',
        replacement: 'charger',
      }),
    ).toEqual({
      key: 'editor.checks.named.forbidden-term',
      params: { text: 'loader', term: 'charger', replacement: 'charger' },
    });
    expect(
      writing('forbidden-term', {
        text: 'power pack',
        term: 'power-pack',
        status: 'deprecated',
      }),
    ).toEqual({
      key: 'editor.checks.named.forbidden-term-deprecated',
      params: { text: 'power pack', term: 'power-pack' },
    });
    expect(
      writing('forbidden-term', {
        text: 'power pack',
        term: 'power-pack',
        status: 'deprecated',
        replacement: 'battery',
      }).key,
    ).toBe('editor.checks.named.forbidden-term-deprecated-replaced');
    expect(
      writing('style-rule', {
        text: 'in a dry place',
        rule: 'dry-place',
        message: 'Name it.',
      }),
    ).toEqual({
      key: 'editor.checks.named.style-rule',
      params: { text: 'in a dry place', message: 'Name it.' },
    });
    expect(
      writing('style-rule', {
        text: 'Utilise',
        rule: 'use',
        message: 'Plain.',
        replacement: 'use',
      }).key,
    ).toBe('editor.checks.named.style-rule-replaced');
    expect(
      writing('style-rule', {
        text: 'A b c.',
        rule: 'max-sentence-words',
        words: '31',
        max: '30',
      }),
    ).toEqual({
      key: 'editor.checks.named.style-rule-sentence',
      params: { words: '31', max: '30' },
    });
    expect(writing('writing-not-checked', { stopped: 'steps' })).toEqual({
      key: 'editor.checks.named.writing-not-checked-steps',
    });
    expect(writing('writing-not-checked', { stopped: 'other' })).toEqual({
      key: 'editor.checks.codes.writing-not-checked.detail',
    });
  });

  it('says what the code means when nothing is named', () => {
    expect(detailOf(check({ code: 'xref-unknown-block' }), name)).toEqual({
      key: 'editor.checks.codes.xref-unknown-block.detail',
    });
    expect(detailOf(check({ code: 'unknown-audience' }), name)).toEqual({
      key: 'editor.checks.codes.unknown-audience.detail',
    });
  });
});

describe('fixLinkOf', () => {
  it('opens the module at its block, or the manual', () => {
    expect(fixLinkOf(check({ blockId: 'img-1' }))).toEqual({
      commands: ['/content', 'en', 'intro'],
      query: { block: 'img-1' },
    });
    expect(fixLinkOf(check({}))).toEqual({
      commands: ['/content', 'en', 'intro'],
      query: {},
    });
    expect(
      fixLinkOf(check({ subject: { type: 'manual', manualId: 'op' } })),
    ).toEqual({ commands: ['/manuals', 'op'], query: {} });
  });

  it('opens a page design’s screen for its checks, grouped by the design (#396)', () => {
    const name = (lang: string) => `<${lang}>`;
    const broken = check({
      code: 'page-design-template-error',
      subject: { type: 'design', designId: 'house' },
      params: {
        design: 'house',
        template: 'own',
        file: 'templates/own/manual.typ',
        line: '12',
        column: '3',
        problem: 'unknown variable: notice',
      },
    });
    expect(fixLinkOf(broken)).toEqual({
      commands: ['/admin/page-designs', 'house'],
      query: {},
    });
    expect(groupChecks([broken, broken]).map((g) => g.key)).toEqual([
      'design/house',
    ]);
    expect(detailOf(broken, name)).toEqual({
      key: 'editor.checks.named.page-design-template-error',
      params: {
        template: 'own',
        file: 'templates/own/manual.typ',
        line: '12',
        column: '3',
        problem: 'unknown variable: notice',
      },
    });
    expect(
      detailOf(
        check({
          code: 'page-design-unknown-template',
          subject: { type: 'manual', manualId: 'op' },
          params: { design: 'house', template: 'gone' },
        }),
        name,
      ),
    ).toEqual({
      key: 'editor.checks.named.page-design-unknown-template',
      params: { design: 'house', template: 'gone' },
    });
  });

  it('opens a derived manual’s rule for each of its checks (#669)', () => {
    for (const code of [
      'unknown-source-manual',
      'derived-source',
      'no-gathered-types',
      'derived-audience-wider',
      'safety-module-excluded',
      'unknown-excluded-module',
      'empty-derived-manual',
    ] as const) {
      expect(
        fixLinkOf(
          check({ code, subject: { type: 'manual', manualId: 'leaflet' } }),
        ),
      ).toEqual({
        commands: ['/manuals', 'leaflet'],
        query: { section: 'rule' },
      });
    }
  });
});
