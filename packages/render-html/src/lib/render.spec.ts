// @vitest-environment jsdom
/// <reference lib="dom" />
import {
  Block,
  Inline,
  Mark,
  MAX_TABLE_COLUMNS,
  Module,
  resolveManual,
  TableTooLargeError,
  type ResolvedManual,
  type Table,
} from '@openfolia/content-model';
import { config, HASH, manifest, resolve } from '../testing/fixture.js';
import { safeUrl, escapeHtml } from './escape.js';
import {
  HtmlRenderError,
  renderManualHtml,
  renderModuleHtml,
  type HtmlRenderOptions,
} from './render.js';

const options: HtmlRenderOptions = {
  assetUrl: (hash) => `/assets/${hash}`,
  symbolUrl: (id) => `/symbols/${id}.svg`,
  symbolLabel: (id) => (id === 'w001' ? 'General warning' : undefined),
  subtitle: 'Large · EU',
};

function manualOf(model = 'large', lang = 'en'): ResolvedManual {
  const { manual, issues } = resolve(model, lang);
  expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  return manual;
}

function parse(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}`,
    'text/html',
  );
  return doc.body;
}

const $ = (root: Element, selector: string) => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el as HTMLElement;
};

describe('renderManualHtml', () => {
  it('renders the fixture manual (snapshot)', () => {
    const { html, assets, symbols } = renderManualHtml(manualOf(), options);
    expect(html).toMatchSnapshot();
    expect(assets).toEqual([`sha256:${HASH}`]);
    expect(symbols).toEqual(['w001']);
  });

  it('renders the manual structure: title, contents, groups, modules and sections', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const root = $(body, 'article.of-content.of-manual');
    expect(root.getAttribute('lang')).toBe('en');
    expect($(root, 'h1.of-manual__title').textContent).toBe('Operating manual');
    expect($(root, '.of-manual__subtitle').textContent).toBe('Large · EU');
    const toc = $(root, 'nav.of-toc');
    expect(toc.getAttribute('aria-label')).toBe('Contents');
    expect(
      [...toc.querySelectorAll('a')].map((a) => [
        a.getAttribute('href'),
        a.textContent,
      ]),
    ).toEqual([
      ['#of-basics', 'Basics'],
      ['#of-charging', 'Charging the battery'],
      ['#of-_glossary', 'Glossary'],
    ]);
    expect($(root, 'section.of-group > h2').textContent).toBe(
      'Getting started',
    );
    expect($(root, 'section.of-group #of-basics > h3').textContent).toBe(
      'Basics',
    );
    expect($(root, '#of-charging > h2').textContent).toBe(
      'Charging the battery',
    );
    expect($(root, '#of-basics--lights > h4').textContent).toBe(
      'Status lights',
    );
    expect($(root, '#of-basics--deeper > h5').textContent).toBe('Blink codes');
    // A module reference is rendered as its content, in place.
    expect($(root, '#of-charging-note--only').textContent).toBe(
      'Inlined from another module.',
    );
  });

  it('renders inline content: attributes filled in, marks, kbd, ui, sub and sup', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const intro = $(body, '#of-charging--intro');
    expect(intro.tagName).toBe('P');
    expect(intro.textContent).toContain('The Model A charges itself.');
    expect($(intro, 'kbd.of-kbd').outerHTML).toBe(
      '<kbd class="of-kbd"><kbd class="of-kbd__key">Ctrl</kbd><span class="of-kbd__separator">+</span><kbd class="of-kbd__key">S</kbd></kbd>',
    );
    expect($(intro, 'span.of-ui').textContent).toBe('Park');
    const link = $(intro, 'a.of-link');
    expect(link.getAttribute('href')).toBe('https://example.com/help?a=1&b=2');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.innerHTML).toBe('<strong>the website</strong>');
    expect($(intro, 'sub').textContent).toBe('2');
    expect($(intro, 'sup').textContent).toBe('2');
    expect($(intro, 'em').textContent).toBe('H');
    expect($(intro, 'code.of-code').textContent).toBe('config.yaml');
    expect(intro.querySelectorAll('br')).toHaveLength(1);
  });

  it('renders cross-references as fragment links, with the target title as default text', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const xrefs = [...body.querySelectorAll('a.of-xref')].map((a) => [
      a.getAttribute('href'),
      a.innerHTML,
    ]);
    expect(xrefs).toEqual([
      ['#of-basics--lights', 'Status lights'],
      ['#of-basics', '<em>the basics</em>'],
    ]);
    for (const [href] of xrefs) {
      expect(body.querySelector(href as string)).not.toBeNull();
    }
  });

  it('renders safety notices with the signal word, severity class, symbols and hazard', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const safety = $(body, '#of-charging--hot');
    expect(safety.className).toBe('of-safety of-safety--warning');
    expect(safety.getAttribute('role')).toBe('note');
    expect($(safety, '.of-safety__signal').textContent).toBe('WARNING');
    expect($(safety, '.of-safety__hazard').textContent).toBe('Hot surface');
    const symbol = $(safety, 'img.of-safety__symbol');
    expect(symbol.getAttribute('src')).toBe('/symbols/w001.svg');
    expect(symbol.getAttribute('alt')).toBe('General warning');
    expect($(safety, '#of-charging--hot-p').textContent).toBe(
      'Let it cool down.',
    );
  });

  it('leaves out symbols without a URL', () => {
    const { html, symbols } = renderManualHtml(manualOf(), {
      ...options,
      symbolUrl: () => undefined,
    });
    expect(symbols).toEqual([]);
    expect(parse(html).querySelector('.of-safety__symbols')).toBeNull();
  });

  it('renders procedures, lists, admonitions, literals', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const procedure = $(body, '#of-charging--steps');
    expect($(procedure, '.of-procedure__title').textContent).toBe(
      'Charge manually',
    );
    expect(
      [...procedure.querySelectorAll('ol.of-procedure__steps > li')].map(
        (li) => li.id,
      ),
    ).toEqual(['of-charging--s1', 'of-charging--s2']);
    expect($(procedure, 'ul.of-list--unordered > li').id).toBe(
      'of-charging--l1',
    );
    expect($(body, 'ol#of-charging--checks').className).toBe(
      'of-list of-list--ordered',
    );
    const tip = $(body, '#of-charging--n');
    expect(tip.className).toBe('of-admonition of-admonition--tip');
    expect($(tip, '.of-admonition__label').textContent).toBe('Tip');
    const literal = $(body, 'pre#of-charging--code');
    expect(literal.getAttribute('data-language')).toBe('sh');
    expect(literal.textContent).toBe('echo "<hi>" & exit\n  done');
  });

  it('renders an FAQ entry as a keyboard-accessible disclosure', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const faq = $(body, '#of-charging--faq-overnight');
    expect(faq.tagName).toBe('DETAILS');
    expect(faq.className).toBe('of-faq');
    // Closed until the reader opens it; the summary is the disclosure's button.
    expect(faq.hasAttribute('open')).toBe(false);
    const summary = faq.firstElementChild as HTMLElement;
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.className).toBe('of-faq__question');
    expect(summary.textContent).toBe('Can I charge overnight?');
    const answer = $(faq, ':scope > .of-faq__answer');
    expect($(answer, '#of-charging--faq-overnight-a').textContent).toBe(
      'Yes: the charger stops when full.',
    );
  });

  it('shows passthrough content as text, never as markup', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const raw = $(body, '#of-charging--raw');
    expect(raw.className).toBe('of-unconverted');
    expect($(raw, '.of-unconverted__label').textContent).toBe(
      'Unconverted content (html)',
    );
    expect($(raw, 'code').textContent).toBe('<b onclick="x()">legacy</b>');
    expect(raw.querySelector('b')).toBeNull();
  });

  it('renders tables with header cells, scopes, spans, widths and alignment', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    const wrapper = $(body, 'div.of-table#of-charging--t');
    const table = $(wrapper, 'table');
    expect($(table, 'caption').textContent).toBe('Table 1: Status lights');
    expect(
      [...table.querySelectorAll('col')].map((c) => c.getAttribute('style')),
    ).toEqual(['width:25%', 'width:75%']);
    const head = [...table.querySelectorAll('thead th')];
    expect(
      head.map((th) => [th.getAttribute('scope'), th.textContent]),
    ).toEqual([
      ['col', 'Light'],
      ['col', 'Meaning'],
    ]);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    const green = $(rows[0] as Element, 'td');
    expect(green.getAttribute('rowspan')).toBe('2');
    // "Charging" sits in the second column (the first is taken by "Green"), which is right-aligned.
    expect($(rows[1] as Element, 'td').className).toBe(
      'of-table__cell of-table__cell--right',
    );
    expect($(rows[2] as Element, 'td').getAttribute('colspan')).toBe('2');
  });

  it('renders images through assetUrl, with alt text and a numbered caption', () => {
    const seen: string[] = [];
    const body = parse(
      renderManualHtml(manualOf(), {
        ...options,
        assetUrl: (hash) => {
          seen.push(hash);
          return `/assets/${hash}`;
        },
      }).html,
    );
    expect(seen).toEqual([HASH, HASH]);
    const figure = $(body, 'figure#of-charging--photo');
    const img = $(figure, 'img');
    expect(img.getAttribute('src')).toBe(`/assets/${HASH}`);
    expect(img.getAttribute('alt')).toBe('The charger, front view');
    // With callouts, the picture the markers are drawn over has the width.
    expect(img.getAttribute('style')).toBeNull();
    expect($(figure, '.of-callouts__picture').getAttribute('style')).toBe(
      'width:50%',
    );
    expect($(figure, 'figcaption').textContent).toBe('Figure 1: The charger');
    const plain = $(body, 'div.of-image#of-charging--plain-photo');
    expect($(plain, 'img').getAttribute('alt')).toBe('The plug');
  });

  it('renders a step’s images inside its step, under its text, the numbering going on', () => {
    const manual = structuredClone(manualOf());
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    const image = (id: string, alt: string): Block => ({
      type: 'image',
      id,
      asset: `sha256:${HASH}`,
      alt,
      width: 50,
    });
    charging.blocks.push({
      type: 'procedure',
      id: 'charging--step-images',
      steps: [
        {
          id: 'charging--si1',
          content: [{ type: 'text', text: 'Open the cover.' }],
          blocks: [
            image('charging--si1a', 'Cover'),
            image('charging--si1b', 'Latch'),
          ],
        },
        {
          id: 'charging--si2',
          content: [{ type: 'text', text: 'Plug in.' }],
          blocks: [],
        },
      ],
    });
    const body = parse(renderManualHtml(manual, options).html);
    const steps = [
      ...$(body, '#of-charging--step-images').querySelectorAll(
        'ol.of-procedure__steps > li',
      ),
    ];
    expect(steps).toHaveLength(2);
    const [first] = steps as [HTMLElement];
    expect([...first.children].map((c) => c.className)).toEqual([
      'of-item__text',
      'of-image',
      'of-image',
    ]);
    expect(
      [...first.querySelectorAll('img')].map((i) => i.getAttribute('alt')),
    ).toEqual(['Cover', 'Latch']);
  });

  it('never links an image by anything but a hash URL the caller accepts', () => {
    const manual = structuredClone(manualOf());
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    const photo = charging.blocks.find((b) => b.type === 'image');
    if (photo?.type !== 'image') throw new Error('no image');
    photo.asset = '../../etc/passwd';
    const { html, assets } = renderManualHtml(manual, {
      ...options,
      assetUrl: (hash) =>
        hash === HASH ? 'javascript:alert(1)' : `/assets/${hash}`,
    });
    const imgs = [...parse(html).querySelectorAll('img.of-figure__image')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([null, null]);
    expect(assets).toEqual([]);
  });

  it('renders an attachment as a download link with its file name, type and size', () => {
    const manual = structuredClone(manualOf());
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    const FILE = 'cd'.repeat(32);
    charging.blocks.push({
      type: 'attachment',
      id: 'charging--config',
      asset: `sha256:${FILE}`,
      name: 'Configuration files',
      description: 'The charger settings as a <ZIP>.',
      fileName: 'charger "v2".zip',
      mediaType: 'application/zip',
      size: 12_345,
    });
    const { html, attachments, assets } = renderManualHtml(manual, options);
    expect(attachments).toEqual([`sha256:${FILE}`]);
    expect(assets).not.toContain(`sha256:${FILE}`);
    const block = $(parse(html), 'div.of-attachment#of-charging--config');
    const link = $(block, 'a.of-attachment__link');
    expect(link.getAttribute('href')).toBe(`/assets/${FILE}`);
    expect(link.getAttribute('download')).toBe('charger "v2".zip');
    expect(link.getAttribute('type')).toBe('application/zip');
    expect(link.textContent).toBe('Configuration files');
    expect($(block, '.of-attachment__line').textContent).toBe(
      'Attachment: Configuration files (charger "v2".zip, application/zip, 12.3 kB)',
    );
    expect($(block, '.of-attachment__description').textContent).toBe(
      'The charger settings as a <ZIP>.',
    );
  });

  it('leaves an attachment with an invalid reference without a link', () => {
    const manual = structuredClone(manualOf());
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    charging.blocks.push({
      type: 'attachment',
      id: 'charging--config',
      asset: '../secret',
      name: 'Configuration files',
      fileName: 'a.zip',
      mediaType: 'application/zip',
      size: 1,
    });
    const { html, attachments } = renderManualHtml(manual, options);
    const block = $(parse(html), 'div.of-attachment');
    expect(block.querySelector('a')).toBeNull();
    expect(attachments).toEqual([]);
  });

  it('prints the leftover attribute reference when a variant has no value', () => {
    const manual = structuredClone(manualOf());
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    charging.blocks.unshift({
      type: 'paragraph',
      id: 'charging--extra',
      content: [{ type: 'attribute', name: 'rated-load' }],
    });
    const body = parse(renderManualHtml(manual, options).html);
    expect($(body, '#of-charging--extra').innerHTML).toBe(
      '<span class="of-attribute of-attribute--missing">{rated-load}</span>',
    );
  });

  it('shows an attribute without a value as a chip with its label in the preview', () => {
    const manual = structuredClone(manualOf('large', 'de'));
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    charging.blocks.unshift({
      type: 'paragraph',
      id: 'charging--extra',
      content: [
        { type: 'attribute', name: 'rated-load' },
        { type: 'attribute', name: 'unlabelled' },
      ],
    });
    const html = renderManualHtml(manual, {
      ...options,
      preview: {
        attributeLabel: (name) =>
          name === 'rated-load' ? 'Rated <load>' : undefined,
      },
    }).html;
    const chips = parse(html).querySelectorAll(
      '#of-charging--extra .of-attribute--unset',
    );
    expect([...chips].map((c) => c.textContent)).toEqual([
      'Rated <load>',
      'unlabelled',
    ]);
    expect(chips[0]?.getAttribute('title')).toBe(
      'In dieser Vorschau nicht gesetzt',
    );
    expect(html).not.toContain('of-attribute--missing');
  });

  it('shows a page break as a marker in the preview only, and only where a page can break', () => {
    const manual = structuredClone(manualOf());
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    charging.blocks.push(
      { type: 'pageBreak', id: 'charging--break' },
      {
        type: 'admonition',
        id: 'charging--note',
        kind: 'note',
        blocks: [
          { type: 'pageBreak', id: 'charging--inner' },
          {
            type: 'section',
            id: 'charging--inner-section',
            title: [{ type: 'text', text: 'Inner' }],
            blocks: [{ type: 'pageBreak', id: 'charging--deep' }],
          },
        ],
      },
    );
    const preview = parse(
      renderManualHtml(manual, { ...options, preview: {} }).html,
    );
    const marker = $(preview, '#of-charging--break');
    expect(marker.className).toBe('of-page-break');
    expect(marker.getAttribute('role')).toBe('separator');
    expect(marker.getAttribute('aria-label')).toBe('Page break (PDF)');
    expect(marker.textContent).toBe('Page break (PDF)');
    expect(preview.querySelector('#of-charging--inner')).toBeNull();
    expect(preview.querySelector('#of-charging--deep')).toBeNull();

    const delivered = renderManualHtml(manual, options).html;
    expect(delivered).not.toContain('of-page-break');
    expect(delivered).not.toContain('charging--break');
  });

  it('prints the fixed texts in the manual language, with configured overrides', () => {
    const manual = manualOf('large', 'de');
    const body = parse(
      renderManualHtml(manual, {
        ...options,
        outputLabels: { de: { tip: 'Praxistipp' } },
      }).html,
    );
    expect($(body, 'article').getAttribute('lang')).toBe('de');
    expect($(body, 'nav.of-toc').getAttribute('aria-label')).toBe('Inhalt');
    expect($(body, '.of-toc__title').textContent).toBe('Inhalt');
    expect($(body, '.of-safety__signal').textContent).toBe('WARNUNG');
    expect($(body, '.of-admonition__label').textContent).toBe('Praxistipp');
    expect($(body, 'figcaption .of-caption__label').textContent).toBe(
      'Abbildung 1:',
    );
    expect($(body, 'caption .of-caption__label').textContent).toBe(
      'Tabelle 1:',
    );
    expect($(body, '.of-unconverted__label').textContent).toContain(
      'Nicht konvertierter Inhalt',
    );
    // The translated module has no lang of its own; the fallback is marked as English.
    expect($(body, '#of-basics').hasAttribute('lang')).toBe(false);
    expect($(body, '#of-charging').getAttribute('lang')).toBe('en');
    // Its fixed labels are still German, and say so.
    const charging = $(body, '#of-charging');
    for (const selector of [
      '.of-safety__signal',
      '.of-admonition__label',
      'figcaption .of-caption__label',
      'caption .of-caption__label',
      '.of-unconverted__label',
    ]) {
      expect(
        $(charging, selector).closest('[lang]')?.getAttribute('lang'),
      ).toBe('de');
    }
    expect(
      $(charging, '.of-safety__hazard').closest('[lang]')?.getAttribute('lang'),
    ).toBe('en');
    // So is its title in the contents.
    expect(
      $(body, '.of-toc a[href="#of-charging"] span').getAttribute('lang'),
    ).toBe('en');
    // The labels of a module in the manual's language carry no lang of their own.
    expect(body.querySelectorAll('[lang="de"]')).toHaveLength(6);
  });

  it('gives each heading of a module, a section and the glossary an ID of its own (#784)', () => {
    const body = parse(renderManualHtml(manualOf(), options).html);
    expect($(body, '#of-charging > h2').id).toBe('of-_h-charging');
    expect($(body, '#of-basics--lights > h4').id).toBe('of-_h-basics--lights');
    expect($(body, '#of-_glossary > h2').id).toBe('of-_h-_glossary');
    // Under `_h-`, never a module's or a block's ID: every ID stays unique.
    const ids = [...body.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The ID prefix applies to them too.
    const prefixed = parse(
      renderManualHtml(manualOf(), { ...options, idPrefix: 'doc-' }).html,
    );
    expect($(prefixed, '#doc-charging > h2').id).toBe('doc-_h-charging');
  });

  it('gives a module listed twice its ID once', () => {
    const manual = manualOf();
    const twice = {
      ...manual,
      entries: [
        ...manual.entries,
        manual.entries[1] as ResolvedManual['entries'][number],
      ],
    };
    const body = parse(renderManualHtml(twice, options).html);
    expect(body.querySelectorAll('[id="of-charging"]')).toHaveLength(1);
    // Its heading's ID too: only the first one's heading has it.
    expect(body.querySelectorAll('[id="of-_h-charging"]')).toHaveLength(1);
    expect(body.querySelectorAll('h2.of-module__title[id]')).toHaveLength(1);
    expect(body.querySelectorAll('section.of-module')).toHaveLength(3);
  });

  it('takes options: an ID prefix, a heading level, no table of contents', () => {
    const { html } = renderManualHtml(manualOf(), {
      ...options,
      idPrefix: 'doc-',
      headingLevel: 3,
      toc: false,
    });
    const body = parse(html);
    expect(body.querySelector('nav')).toBeNull();
    expect($(body, 'h3.of-manual__title').textContent).toBe('Operating manual');
    expect($(body, '#doc-basics--deeper > h6').getAttribute('aria-level')).toBe(
      '7',
    );
    expect($(body, 'a.of-xref').getAttribute('href')).toBe(
      '#doc-basics--lights',
    );
    expect(() =>
      renderManualHtml(manualOf(), { ...options, idPrefix: '"><x' }),
    ).toThrow(HtmlRenderError);
    // A prefix without a trailing "-" or "_" could make an ID a JavaScript identifier.
    expect(() =>
      renderManualHtml(manualOf(), { ...options, idPrefix: 'doc' }),
    ).toThrow(HtmlRenderError);
    expect(() =>
      renderManualHtml(manualOf(), { ...options, headingLevel: 7 }),
    ).toThrow(HtmlRenderError);
  });

  it('asks linkHref where a link leads, only for an address that may be linked', () => {
    const asked: string[] = [];
    const linked = structuredClone(manualOf());
    const charging = linked.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    charging.blocks.push({
      type: 'paragraph',
      id: 'charging--links',
      content: ['own', 'none', 'bad', 'never'].map((name) => ({
        type: 'text',
        text: name,
        marks: [
          {
            type: 'link',
            href:
              name === 'never' ? 'javascript:1' : `https://a.example/${name}`,
          },
        ],
      })),
    });
    const { html } = renderManualHtml(linked, {
      ...options,
      linkHref: (href) => {
        asked.push(href);
        return href.endsWith('/own')
          ? '/en/own/'
          : href.endsWith('/bad')
            ? 'javascript:1'
            : undefined;
      },
    });
    expect(html).toContain(
      '<a class="of-link" href="/en/own/" rel="noopener noreferrer">own</a>',
    );
    for (const refused of ['none', 'bad', 'never'])
      expect(html).toContain(
        `<span class="of-link of-link--refused">${refused}</span>`,
      );
    expect(asked).not.toContain('javascript:1');
  });

  it('asks xrefHref for links, and refuses unsafe ones', () => {
    const targets: unknown[] = [];
    const body = parse(
      renderManualHtml(manualOf(), {
        ...options,
        xrefHref: (target) => {
          targets.push(target);
          return target.block ? `/manual/${target.id}` : 'javascript:alert(1)';
        },
      }).html,
    );
    expect(targets).toEqual([
      { module: 'basics', block: 'lights', id: 'basics--lights' },
      { module: 'basics', id: 'basics--lights' },
    ]);
    expect($(body, 'a.of-xref').getAttribute('href')).toBe(
      '/manual/basics--lights',
    );
    expect($(body, 'span.of-xref--unresolved').innerHTML).toBe(
      '<em>the basics</em>',
    );
  });

  it('refuses an unresolved manual', () => {
    const manual = structuredClone(manualOf());
    const charging = manual.entries[1] as Extract<
      ResolvedManual['entries'][number],
      { kind: 'module' }
    >;
    charging.blocks.push({ type: 'moduleRef', id: 'x', module: 'basics' });
    expect(() => renderManualHtml(manual, options)).toThrow(
      /expects a resolved manual/,
    );
  });
});

describe('links', () => {
  const linked = (href: string): string =>
    renderManualHtml(
      {
        id: 'm',
        title: 'M',
        lang: 'en',
        variant: {},
        origins: {},
        anchors: {},
        entries: [
          {
            kind: 'module',
            module: 'mod',
            title: 'Mod',
            lang: 'en',
            blocks: [
              {
                type: 'paragraph',
                id: 'p',
                content: [
                  { type: 'text', text: 'x', marks: [{ type: 'link', href }] },
                ],
              },
            ],
          },
        ],
      },
      options,
    ).html;

  it('link only an absolute http, https or mailto address', () => {
    expect(linked('https://example.com/a')).toContain(
      '<a class="of-link" href="https://example.com/a"',
    );
    expect(linked('mailto:a@example.com')).toContain(
      'href="mailto:a@example.com"',
    );
  });

  it('keep the text of any other address, never as a link', () => {
    for (const href of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '/relative',
      '#fragment',
      '//example.com',
    ]) {
      const html = linked(href);
      expect(html, href).not.toContain('<a class="of-link"');
      expect(html, href).toContain(
        '<span class="of-link of-link--refused">x</span>',
      );
    }
  });
});

/**
 * A table past the column cap (#686), its columns behind a proxy counting how many are read:
 * laying out its grid starts with them, walking its blocks never reads one.
 */
function countingWideTable(): { table: Table; reads: () => number } {
  const columns = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => ({
    width: 1,
  }));
  let reads = 0;
  const counted = new Proxy(columns, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    table: {
      type: 'table',
      id: 'wide',
      columns: counted,
      header: false,
      rows: Array.from({ length: 3 }, () => ({
        cells: columns.map(() => ({ blocks: [] })),
      })),
    },
    reads: () => reads,
  };
}

describe('a table past the caps (#686)', () => {
  it('is refused before its grid is laid out', () => {
    const { table, reads } = countingWideTable();
    const manual: ResolvedManual = {
      ...manualOf(),
      entries: [
        {
          kind: 'module',
          module: 'wide',
          title: 'Wide',
          lang: 'en',
          blocks: [table],
        },
      ],
    };
    expect(() => renderManualHtml(manual, options)).toThrow(TableTooLargeError);
    expect(reads()).toBe(0);
  });
});

describe('renderModuleHtml', () => {
  it('renders one module, with links only to what it contains', () => {
    const result = renderModuleHtml(manualOf(), 'charging', options);
    if (!result) throw new Error('no module');
    const body = parse(result.html);
    const root = $(body, 'article.of-content.of-module');
    expect(root.id).toBe('of-charging');
    expect(root.getAttribute('lang')).toBe('en');
    expect($(root, 'h1.of-module__title').textContent).toBe(
      'Charging the battery',
    );
    expect($(root, 'p.of-paragraph').id).toBe('of-charging--intro');
    // The cross-references point at another module, which is not rendered here.
    expect(root.querySelector('a.of-xref')).toBeNull();
    expect(
      [...root.querySelectorAll('span.of-xref--unresolved')].map(
        (s) => s.textContent,
      ),
    ).toEqual(['Status lights', 'the basics']);
    expect(result.assets).toEqual([`sha256:${HASH}`]);
    expect(renderModuleHtml(manualOf(), 'nope', options)).toBeUndefined();
  });

  it('leaves the title out where the host shows it, the rest unchanged', () => {
    const html = (title?: boolean) =>
      renderModuleHtml(manualOf(), 'charging', {
        ...options,
        ...(title !== undefined && { title }),
      })?.html ?? '';
    const heading = $(parse(html()), 'h1.of-module__title').outerHTML;
    expect(html(true)).toBe(html());
    expect(html(false)).toBe(html().replace(heading, ''));
  });
});

describe('a cross-reference to a module that is no entry (#796)', () => {
  const page = (xrefTitles?: Record<string, string>): ResolvedManual => ({
    id: 'one',
    title: 'One',
    lang: 'de',
    variant: {},
    entries: [
      {
        kind: 'module',
        module: 'checking',
        title: 'Den Druck prüfen',
        lang: 'de',
        blocks: [
          {
            type: 'paragraph',
            id: 'checking--p',
            content: [
              { type: 'text', text: 'Die Werte stehen unter ' },
              { type: 'xref', module: 'pressures' },
              { type: 'text', text: ', ' },
              { type: 'xref', module: 'pressures', block: 'table' },
              { type: 'text', text: ' und ' },
              { type: 'xref', module: 'constructor' },
              { type: 'text', text: '.' },
            ],
          },
        ],
      },
    ],
    origins: { 'checking--p': { module: 'checking', block: 'p' } },
    anchors: {},
    ...(xrefTitles ? { xrefTitles } : {}),
  });
  const links = (manual: ResolvedManual) =>
    [
      ...parse(
        renderModuleHtml(manual, 'checking', options)!.html,
      ).querySelectorAll('.of-xref'),
    ].map((x) => x.textContent);

  it('reads as the module\u2019s title the resolution names, else as its ID', () => {
    expect(links(page({ pressures: 'Reifendruckwerte' }))).toEqual([
      'Reifendruckwerte',
      'Reifendruckwerte',
      // Not a property every object has: only the manual's own titles count.
      'constructor',
    ]);
    expect(links(page())).toEqual(['pressures', 'pressures', 'constructor']);
  });
});

describe('every type of the content model has a renderer', () => {
  /** Just enough of a Zod schema's internals to read a discriminated union's members. */
  function members(schema: unknown, key: string): string[] {
    const def = (schema as { _zod: { def: Record<string, unknown> } })._zod.def;
    const union = (
      def['type'] === 'lazy' ? (def['getter'] as () => unknown)() : schema
    ) as { options: { shape: Record<string, { value: string }> }[] };
    return union.options.map((o) => o.shape[key]?.value as string).sort();
  }

  const t = (text: string) => ({ type: 'text' as const, text });
  const p = { type: 'paragraph' as const, id: 'p', content: [t('x')] };

  /** One sample per block type: typed by the model, so a new type fails to compile until it has one. */
  const blocks: { [K in Block['type']]: Extract<Block, { type: K }> } = {
    paragraph: p,
    section: { type: 'section', id: 's', title: [t('S')], blocks: [p] },
    list: {
      type: 'list',
      id: 'l',
      ordered: false,
      items: [{ id: 'i', content: [t('i')], blocks: [] }],
    },
    procedure: {
      type: 'procedure',
      id: 'pr',
      steps: [{ id: 'st', content: [t('s')], blocks: [] }],
    },
    table: {
      type: 'table',
      id: 't',
      columns: [{ width: 1 }],
      header: false,
      rows: [{ cells: [{ blocks: [p] }] }],
    },
    image: { type: 'image', id: 'im', asset: `sha256:${HASH}`, alt: 'a' },
    attachment: {
      type: 'attachment',
      id: 'at',
      asset: `sha256:${HASH}`,
      name: 'n',
      fileName: 'n.zip',
      mediaType: 'application/zip',
      size: 1,
    },
    safety: {
      type: 'safety',
      id: 'sa',
      severity: 'danger',
      hazard: [t('h')],
      symbols: [],
      blocks: [],
    },
    admonition: { type: 'admonition', id: 'a', kind: 'note', blocks: [p] },
    faq: { type: 'faq', id: 'f', question: [t('Q?')], blocks: [p] },
    variant: {
      type: 'variant',
      id: 'v',
      when: { op: 'in', attr: 'model', values: ['x'] },
      blocks: [p],
    },
    moduleRef: { type: 'moduleRef', id: 'm', module: 'other' },
    literal: { type: 'literal', id: 'li', text: 'x' },
    passthrough: { type: 'passthrough', id: 'pt', format: 'xml', raw: '<x/>' },
    pageBreak: { type: 'pageBreak', id: 'pb' },
  };
  /** Block types that only exist before resolving: the renderer refuses them. */
  const unresolved = new Set<string>(['variant', 'moduleRef']);

  const inlines: { [K in Inline['type']]: Extract<Inline, { type: K }> } = {
    text: t('x'),
    attribute: { type: 'attribute', name: 'x' },
    xref: { type: 'xref', module: 'other' },
    kbd: { type: 'kbd', keys: ['A'] },
    calloutRef: { type: 'calloutRef', block: 'img', callout: 'c' },
    hardBreak: { type: 'hardBreak' },
    placeholder: { type: 'placeholder', key: 'title' },
  };
  const marks: { [K in Mark['type']]: Extract<Mark, { type: K }> } = {
    strong: { type: 'strong' },
    emphasis: { type: 'emphasis' },
    code: { type: 'code' },
    sub: { type: 'sub' },
    sup: { type: 'sup' },
    ui: { type: 'ui' },
    link: { type: 'link', href: 'https://example.com' },
    term: { type: 'term', termId: 'x' },
  };

  const manualWith = (list: Block[]): ResolvedManual => ({
    id: 'm',
    title: 'M',
    lang: 'en',
    variant: {},
    entries: [
      { kind: 'module', module: 'mod', title: 'Mod', lang: 'en', blocks: list },
    ],
    origins: {},
    anchors: {},
  });

  it('has a sample for every type in the model’s schemas', () => {
    expect(Object.keys(blocks).sort()).toEqual(members(Block, 'type'));
    expect(Object.keys(inlines).sort()).toEqual(members(Inline, 'type'));
    expect(Object.keys(marks).sort()).toEqual(members(Mark, 'type'));
  });

  it.each(Object.values(blocks))('renders a $type block', (block) => {
    // In the preview, which is where a page break shows.
    const render = () =>
      renderManualHtml(manualWith([block]), { ...options, preview: {} });
    if (unresolved.has(block.type)) {
      expect(render).toThrow(HtmlRenderError);
    } else {
      expect(
        parse(render().html).querySelector(`#of-${block.id}`),
      ).not.toBeNull();
    }
  });

  it.each(Object.values(inlines))('renders a $type node', (node) => {
    const { html } = renderManualHtml(
      manualWith([{ type: 'paragraph', id: 'p', content: [node] }]),
      options,
    );
    expect($(parse(html), '#of-p').innerHTML).not.toBe('');
  });

  it.each(Object.values(marks))('renders a $type mark', (mark) => {
    const { html } = renderManualHtml(
      manualWith([
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: 'x', marks: [mark] }],
        },
      ]),
      options,
    );
    expect($(parse(html), '#of-p').children).toHaveLength(1);
  });

  it('fails loudly on a type it does not know', () => {
    const unknown = { type: 'glossary', id: 'f' } as unknown as Block;
    expect(() => renderManualHtml(manualWith([unknown]), options)).toThrow(
      'no renderer for block type "glossary"',
    );
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters, quotes, NUL and carriage returns', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>\0\r`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;�&#13;',
    );
  });
});

describe('safeUrl', () => {
  it.each([
    'https://example.com/a?b=1#c',
    'HTTP://example.com',
    'mailto:help@example.com',
    '/assets/abc',
    'assets/abc',
    './x',
    '../x',
    '?q=1',
    '#of-a',
    '//example.com/x',
    '/path/with:colon',
  ])('allows %s', (url) => {
    expect(safeUrl(url)).toBe(url);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'javascript\0:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/x',
    'https://example.com/a b',
    '\\\\example.com',
    '\u0001javascript:alert(1)',
    '',
  ])('refuses %j', (url) => {
    expect(safeUrl(url)).toBeUndefined();
  });
});

describe('empty table cells', () => {
  const para = (id: string, text: string) => ({
    type: 'paragraph' as const,
    id,
    content: [{ type: 'text' as const, text }],
  });
  const grid = Module.parse({
    schemaVersion: 1,
    id: 'charging',
    meta: { title: 'Grid', type: 'concept', lang: 'en', audience: 'public' },
    blocks: [
      {
        type: 'table',
        id: 'filled',
        header: true,
        columns: [{ width: 1 }, { width: 1 }],
        rows: [
          { cells: [{ blocks: [para('h', 'Item')] }, { blocks: [] }] },
          { cells: [{ blocks: [para('a', 'Cable')] }, { blocks: [] }] },
        ],
      },
      {
        type: 'table',
        id: 'blank',
        header: false,
        columns: [{ width: 1 }, { width: 1 }],
        rows: [{ cells: [{ blocks: [] }, { blocks: [] }] }],
      },
    ],
  });

  it('render as empty cells, an empty column and an all-empty table included', () => {
    const { manual } = resolveManual({
      manifest: { ...manifest, entries: [{ module: 'charging' }] },
      variant: { model: 'small' },
      lang: 'en',
      config,
      loadModule: () => grid,
    });
    const result = renderModuleHtml(manual, 'charging', options);
    if (!result) throw new Error('no module');
    const tables = parse(result.html).querySelectorAll('table');
    expect(tables).toHaveLength(2);
    const [filled, blank] = [...tables] as HTMLTableElement[];
    expect(
      [...filled!.querySelectorAll('th, td')].map((c) => c.textContent),
    ).toEqual(['Item', '', 'Cable', '']);
    expect([...blank!.querySelectorAll('td')].map((c) => c.innerHTML)).toEqual([
      '',
      '',
    ]);
  });
});
